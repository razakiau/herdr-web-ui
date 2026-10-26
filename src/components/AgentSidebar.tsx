import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bell, BellOff, ChevronDown, ChevronRight, Ellipsis, Pin, PinOff, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneTokenValues } from "../../shared/pane-tokens.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { currentAgentRowTokens, subscribeAgentRowTokens } from "../lib/agentRowTokens.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { agentNow, attentionRank, hostChatNow, type AgentNow } from "../lib/agentNow.ts";
import { sinceOf, type Since } from "../lib/since.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { agentRoster, byAttention, restingSplit, type AgentRow } from "../lib/agentRoster.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { folderName } from "../lib/paneName.ts";
import { matchesQuery } from "../lib/paletteSearch.ts";
import { currentPaneMutes, paneMuteKey, prunePaneMutes, setPaneMutes, subscribePaneMutes, togglePaneMute } from "../lib/paneMutes.ts";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { alignBreath } from "../lib/breath.ts";
import { indicatorGlyph, type StatusIndicators } from "../lib/status.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { machineFilter } from "../lib/sidebarFilter.ts";
import { useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, pruneSidebarPins, setSidebarPins, sidebarPinKey, splitPinnedRows, subscribeSidebarPins, toggleSidebarPin, hostChatPinKey } from "../lib/sidebarPins.ts";
import { chatAge, useMinuteClock, type HostPc } from "../lib/hostChats.ts";
import { agentsListHostChats, hostChatStatus } from "../lib/hostPlacement.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { hostChatItems, useHostChatActions, type HostChatRef } from "./HostChatActions.tsx";
import { BackgroundBadge, displayPaneTitle, onRowContextMenu, PlanBadge, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  /** the kind the mark draws, left off the second line: said for a screen reader, since the mark is aria-hidden */
  markKind: string | null;
  title: string;
  /** the live name other tools address the agent by, when it has one */
  name: string | null;
  context: string;
  /** what herdr plugins report on the pane (`$name` tokens), in the order herdr's rows draw them */
  tokens: readonly string[];
  backgroundTasks?: number;
  plan?: PlanSummary;
  status?: AgentStatus;
  /** why a row the filter did not match is drawn all the same: it is the selected one */
  note?: string | null;
  /** its alerts are off for everyone (lib/paneMutes.ts): said beside the state, as a word for a screen reader */
  muted?: boolean;
  /** the PC the agent runs on, said first on the place line; null with a single PC */
  place?: string | null;
  /** what it is doing now (lib/agentNow.ts), after the place */
  now?: AgentNow | null;
  /** how long it has been in its state (lib/since.ts formatSince), under the state glyph */
  since?: string | null;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, what
 * its plugins report, and how it is doing.
 */
export function AgentRowBody({ mark, markKind, title, name, context, tokens, backgroundTasks, plan, status, note = null, muted = false, place = null, now = null, since = null }: AgentRowBodyProps) {
  const t = useT();
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-main">
        <span className="agent-title-line">
          <span className="agent-title">{title}</span>
        </span>
        {(place || name || context || now) && <span className="agent-context">
          {[
            place ? <span className="agent-pc" key="pc">{place}</span> : null,
            name ? <span className="agent-name" key="name">{name}</span> : null,
            context || null,
            now ? <span className={`agent-now${now.tone === "ask" ? " is-ask" : ""}`} key="now">{now.text}</span> : null,
          ].filter((part) => part !== null).flatMap((part, index) => index === 0 ? [part] : [" · ", part])}
        </span>}
      </span>
      {/* text as the plugin wrote it, never markup; its own line in either row height, cut where it is too long */}
      {tokens.length > 0 && <span className="agent-tokens">{tokens.join(" · ")}</span>}
    </span>
    <span className="agent-row-status">
      {note !== null && <span className="sidebar-filter-note">{note}</span>}<BackgroundBadge count={backgroundTasks} />{now?.tone !== "plain" && <PlanBadge plan={plan} />}
      {muted && <span className="agent-muted" title={t("Alerts muted")} data-testid="alerts-muted"><BellOff aria-hidden="true" /><span className="visually-hidden">{t("Alerts muted")}</span></span>}
    </span>
    {/* drawn at the row's right edge, after its ⋯, as a workspace row's state is (AgentSidebar.css) */}
    <span className={`agent-row-state${since ? " has-since" : ""}`}>
      <StatusBadge status={status} compact />
      {since && <span className={`agent-since${status === "blocked" ? " is-ask" : ""}`}>{since}</span>}
    </span>
  </>;
}

/** The Agents head's summary: how many need you and how many work, leaving out a zero. */
/** The row's time in the user's language: now, 4m, 2h, 3d. */
export function sinceText(since: Since | null, t: Translate): string | null {
  if (since === null) return null;
  if (since.unit === "now") return t("now");
  return since.unit === "m" ? t("{n}m", { n: since.n }) : since.unit === "h" ? t("{n}h", { n: since.n }) : t("{n}d", { n: since.n });
}

export type SummaryPart = { status: "blocked" | "working" | "done"; text: string; count: number };
export function agentsSummary(statuses: readonly (AgentStatus | undefined)[], t: Translate): SummaryPart[] {
  const asking = statuses.filter((status) => status === "blocked").length;
  const working = statuses.filter((status) => status === "working").length;
  // finished and not looked at: the rows' green dot, counted too (owner, ZAC-233)
  const done = statuses.filter((status) => status === "done").length;
  return [
    ...(asking > 0 ? [{ status: "blocked" as const, text: t("{n} waiting on you", { n: asking }), count: asking }] : []),
    ...(working > 0 ? [{ status: "working" as const, text: t("{n} working", { n: working }), count: working }] : []),
    ...(done > 0 ? [{ status: "done" as const, text: t("{n} finished", { n: done }), count: done }] : []),
  ];
}

/**
 * The head's counts, each behind the mark its rows show: the same breathing dot, question mark and
 * green dot, or herdr's glyph under Settings -> Status indicators (owner, ZAC-233: the head's own
 * small dots matched neither). The mark is drawn as the row's, without the row's live region.
 */
export function SummaryMarks({ parts, indicators }: { parts: readonly SummaryPart[]; indicators?: StatusIndicators }) {
  const { settings } = useSettings();
  const style = indicators ?? settings.statusIndicators;
  return <>{parts.map((part) => <span key={part.status} className="agent-summary-part" data-status={part.status} title={part.text}>
    <span className={`badge badge-${part.status} sidebar-status agent-summary-mark`} data-status={part.status} aria-hidden="true">
      {style !== "classic" && <span className="sidebar-status-glyph" onAnimationStart={part.status === "working" ? alignBreath : undefined}>{indicatorGlyph(part.status, style)}</span>}
      {style === "classic" && part.status === "blocked" && <span className="sidebar-status-mark" aria-hidden="true">?</span>}
      {style === "classic" && part.status !== "blocked" && <span className="sidebar-status-dot" aria-hidden="true" onAnimationStart={part.status === "working" ? alignBreath : undefined} />}
    </span>
    <span className="agent-summary-long">{part.text}</span>
    {/* a narrow head keeps the mark and the number; the words stay for a screen reader */}
    <span className="agent-summary-short" aria-hidden="true">{part.count}</span>
  </span>)}</>;
}

/** The host chat a row stands for, and the one the app shows (App.tsx selectedHostChat) */
export interface HostChatTarget { machineId: string; session: string }

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  /** this device only watches: it sees the shared mutes and cannot change them */
  watching?: boolean;
  onSelect(machineId: string, paneId: string): void;
  /** each PC's host chats, for those its bridge has (lib/hostChats.ts) */
  hostChats?: ReadonlyMap<string, HostPc>;
  selectedHostChat?: HostChatTarget | null;
  onSelectHostChat?(target: HostChatTarget): void;
  /** "All agents on <PC>…", one per PC with host chats: the section head's ⋯ */
  allAgents?: RowMenuItem[];
  /** the head's trailing control: the sidebar's search (MachineSidebar.tsx) */
  headAction?: ReactNode;
  /** drawn as the sidebar's Agents lens (MachineSidebar.tsx): no fold of its own, its rows under Needs you / Working / Finished */
  lens?: boolean;
}

/**
 * The row whose menu is open, by its pin key: at its ⋯, or at the pointer for a right-click. What
 * the menu says of the row is read from the row at each render, so a value that changes while it is
 * open changes in it too.
 */
interface PinMenu { key: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; host?: HostChatRef }
/** a host chat in the Agents list: a Copilot agent while it works, asks, is unread or pinned */
interface ChatRow { machine: Machine; chat: HostChatRow; entry?: undefined }
type ListRow = (AgentRow & { chat?: undefined }) | ChatRow;
/** this device's choice to show the resting rows (AgentSidebar restingSplit) */
const RESTING_KEY = "ovis:agents-resting-open";

/** The Agents lens's headings, by attention rank (lib/agentNow.ts attentionRank); a rank-3 row shows only while selected. */
function groupLabel(rank: number, t: Translate): string {
  return rank === 0 ? t("Needs you") : rank === 1 ? t("Working") : rank === 2 ? t("Finished") : t("Selected");
}

/** Rows in byAttention order cut into runs of one rank, each under its heading. */
function attentionGroups<T>(rows: readonly T[], status: (row: T) => AgentStatus | undefined): { rank: number; rows: T[] }[] {
  const groups: { rank: number; rows: T[] }[] = [];
  for (const row of rows) {
    const rank = attentionRank(status(row));
    const last = groups.at(-1);
    if (last?.rank === rank) last.rows.push(row); else groups.push({ rank, rows: [row] });
  }
  return groups;
}
const rowPinKey = (row: ListRow): string => row.chat ? hostChatPinKey(row.machine.id, row.chat.session) : sidebarPinKey(row.machine.id, row.entry.pane.pane_id);

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 * The pinned agents stand first, in a card; on a desktop only a
 * right-click (or the context-menu key) opens the menu. A row's ⋯, or a right-click on it, opens its
 * menu, which pins or unpins it, and mutes or unmutes its alerts for every browser and device.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, watching = false, onSelect, hostChats, selectedHostChat = null, onSelectHostChat, allAgents = [], headAction = null, lens = false }: AgentSidebarProps) {
  const [allMenu, setAllMenu] = useState<HTMLElement | null>(null);
  const t = useT();
  const listId = useId();
  // open on every screen: the list leads the sidebar, a phone's drawer too (owner, 2026-10-25)
  const [collapsed, setCollapsed] = useState(false);
  const { settings } = useSettings();
  // shared with the other browsers of this server (lib/preferencesSync.ts)
  const pinned = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  // the panes whose alerts are off, shared the same way; null on a server that keeps no such list, which then offers no mute
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  // which `$name` tokens herdr's own sidebar draws, from this server's herdr config (server/herdr-sidebar.ts)
  const rowTokens = useSyncExternalStore(subscribeAgentRowTokens, currentAgentRowTokens, currentAgentRowTokens);
  // a host chat's row menu has the chat's own actions too (HostChatActions.tsx)
  const hostActions = useHostChatActions();
  const activity = useSidebarActivity();
  const now = useMinuteClock();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes);
  // the pinned rows stand first, in the order they were pinned (lib/agentRoster.ts)
  const byActivity = settings.agentOrder === "activity";
  const herdrRoster = useMemo(() => agentRoster(machines, { byActivity, seqs: activity.seqs, pinned }), [machines, byActivity, activity, pinned]);
  // each PC's host chats follow its herdr agents: the ones working, asking, unread or pinned
  const chatRows = useMemo(() => machines.flatMap((machine): ChatRow[] => {
    const chats = hostChats?.get(machine.id)?.chats ?? [];
    return agentsListHostChats(chats, (session) => pinned.includes(hostChatPinKey(machine.id, session))).map((chat): ChatRow => ({ machine, chat }));
  }), [machines, hostChats, pinned]);
  // what needs you first, then what works, then an unread finish, then the rest (lib/agentRoster.ts byAttention);
  // a host chat's "asks" needs you, and an unread one reads as a finish
  const shown = (row: ListRow): AgentStatus | undefined => row.chat
    ? row.chat.status === "asks" ? "blocked" : row.chat.status === "working" ? "working" : row.chat.unread ? "done" : "idle"
    : row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined;
  const roster = useMemo((): { pinned: ListRow[]; rest: ListRow[] } => {
    if (chatRows.length === 0) return { pinned: herdrRoster.pinned, rest: byAttention<ListRow>(herdrRoster.rest, shown) };
    // the pinned rows of both kinds stand first, in the order they were pinned
    const chats = splitPinnedRows(chatRows, pinned, rowPinKey);
    const order = new Map(pinned.map((key, index) => [key, index]));
    const pinnedRows: ListRow[] = [...herdrRoster.pinned, ...chats.pinned].sort((a, b) => (order.get(rowPinKey(a)) ?? 0) - (order.get(rowPinKey(b)) ?? 0));
    return { pinned: pinnedRows, rest: byAttention<ListRow>([...herdrRoster.rest, ...chats.rest], shown) };
  }, [herdrRoster, chatRows, pinned, activity]);
  const allRows = useMemo(() => [...roster.pinned, ...roster.rest], [roster]);
  // the sidebar's filter (lib/sidebarFilter.ts) keeps the matched rows and the selected one, in the same
  // order and cards; the pins and their pruning go on reading every row
  const { filter } = useSidebarFilter();
  const split = useMemo(() => {
    if (!filter.active) return roster;
    // a host chat stays when its title or folder matches, or while it is the one shown
    const kept = (row: ListRow): boolean => row.chat
      ? (selectedHostChat?.machineId === row.machine.id && selectedHostChat.session === row.chat.session) || [row.chat.title, row.chat.cwd ?? ""].some((label) => label !== "" && matchesQuery(filter.query, label))
      : machineFilter(filter, row.machine.id)?.panes.has(row.entry.pane.pane_id) === true;
    return { pinned: roster.pinned.filter(kept), rest: roster.rest.filter(kept) };
  }, [roster, filter, selectedHostChat]);
  const rows = useMemo(() => [...split.pinned, ...split.rest], [split]);
  // many agents (the owner, 2026-10-25): idle and read rows fold into "N resting", and past 8 asking or working
  // ones the rest wait behind "Show all" (lib/agentRoster.ts restingSplit); a search shows every row it keeps
  const [showAll, setShowAll] = useState(false);
  const [restingOpen, setRestingOpen] = useState(() => { try { return localStorage.getItem(RESTING_KEY) === "1"; } catch { return false; } });
  const setResting = (open: boolean): void => {
    setRestingOpen(open);
    try { localStorage.setItem(RESTING_KEY, open ? "1" : "0"); } catch { /* storage denied: for the page */ }
  };
  const restingId = useId();
  const fold = useMemo(() => filter.active
    ? { shown: split.rest, resting: [] as ListRow[], hidden: 0 }
    : restingSplit(split.rest, shown, (row) => row.chat
      ? selectedHostChat?.machineId === row.machine.id && selectedHostChat.session === row.chat.session
      : row.machine.id === selectedMachineId && row.entry.pane.pane_id === selectedPaneId, showAll),
  [split, filter.active, showAll, selectedHostChat, selectedMachineId, selectedPaneId, activity]);
  // a folded list (a phone's starts so) opens while the filter keeps rows in it, so a match or the selection is
  // seen, not only kept; its caret then folds and opens it for the filter's time, the list's own fold untouched
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const folded = filter.active ? filterFold ?? (collapsed && rows.length === 0) : collapsed;
  const togglePin = (key: string): void => {
    // pins of panes gone from this server leave with a change of the user's, never by themselves: the
    // list is shared, and a pane this page has not seen yet (a PC still loading) is not gone
    const live = new Set(allRows.flatMap((row) => row.entry ? [sidebarPinKey(row.machine.id, row.entry.pane.pane_id)] : []));
    setSidebarPins(toggleSidebarPin(pruneSidebarPins(pinned, live, machines), key));
  };
  const toggleMute = (machineId: string, paneId: string): void => {
    // as the pins: the mutes of panes a connected PC no longer has leave with this change, and no other PC's
    if (muted !== null) setPaneMutes(togglePaneMute(prunePaneMutes(muted, machines), paneMuteKey(machineId, paneId)));
  };
  // a pin moves the row to the other list, so React draws it anew: the control of the row that had
  // the focus (its row or its ⋯) gets it back
  const sectionRef = useRef<HTMLElement>(null);
  const refocusPin = useRef<{ key: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocusPin.current;
    if (target === null) return;
    refocusPin.current = null;
    sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-item[data-pin-key="${CSS.escape(target.key)}"] .${target.control}`)?.focus({ preventScroll: true });
  }, [pinned]);
  const [menu, setMenu] = useState<PinMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuRow = menu === null ? undefined : rows.find((row) => row.machine.state !== "disconnected" && row.machine.state !== "error" && rowPinKey(row) === menu.key);
  // a row that left the list or whose PC stopped connecting takes its menu with it; a retry keeps it
  useEffect(() => {
    if (menu && (menuRow === undefined || !menu.anchor.isConnected)) setMenu(null);
  }, [menu, menuRow]);
  // herdr names a PC only beside another: the rows' line does the same
  const machineName = (machine: Machine): string | null => machines.length > 1 ? machine.name : null;

  const listItem = (row: ListRow) => row.chat ? chatItem(row) : agentItem(row);

  // what a host chat's row says: a Copilot agent, its title, where it works and when it changed
  const describeChat = ({ machine, chat }: ChatRow) => {
    const title = chat.title.trim() || t("Copilot chat");
    const context = [chat.cwd ? folderName(chat.cwd) : null, chat.status === "error" ? t("Error") : null, chatAge(chat, now, t)].filter(Boolean).join(" · ");
    const place = machineName(machine);
    return { title, place, context, tokens: [] as string[], subtitle: [place, context].filter(Boolean).join(" · ") };
  };

  const chatItem = (row: ChatRow) => {
    const { machine, chat } = row;
    const selected = selectedHostChat?.machineId === machine.id && selectedHostChat.session === chat.session;
    const { title, place, context, subtitle } = describeChat(row);
    const pinKey = hostChatPinKey(machine.id, chat.session);
    const menuOpen = menu?.key === pinKey;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus, host: { machineId: machine.id, chat } });
    return <li className={`agent-item host-chat-item${selected ? " is-selected" : ""}`} key={pinKey} data-machine={machine.id} data-host-session={chat.session} data-pin-key={pinKey}
      onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
      onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
      <button type="button" className="agent-select agent-row" aria-current={selected ? "true" : undefined} title={[title, subtitle, chat.cwd].filter(Boolean).join("\n")} onClick={() => onSelectHostChat?.({ machineId: machine.id, session: chat.session })}>
        <AgentRowBody mark="copilot" markKind="Copilot" title={title} name={null} place={place} context={context} tokens={[]} status={hostChatStatus(chat)} now={hostChatNow(chat, t)} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
    </li>;
  };

  // what a row says of its agent, for the row and for its open menu
  const describe = ({ machine, entry }: AgentRow) => {
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const online = machine.state === "connected";
    const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
    const name = agent?.name?.trim() || null;
    // the name has its own place on the line: the label beside it says the kind instead
    const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const mark = paneMark(entry);
    const markAgent = mark && hasAgentMark(mark) ? mark : null;
    // the PC has its own place at the head of the line (AgentRowBody place)
    const place = machineName(machine);
    const parts = { agentLabel: kindLabel, title, markAgent, machineName: null, workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    const contextParts = agentContext(parts);
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    // a PC that is away says nothing of its agents now, its plugins' words included
    const tokens = online ? paneTokenValues(rowTokens, entry.canonicalAgent, pane.tokens ?? agent?.tokens) : [];
    return { online, title, name, mark, place, context, markKind, tokens, subtitle: [place, context].filter(Boolean).join(" · ") };
  };

  const agentItem = (row: AgentRow) => {
    const { machine, entry } = row;
    const { pane, agent } = entry;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    // under the filter a row it did not match is there for the selection: drawn as context, and said so
    const filterContext = filter.active && machineFilter(filter, machine.id)?.matchedPanes.has(pane.pane_id) !== true;
    const { online, title, name, mark, place, context, markKind, tokens, subtitle } = describe(row);
    const status = online ? activity.status(machine.id, pane) : undefined;
    // the time belongs to herdr's state; a glyph the device reads otherwise (a finish already seen) gets none
    const since = online && status === pane.agent_status ? sinceText(sinceOf(pane.status_since, now), t) : null;
    // the row cuts a long value: the tooltip, and a phone's menu sheet, say each in full
    const tooltip = [...new Set([pane.pane_id, title, subtitle, since ? t("For {time}", { time: since }) : null, ...tokens, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const menuOpen = menu?.key === pinKey;
    // one menu for the ⋯ and a right-click, which opens it at the pointer and leaves the focus where it was
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus });
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}${filterContext ? " is-filter-context" : ""}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} data-pin-key={pinKey}
      onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
      onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}
        draggable={online}
        // dropped on the pane area, the row opens its pane in half of it (lib/split.ts)
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId: machine.id, paneId: pane.pane_id }));
        }}>
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} place={place} context={context} tokens={tokens} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} status={status}
          now={online ? agentNow(pane, status, t) : null} since={since} note={filterContext && selected ? t("Selected") : null} muted={muted?.includes(paneMuteKey(machine.id, pane.pane_id)) === true} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
    </li>;
  };

  // no PCs yet (the roster is still on its way), or a connected PC whose panes have not come in: not "none running"
  const loading = machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null);
  // the empty list's line is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  // under the filter an empty list is the filter's doing, which the list above says once (MachineSidebar.tsx)
  const shownEmpty = useAnnouncedText(rows.length === 0 && !filter.active ? (loading ? t("Loading agents…") : t("No agents running")) : null);
  const menuPinned = menu !== null && pinned.includes(menu.key);
  const menuShown = menuRow === undefined ? null : menuRow.chat ? describeChat(menuRow) : describe(menuRow);
  // a herdr row's pane; a host chat has its own alert switches in its menu (HostChatActions.tsx)
  const menuPane = menuRow?.entry ? { machineId: menuRow.machine.id, paneId: menuRow.entry.pane.pane_id } : null;
  const menuMuted = menuPane !== null && muted !== null && muted.includes(paneMuteKey(menuPane.machineId, menuPane.paneId));
  const runPin = (state: PinMenu): void => {
    // where the menu hands the focus back (lib RowMenu): the ⋯ itself unless the right-click said otherwise
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    const control = back?.closest(`.agent-item[data-pin-key="${CSS.escape(state.key)}"]`) ? back.classList.contains("row-menu-toggle") ? "row-menu-toggle" : "agent-select" : null;
    if (control) refocusPin.current = { key: state.key, control };
    togglePin(state.key);
  };
  // what needs you and what works, said at the head whether the list is open or folded
  const summary = agentsSummary(allRows.map(shown), t);
  // Settings -> Sidebar rows -> One line: an agent row is one line too, its place dim after its title
  const oneLine = settings.sidebarRows === "one";
  return <section ref={sectionRef} className={`agents-sidebar${lens ? " is-lens" : ""}${folded ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}${oneLine ? " is-one-line" : ""}`} aria-label={t("Agents")}>
    <div className="agent-section-head">
      {lens ? <h2 className="visually-hidden">{t("Agents")}</h2> : <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!folded} aria-controls={listId} onClick={() => { if (filter.active) setFilterFold(!folded); else setCollapsed(!collapsed); }}>
        {folded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
        <span>{t("Agents")}</span>
        {/* the count is of the agents running, filter or not */}
        {folded && allRows.length > 0 && <span className="agent-section-count">{allRows.length}</span>}
      </button>}
      {summary.length > 0 && <span className="agent-section-summary">
        <SummaryMarks parts={summary} />
      </span>}
      {headAction}
      {allAgents.length > 0 && <button type="button" className="sidebar-row-action agent-section-more" aria-label={t("More for {title}", { title: t("Agents") })} aria-haspopup="menu" aria-expanded={allMenu !== null} onClick={(event) => setAllMenu(allMenu ? null : event.currentTarget)}><Ellipsis aria-hidden="true" /></button>}
    </div>
    {allMenu && <RowMenu anchor={allMenu} title={t("Agents")} items={allAgents} onClose={() => setAllMenu(null)} />}
    <div className="agent-list-contents" id={listId} hidden={folded}>
      <p className={shownEmpty === null ? "visually-hidden" : "agent-empty"} role="status">{shownEmpty}</p>
      {rows.length > 0 && <>
        {split.pinned.length > 0 && <>
          <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
          <ul className="agent-list agent-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{split.pinned.map(listItem)}</ul>
        </>}
        {fold.shown.length > 0 && (lens
          ? attentionGroups(fold.shown, shown).map((group) => <div key={group.rank} className="agent-group" data-rank={group.rank}>
            <p className="agent-group-label" aria-hidden="true">{groupLabel(group.rank, t)}</p>
            <ul className="agent-list" aria-label={groupLabel(group.rank, t)}>{group.rows.map(listItem)}</ul>
          </div>)
          : <ul className="agent-list">{fold.shown.map(listItem)}</ul>)}
        {fold.hidden > 0 && <button type="button" className="agent-more" onClick={() => setShowAll(true)}>{t("Show all ({n} more)", { n: fold.hidden })}</button>}
        {fold.resting.length > 0 && <>
          <button type="button" className="agent-more agent-resting-toggle" aria-expanded={restingOpen} aria-controls={restingId} onClick={() => setResting(!restingOpen)}>
            {restingOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{t("{n} resting", { n: fold.resting.length })}
          </button>
          <ul className="agent-list agent-list-resting" id={restingId} hidden={!restingOpen}>{restingOpen && fold.resting.map(listItem)}</ul>
        </>}
      </>}
    </div>
    {menu && menuShown && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menuShown.title} subtitle={menuShown.subtitle} detail={menuShown.tokens.join(" · ") || undefined} onClose={closeMenu} items={menu.host && hostActions
      // the pin keeps this list's own toggle, which hands the focus back to the moved row
      ? hostChatItems(hostActions, menu.host, t).map((item) => item.id === "pin" || item.id === "unpin" ? { ...item, run: () => runPin(menu) } : item)
      : [
      menuPinned
        ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => runPin(menu) }
        : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => runPin(menu) },
      // one switch for every alert channel and every browser (lib/paneMutes.ts); a watching device sees its state and cannot flip it
      ...(muted === null || menuPane === null ? [] : [{
        id: "mute", label: menuMuted ? t("Unmute alerts") : t("Mute alerts"), icon: menuMuted ? Bell : BellOff, checked: menuMuted, disabled: watching,
        run: () => toggleMute(menuPane.machineId, menuPane.paneId),
      }]),
    ]} />}
  </section>;
}
