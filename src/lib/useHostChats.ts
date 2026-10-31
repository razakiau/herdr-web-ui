import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { HostChatTarget } from "../components/AgentSidebar.tsx";
import type { AllAgentsOn } from "../components/MachineSidebar.tsx";
import type { HostChatActions, HostChatRef } from "../components/HostChatActions.tsx";
import type { Settings } from "./settings.ts";
import type { Translate } from "./i18n.ts";
import type { AppLink } from "./deepLink.ts";
import type { PaneView } from "./actions.ts";
import { errorText, hostChatRoster, openHostChatClosed, readsOnView, useHostChatPcs, type HostPc } from "./hostChats.ts";
import { hostChatDroplets, showDroplet } from "./droplet.ts";
import { hostChatHome, pcPlacement, samePath } from "./hostPlacement.ts";
import { closeTab, closeWorkspace, moveTab, currentHostWorkspaces, firstHostTab, isTabOpen, openTab, setHostWorkspaces, subscribeHostWorkspaces, tabAfterClose, upkeepPc } from "./hostWorkspaces.ts";
import { currentSidebarPins, hostChatPinKey, pinnedHostFolders, setSidebarPins, subscribeSidebarPins, toggleSidebarPin } from "./sidebarPins.ts";
import { lastViewedPane } from "./lastViewedPane.ts";
import { hostChatFromSearch } from "./notificationTarget.ts";
import { digestFromSearch, weekDigest } from "./weekDigest.ts";
import { groupsView } from "./groups.ts";

/** How a host chat is picked (App.tsx selectHostChat): "tab" makes it a tab of its agent host workspace for good. */
export type HostChatPick = (target: HostChatTarget, how?: "tab" | "look", cwd?: string | null) => void;

/**
 * The pick of an agent host chat (lib/hostChats.ts), shown in the pane's place on its PC, and what the
 * pick resets: its read title, the folder a chat just made was started in. The tab refs are set where
 * the PCs' chats are read (useHostChats).
 */
export function useHostChatSelection({ selectTarget, setSelectedHostChat }: {
  selectTarget: (machineId: string, paneId: string | null, view?: PaneView) => void;
  setSelectedHostChat: Dispatch<SetStateAction<HostChatTarget | null>>;
}) {
  // set where the PCs' chats are read (useHostChats): selectHostChat and the actions reach them through these
  const keepHostTabRef = useRef<(target: HostChatTarget, cwd?: string | null) => void>(() => undefined);
  const closeHostTabRef = useRef<(machineId: string, session: string) => void>(() => undefined);
  // the open host chat's title as its reads give it (a chat just made is not on its PC's list yet)
  const [hostReadTitle, setHostReadTitle] = useState<string | null>(null);
  // the folder a chat just made from "+" was started in, until its PC's list has the chat
  const [hostMadeIn, setHostMadeIn] = useState<string | null>(null);
  // the PC whose "All agents on <PC>…" is open: the sidebar's ⋯ and a Copilot folder's header ⋯ open it
  const [allAgentsOn, setAllAgentsOn] = useState<AllAgentsOn | null>(null);
  // a host chat takes the pane's place on its PC; the chat screen draws it
  // `how`: "tab" makes it a tab of its agent host workspace for good (a new chat, a fork, a pick
  // from a strip); "look" (Agents, All agents, an alert) shows it without saving anything, unless it
  // is a tab already. A look's tab stands only while it is on screen (lib/hostWorkspaces.ts).
  const selectHostChat = useCallback<HostChatPick>((target, how = "look", cwd) => {
    selectTarget(target.machineId, null);
    setSelectedHostChat(target);
    setHostReadTitle(null);
    setHostMadeIn(null);
    if (how === "tab") keepHostTabRef.current(target, cwd);
  }, [selectTarget]);
  const selectHostChatRef = useRef(selectHostChat); selectHostChatRef.current = selectHostChat;
  // an address naming a chat (an ntfy alert's link, a tapped alert's cold start) opens it once,
  // then leaves the address: the chat is not a place the address keeps (lib/deepLink.ts)
  // The weekly digest's link (`?digest=<week>`, ZAC-262) opens its "This week" page the same way.
  useEffect(() => {
    const linked = hostChatFromSearch(window.location.search);
    const digest = digestFromSearch(window.location.search);
    if (!linked && !digest) return;
    if (linked) selectHostChat({ machineId: linked.machine_id, session: linked.session });
    if (digest) weekDigest.open(digest);
    const query = new URLSearchParams(window.location.search);
    query.delete("chat");
    query.delete("digest");
    const rest = query.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { keepHostTabRef, closeHostTabRef, hostReadTitle, setHostReadTitle, hostMadeIn, setHostMadeIn, allAgentsOn, setAllAgentsOn, selectHostChat, selectHostChatRef };
}

export interface HostChatsParams {
  t: Translate;
  settings: Settings;
  machines: Machine[];
  machinesRef: RefObject<Machine[]>;
  alertsRef: RefObject<AlertPrefs>;
  alertInAppRef: RefObject<boolean>;
  drawerOpenRef: RefObject<boolean>;
  snapshot: Machine["snapshot"];
  selectedMachine: Machine | undefined;
  selectedMachineId: string;
  selectedPaneId: string | null;
  selectedPane: HerdrPane | null;
  pendingLink: RefObject<AppLink | null>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  selectedHostChat: HostChatTarget | null;
  setSelectedHostChat: Dispatch<SetStateAction<HostChatTarget | null>>;
  selectedHostChatRef: RefObject<HostChatTarget | null>;
  keepHostTabRef: RefObject<(target: HostChatTarget, cwd?: string | null) => void>;
  closeHostTabRef: RefObject<(machineId: string, session: string) => void>;
  selectHostChat: HostChatPick;
  selectHostChatRef: RefObject<HostChatPick>;
}

/**
 * Each PC's agent host chats (lib/hostChats.ts), read once for the sidebar, the tab strips and the
 * header: their in-app alerts, their open workspaces and tabs (lib/hostWorkspaces.ts), their own
 * actions (components/HostChatActions.tsx), and where the chat on screen stands (lib/hostPlacement.ts).
 */
export function useHostChats({ t, settings, machines, machinesRef, alertsRef, alertInAppRef, drawerOpenRef, snapshot, selectedMachine, selectedMachineId, selectedPaneId, selectedPane, pendingLink, setAutoSelected, selectedHostChat, setSelectedHostChat, selectedHostChatRef, keepHostTabRef, closeHostTabRef, selectHostChat, selectHostChatRef }: HostChatsParams) {
  // each PC's host chats (lib/hostChats.ts), read once for the sidebar and the tab strip
  // none while Settings hides agent host chats (Agent host): herdr as it is without them
  const { pcs: hostChats, tracker: hostTracker } = useHostChatPcs(hostChatRoster(machines, settings.hostChatsShown));
  // In-app alerts for host chats (lib/droplet.ts hostChatDroplets), as dropIn gives panes: the
  // server's ntfy and device alerts stay quiet while the app is in use, so this is what says it
  const hostSeen = useRef(new Map<string, HostPc>());
  const hostTurns = useRef(new Map<string, Map<string, number>>());
  useEffect(() => {
    const seen = hostSeen.current;
    for (const [machineId, pc] of hostChats) {
      const before = seen.get(machineId);
      if (before === pc) continue;
      seen.set(machineId, pc);
      const turns = hostTurns.current.get(machineId) ?? new Map<string, number>();
      hostTurns.current.set(machineId, turns);
      const news = hostChatDroplets(before?.chats, pc.chats, turns, alertsRef.current, Date.now());
      if (!alertInAppRef.current || document.visibilityState !== "visible") continue;
      const open = selectedHostChatRef.current;
      for (const item of news) {
        if (open?.machineId === machineId && open.session === item.session && !drawerOpenRef.current) continue;
        showDroplet({
          machineId,
          paneId: "",
          session: item.session,
          agent: "copilot",
          title: item.title,
          machine: machinesRef.current.length > 1 ? machinesRef.current.find((m) => m.id === machineId)?.name ?? null : null,
          kind: item.kind,
        });
      }
    }
    for (const machineId of [...seen.keys()]) if (!hostChats.has(machineId)) { seen.delete(machineId); hostTurns.current.delete(machineId); }
  }, [hostChats]);
  const hostPins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  // the agent host workspaces open per PC, and their tabs (lib/hostWorkspaces.ts)
  const hostWorkspaces = useSyncExternalStore(subscribeHostWorkspaces, currentHostWorkspaces, currentHostWorkspaces);
  // a chat made a tab for good: its row's folder, else the one it was made in
  keepHostTabRef.current = (target, cwd) => {
    const folder = hostChats.get(target.machineId)?.chats.find((chat) => chat.session === target.session)?.cwd ?? cwd ?? null;
    if (folder === null) return;
    const state = currentHostWorkspaces();
    const next = openTab(state[target.machineId] ?? { open: [] }, { session: target.session, cwd: folder });
    if (next !== state[target.machineId]) setHostWorkspaces({ ...state, [target.machineId]: next });
  };
  // a tab closed: hidden, never archived. The one on screen gives way to its neighbour, else to the
  // PC's first pane, as a closed pane's tab does
  closeHostTabRef.current = (machineId, session) => {
    const state = currentHostWorkspaces();
    const pc = state[machineId];
    if (!pc) return;
    const shown = selectedHostChatRef.current;
    if (shown?.machineId === machineId && shown.session === session) {
      const next = tabAfterClose(pc, session);
      if (next !== null) selectHostChat({ machineId, session: next }, "tab");
      else { setSelectedHostChat(null); setAutoSelected(true); }
    }
    setHostWorkspaces({ ...state, [machineId]: closeTab(pc, session) });
  };
  // an agent host workspace closed: its row and tabs go, its chats stay as they are. The chat on
  // screen in it gives way to the PC's first pane, as a closed workspace's pane does
  const closeHostWorkspace = (machineId: string, cwd: string): void => {
    const state = currentHostWorkspaces();
    const pc = state[machineId];
    const shown = selectedHostChatRef.current;
    const row = shown?.machineId === machineId ? hostChats.get(machineId)?.chats.find((chat) => chat.session === shown.session) : undefined;
    if (row?.cwd && samePath(row.cwd) === samePath(cwd)) { setSelectedHostChat(null); setAutoSelected(true); }
    if (pc) setHostWorkspaces({ ...state, [machineId]: closeWorkspace(pc, cwd) });
  };
  // a host chat's own actions (components/HostChatActions.tsx), for its tab, its rows and the header
  const [hostRename, setHostRename] = useState<HostChatRef | null>(null);
  const [hostDelete, setHostDelete] = useState<HostChatRef | null>(null);
  const [hostNotice, setHostNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!hostNotice) return;
    const timer = window.setTimeout(() => setHostNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [hostNotice]);
  const hostActions = useMemo((): HostChatActions => {
    // the row shows the change at once (HostPcs); a refusal puts it back, and says so here
    const said = (what: string) => (cause: unknown): void => setHostNotice(t("{what} failed: {reason}", { what, reason: errorText(cause) }));
    return {
      pinned: (machineId, session) => hostPins.includes(hostChatPinKey(machineId, session)),
      togglePin: (machineId, session) => setSidebarPins(toggleSidebarPin(currentSidebarPins(), hostChatPinKey(machineId, session))),
      askRename: (target) => setHostRename(target),
      rename: (machineId, session, title) => { void hostTracker.rename(machineId, session, title).catch(said(t("Rename"))); },
      setRead: (machineId, session, read) => { void hostTracker.setRead(machineId, session, read).catch(said(t(read ? "Mark as read" : "Mark as unread"))); },
      // Mark as done also closes the tab, once the host took it (a refusal leaves both)
      setArchived: (machineId, session, archived) => {
        void hostTracker.setArchived(machineId, session, archived).then(() => { if (archived) closeHostTabRef.current(machineId, session); }, said(t(archived ? "Mark as done" : "Restore")));
      },
      askDelete: (target) => setHostDelete(target),
      isTab: (machineId, session) => isTabOpen(hostWorkspaces[machineId], session),
      closeTab: (machineId, session) => closeHostTabRef.current(machineId, session),
      moveTab: (machineId, shown, session, boundary) => {
        const state = currentHostWorkspaces();
        const pc = state[machineId];
        const next = pc ? moveTab(pc, shown, session, boundary) : pc;
        if (pc && next !== pc) setHostWorkspaces({ ...state, [machineId]: next! });
      },
      asking: hostRename !== null || hostDelete !== null,
      // chat groups (ZAC-265): the item shows only with the switch on
      ...(settings.chatGroups ? { addToGroup: (machineId: string, session: string) => groupsView.openAddTo({ pc: machineId, session }) } : {}),
    };
  }, [hostTracker, hostPins, t, hostRename, hostDelete, hostWorkspaces, settings.chatGroups]);
  // the open chat marked done (archived chats are not placed) or deleted, here or on the PC: it is
  // let go as a closed pane is, and the PC's first pane is opened in its place. Only that change
  // does it: a chat just made (not listed yet) or opened from Archived stays open
  const openHostRow = selectedHostChat ? hostChats.get(selectedHostChat.machineId)?.chats.find((chat) => chat.session === selectedHostChat.session) : undefined;
  const openHostKey = selectedHostChat ? `${selectedHostChat.machineId}\n${selectedHostChat.session}` : null;
  // a host restarting, a PC dropping or a failed read is not a close (openHostChatClosed)
  const openHostLive = selectedHostChat ? !openHostChatClosed(hostChats.get(selectedHostChat.machineId), selectedHostChat.session) : false;
  // the chat on screen is read, as in VS Code: on opening it, and when its turn ends while shown
  // (readsOnView); a chat marked unread while open stays so
  const openHostSeen = useRef<{ key: string | null; row: HostChatRow | undefined }>({ key: null, row: undefined });
  useEffect(() => {
    const key = selectedHostChat && selectedPane === null ? `${selectedHostChat.machineId}\n${selectedHostChat.session}` : null;
    const was = openHostSeen.current.key === key ? openHostSeen.current.row : undefined;
    // a chat not listed yet has not been seen: its first row is its opening
    openHostSeen.current = { key, row: openHostRow ?? (openHostSeen.current.key === key ? openHostSeen.current.row : undefined) };
    if (key === null || openHostRow === undefined || !readsOnView(was, openHostRow)) return;
    void hostTracker.setRead(selectedHostChat!.machineId, selectedHostChat!.session, true).catch(() => undefined);
  }, [openHostRow, selectedHostChat, selectedPane, hostTracker]);
  const openHostWas = useRef<{ key: string | null; live: boolean }>({ key: null, live: false });
  useEffect(() => {
    const was = openHostWas.current;
    openHostWas.current = { key: openHostKey, live: openHostLive };
    if (openHostKey === null || was.key !== openHostKey || !was.live || openHostLive) return;
    // as Close tab: the tab beside it takes its place, so marking a chat done keeps its workspace on
    // screen (the host's list says archived before the action's answer closes the tab)
    const shown = selectedHostChatRef.current;
    const pc = shown ? currentHostWorkspaces()[shown.machineId] : undefined;
    const next = shown && pc ? tabAfterClose(pc, shown.session) : null;
    if (shown && next !== null) { selectHostChat({ machineId: shown.machineId, session: next }, "tab"); return; }
    setSelectedHostChat(null);
    setAutoSelected(true);
  }, [openHostKey, openHostLive]);
  // each PC's open agent host workspaces kept up with its list (lib/hostWorkspaces.ts upkeepPc):
  // seeded the first time it is seen, its gone chats' tabs dropped; only a live list counts
  useEffect(() => {
    let next = currentHostWorkspaces();
    for (const [machineId, pc] of hostChats) {
      const onScreen = selectedHostChat?.machineId === machineId ? selectedHostChat.session : null;
      next = upkeepPc(next, machineId, pc, new Set(pinnedHostFolders(hostPins, machineId)), onScreen, settings.hostAutoOpen);
    }
    setHostWorkspaces(next);
  }, [hostChats, hostPins, selectedHostChat, settings.hostAutoOpen]);
  // a PC with no herdr pane opens its first agent host workspace's first tab, as a PC with panes
  // opens its first pane: the page is never left empty while a workspace is open
  const firstTab = settings.hostChatsShown ? firstHostTab(hostWorkspaces[selectedMachineId]) : null;
  useEffect(() => {
    if (firstTab === null || !snapshot || selectedMachine?.state !== "connected" || snapshot.panes.length > 0) return;
    if (selectedPaneId !== null || selectedHostChat !== null || pendingLink.current?.machine === selectedMachineId) return;
    selectHostChatRef.current({ machineId: selectedMachineId, session: firstTab }, "tab");
  }, [firstTab, snapshot, selectedMachine?.state, selectedPaneId, selectedHostChat, selectedMachineId]);
  // a host chat on screen goes when Settings hides them
  useEffect(() => { if (!settings.hostChatsShown) setSelectedHostChat(null); }, [settings.hostChatsShown]);
  // where the selected PC's host chats stand (lib/hostPlacement.ts): the open tabs, and the one on screen
  const hostPlacement = useMemo(() => pcPlacement(snapshot, hostChats.get(selectedMachineId)?.chats ?? [], hostWorkspaces[selectedMachineId],
    selectedHostChat?.machineId === selectedMachineId ? selectedHostChat.session : null), [snapshot, hostChats, hostWorkspaces, selectedMachineId, selectedHostChat]);
  // the chat on screen is a look: shown, its tab saved nowhere
  const hostLook = selectedHostChat !== null && !isTabOpen(hostWorkspaces[selectedHostChat.machineId], selectedHostChat.session);
  const hostHome = selectedHostChat !== null && selectedHostChat.machineId === selectedMachineId ? hostChatHome(hostPlacement, selectedHostChat.session) : null;
  // a host chat open in a workspace: that workspace's strip, with none of its panes' tabs open
  const hostWorkspace = hostHome && "workspace" in hostHome ? snapshot?.workspaces.find((workspace) => workspace.workspace_id === hostHome.workspace) ?? null : null;
  const hostWorkspacePane = hostWorkspace ? (() => {
    const own = snapshot?.panes.filter((pane) => pane.workspace_id === hostWorkspace.workspace_id) ?? [];
    const remembered = lastViewedPane("workspace", selectedMachineId, hostWorkspace.workspace_id);
    return own.find((pane) => pane.pane_id === remembered) ?? own[0] ?? null;
  })() : null;
  const hostFolder = hostHome && "folder" in hostHome ? hostPlacement.folders.find((group) => group.cwd === hostHome.folder) ?? null : null;
  return { hostChats, hostTracker, hostPins, hostWorkspaces, closeHostWorkspace, hostRename, setHostRename, hostDelete, setHostDelete, hostNotice, hostActions, openHostRow, hostPlacement, hostLook, hostWorkspace, hostWorkspacePane, hostFolder };
}
