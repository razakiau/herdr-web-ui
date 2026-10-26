import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Copy, Download, Ellipsis, FoldVertical, ListTree, MessageSquarePlus, Monitor, Pin, PinOff, Plus, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import type { Machine, MachineState, MachineUpdate } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import { AgentSidebar, type HostChatTarget } from "./AgentSidebar.tsx";
import { currentSidebarPins, subscribeSidebarPins, pinnedHostFolders, setSidebarPins, toggleHostFolderPin } from "../lib/sidebarPins.ts";
import { basename, type HostPc } from "../lib/hostChats.ts";
import { agentListCount } from "../lib/agentRoster.ts";
import { currentHostWorkspaces, subscribeHostWorkspaces } from "../lib/hostWorkspaces.ts";
import { foldPc, foldPcs, keptPcs, openPc, pcPlacement, samePath, searchPlace, type PcLists } from "../lib/hostPlacement.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { AllAgentsSheet } from "./AllAgentsSheet.tsx";
import { OtherPcsFold, type PcActivity } from "./OtherPcsFold.tsx";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterSuggestions, machineFilter, sidebarFilter, type SidebarBranchLabels } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider, useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import "./Machines.css";
import { useT, type Translate } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText, saysHerdrAway } from "../lib/userError.ts";
import { copyText } from "../lib/clipboard.ts";

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone, every other state also writes its word under the name. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

interface Props {
  machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; actions: AppActions;
  /** App's live counters per PC and finishes looked at here; both sidebar lists draw from it */
  activity: SidebarActivity;
  watching?: boolean;
  /** a phone's drawer is out: closing it clears the filter */
  drawerOpen?: boolean;
  onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void;
  /** "New agent host chat…": the "+" dialog with Agent host picked, in the folder given */
  onNewHostChat?(machineId: string, cwd: string | null): void; onSetup(machine: Machine, update?: boolean): void;
  /** the host chat the app shows instead of a pane, and the pick of one (App.tsx) */
  selectedHostChat?: HostChatTarget | null;
  onSelectHostChat?(target: HostChatTarget): void;
  /** each PC's host chats, for the PCs whose bridge has them (lib/hostChats.ts useHostChats, read in App.tsx) */
  hostChats?: ReadonlyMap<string, HostPc>;
  /** the PC whose "All agents on <PC>…" is open (with `folder`, "Chats in <folder>…"), held by the app so the header's ⋯ opens it too; this sidebar keeps its own without them */
  allAgentsOn?: AllAgentsOn | null;
  onAllAgents?(on: AllAgentsOn | null): void;
  /** an agent host workspace closed (its ⋯ or the header's); the app moves off it when it is on screen */
  onCloseHostWorkspace?(machineId: string, cwd: string): void;
}

const NO_HOST_CHATS: ReadonlyMap<string, HostPc> = new Map();

/** Which list of a PC's host chats is open: the whole PC's, or with `folder`, that folder's. */
export interface AllAgentsOn { machineId: string; folder?: string }

/** What works and what asks on a PC: its agents' panes and its host chats. */
function pcActivity(machine: Machine, pc: HostPc | undefined, activity: SidebarActivity): PcActivity {
  const statuses = machine.state === "connected" ? (machine.snapshot?.panes ?? []).map((pane) => activity.status(machine.id, pane)) : [];
  const chats = (pc?.chats ?? []).filter((chat) => !chat.archived);
  return {
    working: statuses.filter((status) => status === "working").length + chats.filter((chat) => chat.status === "working").length,
    asking: statuses.filter((status) => status === "blocked").length + chats.filter((chat) => chat.status === "asks").length,
  };
}
/**
 * An agent host workspace's menu (a folder of the PC's agent host chats, AHP: no herdr workspace):
 * its sidebar row's ⋯, and the header's while one of its chats is open. Only what is about the
 * folder: New agent host chat… there, Chats in <folder>… (its chats, archived ones too), Pin, Close
 * workspace (as herdr's; it also unpins, and leaves every chat as it is), and Copy path. The PC's
 * whole list stays on the PC's and Agents' menus. A herdr workspace keeps its own menu, whatever
 * chats are tabs of it.
 */
export function hostFolderItems({ canStart, cwd, noFolder = false, pin, onNewHostChat, onFolderChats, onClose, onCopyPath }: {
  canStart: boolean; cwd: string; noFolder?: boolean; pin?: { pinned: boolean; toggle(): void }; onNewHostChat(): void; onFolderChats(): void; onClose(): void; onCopyPath?(cwd: string): void;
}, t: Translate): RowMenuItem[] {
  // the No folder row's folder is the host's scratch parent: no chat to start there, no path worth copying
  return [
    ...(canStart && !noFolder ? [{ id: "new-host-chat", label: t("New agent host chat…"), icon: MessageSquarePlus, run: onNewHostChat }] : []),
    { id: "folder-chats", label: t("Chats in {folder}…", { folder: noFolder ? t("No folder") : basename(cwd) }), icon: ListTree, run: onFolderChats },
    ...(pin ? [pin.pinned
      ? { id: "unpin-folder", label: t("Unpin folder"), icon: PinOff, run: pin.toggle }
      : { id: "pin-folder", label: t("Pin folder"), icon: Pin, run: pin.toggle }] : []),
    { id: "close-workspace", label: t("Close workspace"), icon: X, run: () => { if (pin?.pinned) pin.toggle(); onClose(); } },
    ...(noFolder ? [] : [{ id: "copy-path", label: t("Copy path"), icon: Copy, divider: true, run: () => (onCopyPath ?? copyPath)(cwd) }]),
  ];
}
const copyPath = (cwd: string): void => { void copyText(cwd); };
/** The folders a PC's chats work in, as pins compare them: a folder pin stays while one is left, archived or not. */
export const hostChatFolders = (chats: readonly { cwd: string | null }[]): Set<string> => new Set(chats.flatMap((chat) => chat.cwd ? [samePath(chat.cwd)] : []));

export function MachineSidebar(props: Props) {
  const t = useT();
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const activity = props.activity;
  // the filter's query lives here and nowhere else: not in storage, not in the address, not past this
  // mount (lib/sidebarFilter.ts). The branch each roster row says comes up from the rosters, which read it.
  const [query, setQuery] = useState("");
  // the field shows only once the magnifier opens it (owner, 2026-10-25): no standing filter row
  const [searching, setSearching] = useState(false);
  const filterId = useId();
  const suggestionsId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const [branchLabels, setBranchLabels] = useState<SidebarBranchLabels>(() => new Map());
  const reportBranches = useCallback((machineId: string, branches: ReadonlyMap<string, string>) => setBranchLabels((current) => {
    const before = current.get(machineId);
    if (before !== undefined && before.size === branches.size && [...branches].every(([id, branch]) => before.get(id) === branch)) return current;
    if (before === undefined && branches.size === 0) return current;
    const next = new Map(current);
    if (branches.size === 0) next.delete(machineId); else next.set(machineId, branches);
    return next;
  }), []);
  const filter = useMemo(() => sidebarFilter(query, props.machines, { machineId: props.selectedMachineId, paneId: props.selectedPaneId }, t, branchLabels), [query, props.machines, props.selectedMachineId, props.selectedPaneId, t, branchLabels]);
  const filterView = useMemo(() => ({ filter, reportBranches }), [filter, reportBranches]);
  // the field offers the labels the rows show, as the browser's own suggestions: nothing typed is kept
  const suggestions = useMemo(() => filterSuggestions(props.machines, branchLabels), [props.machines, branchLabels]);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const openSearch = () => setSearching(true);
  // the cross clears the words and keeps the field; on an empty field it closes the search, the focus back on the magnifier
  // the magnifier is only drawn while the search is closed, so its focus waits for the commit that draws it again
  const refocusToggle = useRef(false);
  const closeSearch = () => { setQuery(""); setSearching(false); refocusToggle.current = true; };
  useEffect(() => { if (!searching && refocusToggle.current) { refocusToggle.current = false; searchToggle.current?.focus(); } }, [searching]);
  const clearOrClose = () => { if (query === "") closeSearch(); else { setQuery(""); filterInput.current?.focus(); } };
  useEffect(() => { if (searching) filterInput.current?.focus(); }, [searching]);
  // Escape in the field clears its words; in an empty field it closes the search, and the drawer stays
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (query !== "") setQuery(""); else closeSearch();
  };
  const drawerOpen = props.drawerOpen === true;
  useEffect(() => { if (!drawerOpen) { setQuery(""); setSearching(false); } }, [drawerOpen]);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  // a PC whose roster has not come was not searched: the line says the answer is only of the PCs that answered
  const unanswered = props.machines.some((machine) => machine.snapshot === null);
  const noMatchWords = useAnnouncedText(filter.active && filter.matches === 0 && props.machines.length > 0 ? `${t(unanswered ? "No workspaces or agents match on the PCs that answered" : "No workspaces or agents match")}\n${t("Try other words, or clear the filter.")}` : null);
  const hostChats = props.hostChats ?? NO_HOST_CHATS;
  // the PC whose "All agents on <PC>…" is open
  const [ownAllOn, setOwnAllOn] = useState<AllAgentsOn | null>(null);
  const [pcsFolded, setPcsFolded] = useState(false);
  // one list, two lenses (owner, ZAC-233 option B): what the agents do, or the PCs' places; kept per device.
  // A search looks through both, and the lens is back once it closes
  const [lens, setLensState] = useState<SidebarLens>(storedLens);
  const setLens = (next: SidebarLens): void => {
    setLensState(next);
    try { localStorage.setItem(LENS_KEY, next); } catch { /* storage denied: for the page */ }
  };
  const showAgents = searching || lens === "agents";
  const showPcs = searching || lens === "pcs";
  const allOn = props.onAllAgents ? props.allAgentsOn ?? null : ownAllOn;
  const setAllOn = props.onAllAgents ?? setOwnAllOn;
  // the PCs placed by hand on this device (lib/hostPlacement.ts foldPcs): kept open from "Other PCs",
  // or folded from a PC's header; the current PC and the active ones are open without being kept
  const [lists, setLists] = useState<PcLists>(storedLists);
  const saveLists = (next: PcLists): void => {
    setLists(next);
    try {
      localStorage.setItem(KEPT_KEY, JSON.stringify(next.keptOpen));
      localStorage.setItem(FOLDED_KEY, JSON.stringify(next.keptFolded));
    } catch { /* storage denied: they last for the page */ }
  };
  const pcOf = (id: string): Machine => props.machines.find((machine) => machine.id === id)!;
  const active = (id: string): boolean => { const each = pcActivity(pcOf(id), hostChats.get(id), activity); return each.working + each.asking > 0; };
  const roster = props.machines.map((machine) => machine.id);
  const prefs = { active, keptOpen: keptPcs(lists.keptOpen, roster), keptFolded: keptPcs(lists.keptFolded, roster) };
  const fold = foldPcs(props.machines, props.selectedMachineId, prefs);
  // under the search every PC is a group of its own, a folded one saying where it otherwise lives
  const { open: openPcs, folded } = filter.active ? { open: props.machines, folded: [] } : fold;
  const foldedIds = new Set(fold.folded.map((machine) => machine.id));
  // foldPcs folds nothing with one or two PCs: there is nowhere to put one back to
  const foldable = props.machines.length > 2;
  // the Agents tab says how many rows its list holds, like the PCs tab (owner, ZAC-233: the asking count is the Needs you facet's)
  const listPins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const agentCount = agentListCount(props.machines, hostChats, listPins);
  const allPc = allOn !== null ? hostChats.get(allOn.machineId) : undefined;
  const allMachine = props.machines.find((machine) => machine.id === allOn?.machineId);
  // no top bar: a workspace starts from its PC's header, and Add PC lives in Settings → Remote PCs. The
  // filter above the lists is a row of the same grid, one field and its clear, never taller than a row.
  return <SidebarActivityProvider value={activity}><SidebarFilterProvider value={filterView}><div className="sidebar-shell">
    {searching && <div className="sidebar-filter" role="search" aria-label={t("Filter workspaces and agents")}>
      <label className="sidebar-filter-label" htmlFor={filterId}><Search aria-hidden="true" /><span className="visually-hidden">{t("Filter")}</span></label>
      <input ref={filterInput} id={filterId} className="input sidebar-filter-input" type="search" value={query} aria-label={t("Filter workspaces and agents")} placeholder={t("Workspaces and agents")} list={suggestionsId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} onKeyDown={onFilterKeyDown} />
      <datalist id={suggestionsId}>{suggestions.map((label) => <option key={label} value={label} />)}</datalist>
      <button type="button" className="sidebar-filter-clear" aria-label={query === "" ? t("Close search") : t("Clear filter")} title={query === "" ? t("Close search") : t("Clear filter")} onClick={clearOrClose}><X aria-hidden="true" /></button>
    </div>}
    {!searching && <div className="sidebar-lens-row">
      <div className="sidebar-lens" role="tablist" aria-label={t("Sidebar view")}>
        <button type="button" role="tab" className="sidebar-lens-tab" aria-selected={lens === "agents"} onClick={() => setLens("agents")}>
          {t("Agents")}<span className="sidebar-lens-count">{agentCount}</span>
        </button>
        <button type="button" role="tab" className="sidebar-lens-tab" aria-selected={lens === "pcs"} onClick={() => setLens("pcs")}>
          {t("PCs")}<span className="sidebar-lens-count">{props.machines.length}</span>
        </button>
      </div>
      <button ref={searchToggle} type="button" className="sidebar-row-action sidebar-search-toggle" aria-label={t("Search workspaces and agents")} title={t("Search workspaces and agents")} onClick={openSearch}><Search aria-hidden="true" /></button>
    </div>}
    {/* one scroll: the lens's list, or both under a search */}
    <div className="sidebar-scroll">
      {showAgents && <AgentSidebar lens machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect}
        hostChats={hostChats} selectedHostChat={props.selectedHostChat} onSelectHostChat={props.onSelectHostChat} />}
      <div className="machine-list" aria-label={t("PCs and workspaces")} hidden={!showPcs}>
        {/* the PCs fold as the Agents above them do (owner, ZAC-233), for this page */}
        {searching && <h2 className="sidebar-pcs-head"><button type="button" className="sidebar-section-label agent-section-toggle" aria-expanded={!pcsFolded} onClick={() => setPcsFolded(!pcsFolded)}>
          {pcsFolded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
          <span>{t("PCs")}</span>
          {pcsFolded && <span className="agent-section-count">{props.machines.length}</span>}
        </button></h2>}
        <p className={noMatchWords === null ? "visually-hidden" : "tree-state sidebar-filter-empty"} role="status">{noMatchWords}</p>
        {!pcsFolded && openPcs.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} hostChats={hostChats.get(machine.id)} onNewHostChat={(cwd) => props.onNewHostChat?.(machine.id, cwd)} onFolderChats={(cwd) => setAllOn({ machineId: machine.id, folder: cwd })}
          // "All agents on <PC>…" is the PC's own (owner, ZAC-233: the Agents head's ⋯ gave way to its facets)
          onAllAgents={hostChats.has(machine.id) ? () => setAllOn({ machineId: machine.id }) : undefined}
          searchNote={filter.active ? searchPlace(foldedIds.has(machine.id), t) : null}
          // the PC in use stays open while it is; any other can be folded, even one that asks (Other PCs then says so)
          onPutBack={foldable && machine.id !== props.selectedMachineId && !foldedIds.has(machine.id) ? () => saveLists(foldPc(lists, machine.id)) : undefined} />)}
        {!pcsFolded && folded.length > 0 && <OtherPcsFold machines={folded} activity={(machine) => pcActivity(machine, hostChats.get(machine.id), activity)} stateWord={(machine) => t(STATE_WORD[machine.state])} onPick={(id) => saveLists(openPc(lists, id))} />}
        <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
      </div>
    </div>
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" /></button>
        <UsageMeters />
      </div>
    </footer>
    {allOn !== null && allPc && allMachine && <AllAgentsSheet key={allOn.folder ?? ""} machineId={allOn.machineId} machineName={allMachine.name} pc={allPc} folder={allOn.folder}
      selected={props.selectedHostChat?.machineId === allOn.machineId ? props.selectedHostChat.session : null} onClose={() => setAllOn(null)}
      // the chat opens as a look (App.tsx); on a phone the drawer goes as a pick's does
      onOpen={(session) => { setAllOn(null); props.onSelectHostChat?.({ machineId: allOn.machineId, session }); }} />}
  </div></SidebarFilterProvider></SidebarActivityProvider>;
}

const KEPT_KEY = "ovis:pcs-kept-open";
const LENS_KEY = "ovis:sidebar-lens";
export type SidebarLens = "agents" | "pcs";
function storedLens(): SidebarLens {
  try { return localStorage.getItem(LENS_KEY) === "pcs" ? "pcs" : "agents"; } catch { return "agents"; }
}
const FOLDED_KEY = "ovis:pcs-kept-folded";

function storedIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  } catch { return []; }
}

function storedLists(): PcLists {
  return { keptOpen: storedIds(KEPT_KEY), keptFolded: storedIds(FOLDED_KEY) };
}

/** `onPutBack`: folds the PC into "Other PCs" again; absent where it would stay open anyway */
function MachineGroup({ machine, hostChats, onNewHostChat, onFolderChats, onAllAgents, onPutBack, searchNote = null, ...props }: Omit<Props, "hostChats" | "onAllAgents"> & { machine: Machine; hostChats: HostPc | undefined; onNewHostChat(cwd: string | null): void; onFolderChats(cwd: string): void; onAllAgents?: (() => void) | undefined; onPutBack?: (() => void) | undefined; searchNote?: string | null }) {
  const t = useT();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const hostWorkspaces = useSyncExternalStore(subscribeHostWorkspaces, currentHostWorkspaces, currentHostWorkspaces);
  const openSession = props.selectedHostChat?.machineId === machine.id ? props.selectedHostChat.session : null;
  // a PC whose bridge has host chats: the open ones stand as tabs of its workspaces, or of its open
  // agent host workspaces (lib/hostPlacement.ts)
  const pinnedFolders = pinnedHostFolders(pins, machine.id);
  const placement = hostChats ? pcPlacement(machine.snapshot, hostChats.chats, hostWorkspaces[machine.id], openSession) : null;
  // a host that is not up cannot make a chat: the sheet's list says what it needs
  const canStart = hostChats?.host?.state === "connected";
  const hostItems = (cwd: string, noFolder = false): RowMenuItem[] => hostFolderItems({
    canStart, cwd, noFolder, onNewHostChat: () => onNewHostChat(cwd), onFolderChats: () => onFolderChats(cwd),
    onClose: () => props.onCloseHostWorkspace?.(machine.id, cwd),
    pin: hostChats ? { pinned: pinnedFolders.includes(samePath(cwd)), toggle: () => setSidebarPins(toggleHostFolderPin(currentSidebarPins(), machine.id, cwd, hostChatFolders(hostChats.chats))) } : undefined,
  }, t);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`ovis:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // a PC that waits on the user, or is updating, shows its notice in the state line's place
  const noticed = Boolean(machine.action_required || machine.updating);
  // the state line under the name is a live region in the group from its first render, kept through the
  // notice (clipped and empty while it shows): its word lands a frame after the line (lib/useAnnouncedText.ts),
  // and every later state change, or the notice clearing, at once
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
  // the Host's herdr is away (the server's words name the socket it tried): the step to take is on
  // that PC, not in this browser, so it follows the words
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch. The method in flight is
  // kept so only a removal marks Remove PC busy (Machines.css dims that one less)
  const [busy, setBusy] = useState<string | null>(null);
  // the state disables the buttons; the ref refuses a second click that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(method);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (leaving) props.onSelect(machine.id, leaving.pane); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  // the filter (lib/sidebarFilter.ts): a PC with nothing kept is hidden, its roster still mounted so the
  // branches it reads stay findable; a folded PC with a match or the selection in it is shown open, its saved
  // fold untouched; a PC kept for the selection alone is drawn as context
  const { filter } = useSidebarFilter();
  const filtered = machineFilter(filter, machine.id);
  // while a filter is on, the caret folds and opens the PC for the filter's time only: the saved fold is
  // written by an unfiltered list alone, and comes back as it was when the query is cleared
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const hidden = filtered !== null && !filtered.shown;
  const matched = filtered !== null && (filtered.matched || filtered.matchedWorkspaces.size > 0 || filtered.matchedPanes.size > 0);
  const kept = filtered !== null && (matched || filtered.workspaces.size > 0 || filtered.panes.size > 0);
  const folded = filtered === null ? collapsed : filterFold ?? (collapsed && !kept);
  const context = filtered !== null && !matched;
  const toggle = () => {
    if (filtered !== null) { setFilterFold(!folded); return; }
    setCollapsed(!collapsed);
    try { localStorage.setItem(`ovis:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const headItems: RowMenuItem[] = [
    ...(onAllAgents ? [{ id: "all-agents", label: t("All agents on {pc}…", { pc: machine.name }), icon: ListTree, run: onAllAgents }] : []),
    ...(onPutBack ? [{ id: "put-back", label: t("Move to Other PCs"), icon: FoldVertical, run: onPutBack }] : []),
    ...(machine.kind === "ssh" ? [{ id: "manage", label: t("Manage PC"), icon: SlidersHorizontal, checked: editing, run: () => { setEditing(!editing); setConfirmDelete(false); } }] : []),
  ];
  // the PC's name is the head of its workspaces and their fold; its ⋯ holds the rest, its + makes a workspace
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}${online ? "" : " is-offline"}${context ? " is-filter-context" : ""}`} hidden={hidden} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      {/* the name row is the PC's fold (the owner, 2026-10-25: four icons beside it cut its name on a phone);
          the caret takes the monitor's place */}
      <button type="button" className="machine-title machine-toggle" aria-expanded={!folded} title={folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} onClick={toggle}>
        <span className="sidebar-mark machine-caret" aria-hidden="true">{folded ? <ChevronRight /> : <ChevronDown />}</span>
        {/* the computer's icon after the fold's caret: what the row is, at a glance (owner, ZAC-233) */}
        <span className="machine-icon" aria-hidden="true"><Monitor /></span>
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        {searchNote && <span className="machine-kind machine-search-place" title={searchNote}>{searchNote}</span>}
        <span className={`machine-dot is-${machine.action_required === "setup" ? "setup" : machine.state}`} title={machine.action_required === "setup" ? t("Setup needed") : t(STATE_WORD[machine.state])} aria-hidden="true" />
      </button>
      {/* the rest in words, in one menu: Manage opens its panel under the head, as its button did */}
      {headItems.length > 0 && <button type="button" className="sidebar-row-action row-menu-toggle machine-menu" aria-label={t("More for {title}", { title: machine.name })} aria-haspopup="menu" aria-expanded={menuAnchor !== null} onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}><Ellipsis aria-hidden="true" /></button>}
      <button className="sidebar-row-action machine-new" disabled={!online} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>
    {menuAnchor && <RowMenu anchor={menuAnchor} title={machine.name} items={headItems} onClose={() => setMenuAnchor(null)} />}
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role="status" title={noticed || machine.error === null ? undefined : machineErrorText(machine.error, t)}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{machineErrorText(machine.error, t)}</span>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {editing && <div className="machine-controls">
      {machine.herdr_profile_id ? <p className="field-hint">{t("Managed by herdr. Rename, disable or remove it there.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit" disabled={busy !== null}>{t("Rename")}</button></form>}
      {/* The first removal click only arms the action; the second is destructive. */}
      <div className="machine-control-buttons">
        {!machine.herdr_profile_id && <button className="btn" disabled={busy !== null} onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{t(machine.enabled ? "Disconnect" : "Connect")}</button>}
        {!["setup", "connect"].includes(machine.action_required ?? "") && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine)}>{t("Reconnect / setup")}</button>}
        {machine.action_required !== "connect" && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine, true)}>{t("Update bridge…")}</button>}
        {!machine.herdr_profile_id && <button className="btn btn-danger" disabled={busy !== null} aria-busy={busy === "DELETE" || undefined} onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{t(confirmDelete ? "Confirm remove PC" : "Remove PC")}</button>}
      </div>
      {confirmDelete && <p className="field-hint">{t("Removes this registration. Remote sessions keep running.")}</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {/* under a filter a folded PC's roster is mounted, hidden, so the branches it reads can be found */}
    {(!folded || filtered !== null) && <div className={online ? "" : "machine-offline"} inert={!online} hidden={folded}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} watching={props.watching}
        hostChats={placement ? { placement, selected: openSession, onSelect: (session) => props.onSelectHostChat?.({ machineId: machine.id, session }), folderMenu: (cwd, noFolder) => hostItems(cwd, noFolder), pinnedFolders } : undefined} /></MachineContext.Provider>}
    </div>}
  </section>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating) {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t("Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  if (machine.action_required === "connect") return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text"><strong>{t("Saved in herdr")}</strong><span>{t("Connect once to enable automatic reconnection. Installation and startup need separate approval.")}</span></p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Connect")}</button>
  </div>;
  // another app's bridge runs on this PC: neither an update from here nor an approval fixes that,
  // so it is named as what it is, with the server's reason and a plain reconnect
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  const update = machine.action_required === "update_bridge";
  return <div className={`machine-action${update ? "" : " is-setup"}`} role={update ? "alert" : "status"}>
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of Ovis. Update it to reconnect; herdr sessions keep running." : "Browser access uses a bridge on this PC. Review any installation or startup changes before connecting.")}</span>
      {/* the two generic reasons only repeat the sentence above */}
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      {/* a PC saved in herdr that has not connected yet is refused a direct update: its dialog connects first */}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up web access")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  // a PC that cannot be updated right now would hold this line open for good: it can be closed,
  // and the PC's own row in the sidebar keeps saying what it needs
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const kept = keepDismissed(dismissed, machines);
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [machines, dismissed]);
  const running = machines.find((machine) => machine.updating);
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t("Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = waitingMachines(machines, dismissed);
  const first = waiting[0];
  if (!first) return null;
  const conflict = first.action_required === "bridge_conflict";
  const update = first.action_required === "update_bridge";
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  return <div className="update-notice" role="status">
    <span>{t(conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{t(conflict ? "Reconnect" : update ? "Update bridge" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}
