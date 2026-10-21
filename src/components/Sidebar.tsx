import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type AnimationEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, GitBranch, Layers, ListChecks, Pencil, Pin, PinOff, Plus, Terminal, Trash2, TriangleAlert, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, PlanSummary, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { indicatorGlyph, knownStatus, rollupStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { WorkspaceFavicon } from "./WorkspaceFavicon.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeDialog, type WorktreeDialogMode } from "./WorktreeDialog.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, shortPathTitle, stripPaneChrome, taskRowLines } from "../lib/paneName.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { watchTouchReorder } from "../lib/touchReorder.ts";
import { placeBlock, workspaceMoves, worktreeGroups as groupWorktrees } from "../lib/workspaceOrder.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";
import { lastViewedPane, rememberViewedPane } from "../lib/lastViewedPane.ts";
import { paneMark, sidebarAgents, workspaceAgentLabels } from "../lib/sidebarAgents.ts";
import { hostChatStatus, samePath, type HostPlacement } from "../lib/hostPlacement.ts";
import { currentHostWorkspaces, folderKey, folderTree, mergedKeys, mergedOrder, moveBlock, moveInMerged, setHostWorkspaces, subscribeHostWorkspaces, withOrder, workspaceKey, type TreeRow } from "../lib/hostWorkspaces.ts";
import { basename } from "../lib/hostChats.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { currentSidebarPins, hostFolderPinKey, isWorkspacePinKey, pinnedGroupIds, pinnedRowKeys, pinnedWorkspaceIds, pruneWorkspacePins, reorderPinnedRows, setSidebarPins, splitPinnedGroups, subscribeSidebarPins, toggleSidebarPin, workspacePinKey, type WorkspaceGroup } from "../lib/sidebarPins.ts";

const ERROR_NOTE_MS = 5000;

/** a repository's header row (only its worktrees' folders are open): its id while it moves, which no folder or workspace id looks like */
const repoRowId = (cwd: string): string => `r:${cwd}`;
const worktreeCollapsedKey = (machineId: string, repoKey: string) => `herdr-web-ui:worktree-group-collapsed:${machineId}:${repoKey}`;
function storedWorktreeCollapsed(machineId: string, repoKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const key of repoKeys) if (localStorage.getItem(worktreeCollapsedKey(machineId, key)) === "1") collapsed.add(key);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/**
 * The title an alert names a pane by: as a row's, with the folder Codex adds after its thread
 * kept. A notification is read away from the row that says where the pane is.
 */
export function alertPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent, true)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): a warning in the status cell, its reason on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  const label = t("NOT RESTORED");
  return (
    <span className="badge badge-restore-error sidebar-status" data-status="restore-error" role="status" aria-label={label} title={`${label} — ${reason}`}>
      <TriangleAlert aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** Every breathing dot or glyph keeps the document clock's phase, so a row that starts working breathes in step with the rest. */
function alignBreath(event: AnimationEvent<HTMLSpanElement>) {
  if (event.animationName !== "sidebar-breathe") return;
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}

export function StatusBadge({ status, compact = false }: { status?: AgentStatus; compact?: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const value = knownStatus(status);
  const label = t(STATUS_WORD[value]);
  const description = value === "waiting" ? t("Agent waiting on background work") : t("Agent {status}", { status: label });
  // classic (the default): a compact cell draws only the states that ask for a look: a red question
  // mark while the agent waits for an answer, a green dot once it has finished and was not looked
  // at, a working-coloured dot that breathes while it runs, a working-coloured ring held still while
  // its turn waits on background work. Ready and unknown keep the cell, its label and its tooltip.
  // Dots or Symbols: herdr's TUI glyph for every state, in herdr's color (lib/status.ts, Sidebar.css)
  const indicators = settings.statusIndicators;
  const dot = value === "working" || value === "done" || value === "waiting";
  return (
    <span
      className={`badge badge-${value}${compact ? " sidebar-status" : ""}`}
      data-status={value}
      role={compact ? "status" : undefined}
      aria-label={compact ? description : undefined}
      title={description}
    >
      {compact && indicators !== "classic" && <span className="sidebar-status-glyph" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined}>{indicatorGlyph(value, indicators)}</span>}
      {compact && indicators === "classic" && value === "blocked" && <span className="sidebar-status-mark" aria-hidden="true">?</span>}
      {compact && indicators === "classic" && dot && <span className="sidebar-status-dot" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined} />}
      <span className={compact ? "visually-hidden" : undefined}>{label}</span>
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A quiet count beside the state,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="background-count" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

/** How far the pane's plan has got: a count beside the state word, quiet once every step is done. */
export function PlanBadge({ plan }: { plan?: PlanSummary }) {
  const t = useT();
  if (!plan || plan.total <= 0) return null;
  const label = t("Plan: {done} of {total} done", { done: plan.done, total: plan.total });
  return (
    <span className={`plan-count${plan.done === plan.total ? " is-done" : ""}`} title={plan.current ? `${label} · ${plan.current}` : label} aria-label={label} data-testid="plan-progress">
      <ListChecks aria-hidden="true" />{plan.done}/{plan.total}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

interface InlineError {
  workspaceId?: string;
  message: string;
  detail: string | null;
}

/**
 * A workspace right-click opens herdr's workspace menu at the pointer without moving focus.
 * Dismissal restores the prior input. A name editor keeps the browser's paste menu.
 * A finger's long press is left alone: it picks a workspace row up to be moved (lib/touchReorder.ts),
 * and the ⋯ is always there on touch. A desktop draws no ⋯ (Sidebar.css): the row itself anchors the menu.
 */
export function onRowContextMenu(event: MouseEvent<HTMLElement>, toggle: (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null) => void): void {
  if ((event.target as HTMLElement).closest("input")) return;
  // Chrome and Safari say what pressed; Firefox does not, so there the device's main pointer decides
  const pointer = (event.nativeEvent as PointerEvent).pointerType;
  if (pointer ? pointer === "touch" : window.matchMedia("(pointer: coarse)").matches) return;
  const toggleButton = event.currentTarget.querySelector<HTMLElement>(".row-menu-toggle");
  if (!toggleButton) return;
  const anchor = toggleButton.getClientRects().length > 0 ? toggleButton : event.currentTarget;
  event.preventDefault();
  const box = anchor.getBoundingClientRect();
  toggle(anchor, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom }, document.activeElement instanceof HTMLElement ? document.activeElement : null);
}

/** The row whose ⋯ menu is open: a workspace, seen through the pane its row shows. */
interface MenuState { anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; workspace: WorkspaceInfo; title: string; place: string }
interface ConfirmState { title: string; body: string; action?: string; run: () => Promise<void>; escalation?: { label: string; code: string; run: () => Promise<void> } }

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  actions: AppActions;
  /**
   * This PC's host chats (lib/hostPlacement.ts): a workspace's count in its row's state, and a
   * folder no workspace works in is a row of its own. Absent: the PC has none, and the list is as ever.
   */
  hostChats?: HostChatRows;
}

/** What the workspace list needs of a PC's host chats: where they stand, the one open, and the picks. */
export interface HostChatRows {
  placement: HostPlacement;
  selected: string | null;
  onSelect(session: string): void;
  /** the folder row's menu: a new chat there (the new-chat sheet), and the PC's every chat */
  folderMenu(cwd: string): RowMenuItem[];
  /** the folders pinned on this PC, in pin order: their rows stand in Pinned, with the pinned workspaces */
  pinnedFolders?: readonly string[];
}

/**
 * Spaces follow herdr's workspace roster. A workspace opens its current pane; tabs and split
 * panes are navigated through the tab strip, while Agents is an independent API-backed list.
 */
export function Sidebar({ snapshot, online, selectedPaneId, actions, hostChats }: SidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const twoLine = settings.sidebarRows === "two";
  const machineId = useMachineId();
  const activity = useSidebarActivity();
  const { closeWorkspace, listWorktrees, moveWorkspace, removeWorktree, renameWorkspace } = useMachineApi();
  // the roster's wait is a live region in the list from its first render, clipped while empty (never
  // display: none); its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(snapshot ? null : t("Loading workspaces…"));
  // herdr marks only a workspace it opened as a worktree. One made on a repository's folder has no
  // `worktree`, and it is where the first worktree starts: each is asked once whether git answers
  // for it. A refusal (4xx) is an answer and is kept; a failure to ask is not, so that workspace
  // keeps what was known of it and is asked again when the set changes or the PC comes back.
  const unmarked = (snapshot?.workspaces ?? []).filter((workspace) => !workspace.worktree).map((workspace) => workspace.workspace_id).join("\n");
  const [repositoryWorkspaces, setRepositoryWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
  const repositoryAnswers = useRef(new Map<string, boolean>());
  useEffect(() => {
    const known = repositoryAnswers.current;
    if (!online || unmarked === "") { known.clear(); setRepositoryWorkspaces(new Set()); return; }
    const ids = unmarked.split("\n");
    for (const id of [...known.keys()]) if (!ids.includes(id)) known.delete(id);
    let live = true;
    const publish = () => { if (live) setRepositoryWorkspaces(new Set(ids.filter((id) => known.get(id) === true))); };
    publish();
    void Promise.all(ids.filter((id) => !known.has(id)).map((id) => listWorktrees(id).then(
      () => { if (live) known.set(id, true); },
      (error: unknown) => { if (live && error instanceof ApiError && error.status < 500) known.set(id, false); },
    ))).then(publish);
    return () => { live = false; };
  }, [listWorktrees, unmarked, online]);
  const { branches, rememberOpened } = useWorktreeBranches(snapshot, online, true, repositoryWorkspaces);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{ mode: WorktreeDialogMode; workspace: WorkspaceInfo } | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // a finger's drag (lib/touchReorder.ts): the row it holds and the row it is over
  const [touchDrag, setTouchDrag] = useState<{ source: string; over: string | null } | null>(null);
  // the browser's drag and drop is a mouse's: on a touch screen a long press lifts the row instead
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const rosterId = useId();
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const revealOpenedWorkspace = useRef<string | null>(null);
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => storedWorktreeCollapsed(machineId, snapshot?.workspaces.flatMap((workspace) => workspace.worktree ? [workspace.worktree.repo_key] : []) ?? []));
  // the pane each workspace was last seen on in this browser: its row keeps showing and opening
  // that one, also after the page reloads (lib/lastViewedPane.ts). Kept once per pane opened, not
  // per snapshot, and a workspace opened again on the same pane becomes the newest seen again.
  const viewedWorkspaceId = selectedPaneId ? snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id : undefined;
  useEffect(() => {
    if (selectedPaneId && viewedWorkspaceId) rememberViewedPane("workspace", machineId, viewedWorkspaceId, selectedPaneId);
  }, [machineId, selectedPaneId, viewedWorkspaceId]);

  const setWorktreeCollapsed = (repoKey: string, collapsed: boolean): void => {
    setCollapsedWorktrees((current) => {
      if (current.has(repoKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(repoKey); else next.delete(repoKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(worktreeCollapsedKey(machineId, repoKey), "1");
      else localStorage.removeItem(worktreeCollapsedKey(machineId, repoKey));
    } catch {}
  };

  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) {
      setWorkspaceOrder([]);
      return;
    }
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    setWorkspaceOrder((current) => current.join("\u0000") === serverOrder.join("\u0000") ? current : serverOrder);
    // New worktree groups bring their stored fold state after reconnecting or creating a workspace.
    setCollapsedWorktrees((current) => {
      const keys = snapshot.workspaces.flatMap((workspace) => workspace.worktree && !current.has(workspace.worktree.repo_key) ? [workspace.worktree.repo_key] : []);
      const stored = storedWorktreeCollapsed(machineId, keys);
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const roster = useMemo(() => rosterPanes(snapshot?.panes ?? [], selectedPaneId), [snapshot?.panes, selectedPaneId]);
  const agentRows = useMemo(() => sidebarAgents(snapshot), [snapshot]);
  const agentByPane = useMemo(() => new Map(agentRows.map((entry) => [entry.pane.pane_id, entry])), [agentRows]);
  const agentNames = useMemo(() => workspaceAgentLabels(agentRows), [agentRows]);
  // a repository's worktree workspaces hang under one on its main checkout (lib/workspaceOrder.ts)
  const worktreeGroups = useMemo(() => groupWorktrees(orderedWorkspaces), [orderedWorkspaces]);
  // pinned workspaces stand first, in a card, in pin order (shared with the other browsers,
  // lib/preferencesSync.ts); their moves change pins, while the rest change herdr's order
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const pinnedIds = useMemo(() => pinnedWorkspaceIds(pins, machineId), [pins, machineId]);
  const shownGroups = useMemo(() => splitPinnedGroups(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id), [worktreeGroups, pinnedIds]);
  // a pinned head's worktrees remain outside the card, but cannot move away from their repository
  const fixedIds = useMemo(() => new Set([...pinnedGroupIds(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id)].filter((id) => !pinnedIds.includes(id))), [worktreeGroups, pinnedIds]);
  const movableGroups = shownGroups.rest.filter((group) => !fixedIds.has(group.workspace.workspace_id));
  // The open agent host workspaces stand among herdr's as rows of their own. A folder row's id is
  // its saved-order key (`f:<folder>`), which no herdr workspace id looks like.
  type FolderRow = HostPlacement["folders"][number];
  const placedFolders = hostChats?.placement.folders;
  const pinnedFolders = hostChats?.pinnedFolders;
  const folders = useMemo(() => placedFolders ?? [], [placedFolders]);
  const folderById = useMemo(() => new Map(folders.map((folder) => [folderKey(folder.cwd), folder])), [folders]);
  const pinnedFolderSet = useMemo(() => new Set((pinnedFolders ?? []).map(samePath)), [pinnedFolders]);
  // Pinned: workspaces and folders together, in pin order; moves there change the pins
  const pinnedList = useMemo(() => {
    const groups = new Map(shownGroups.pinned.map((group) => [group.workspace.workspace_id, group]));
    const workspacePrefix = workspacePinKey(machineId, "");
    const folderPrefix = hostFolderPinKey(machineId, "");
    return pinnedRowKeys(pins, machineId).flatMap((pin): { id: string; pin: string; group?: WorkspaceGroup<WorkspaceInfo>; folder?: FolderRow }[] => {
      if (isWorkspacePinKey(pin)) {
        const group = groups.get(pin.slice(workspacePrefix.length));
        return group ? [{ id: group.workspace.workspace_id, pin, group }] : [];
      }
      const folder = folderById.get(folderKey(pin.slice(folderPrefix.length)));
      return folder && pinnedFolderSet.has(folder.cwd) ? [{ id: folderKey(folder.cwd), pin, folder }] : [];
    });
  }, [shownGroups, pins, machineId, folderById, pinnedFolderSet]);
  // the rest: herdr's groups in herdr's order, each folder after the row it was put after (lib/hostWorkspaces.ts mergedOrder)
  const hostState = useSyncExternalStore(subscribeHostWorkspaces, currentHostWorkspaces, currentHostWorkspaces);
  const savedOrder = hostState[machineId]?.order;
  const restRows = useMemo(() => mergedOrder(shownGroups.rest.map((group) => group.workspace.workspace_id), folders.filter((folder) => !pinnedFolderSet.has(folder.cwd)).map((folder) => folder.cwd), savedOrder), [shownGroups, folders, pinnedFolderSet, savedOrder]);
  const restKeys = useMemo(() => mergedKeys(restRows), [restRows]);
  const restGroupById = new Map(shownGroups.rest.map((group) => [group.workspace.workspace_id, group]));
  const rowKey = (id: string): string => folderById.has(id) ? id : workspaceKey(id);
  const rowIdOf = (key: string): string => folderById.has(key) ? key : key.slice(workspaceKey("").length);
  // herdr's tree for agent host folders: a worktree's folder under its repository's (the host's
  // project), whose own folder, when not open, is a header row (lib/hostWorkspaces.ts folderTree)
  const repoOfFolder = useMemo(() => new Map(folders.flatMap((folder) => {
    const repo = folder.chats.find((chat) => chat.repo !== undefined)?.repo;
    return repo === undefined ? [] : [[samePath(folder.cwd), repo] as const];
  })), [folders]);
  const tree = useMemo(() => folderTree(restRows, (cwd) => repoOfFolder.get(samePath(cwd))), [restRows, repoOfFolder]);
  const topId = (row: TreeRow): string => row.kind === "workspace" ? row.id : row.kind === "folder" ? folderKey(row.cwd) : repoRowId(row.cwd);
  const treeTop = new Map(tree.map((row) => [topId(row), row]));
  const parentOfFolder = new Map(tree.flatMap((row) => row.kind === "workspace" ? [] : row.worktrees.map((cwd) => [folderKey(cwd), topId(row)] as const)));
  /** a rest-list row's saved keys: a folder's own and its worktrees', a header row's worktrees' */
  const blockOf = (id: string): string[] => {
    const row = treeTop.get(id);
    if (!row || row.kind === "workspace") return [rowKey(id)];
    const worktrees = row.worktrees.map(folderKey);
    return row.kind === "folder" ? [folderKey(row.cwd), ...worktrees] : worktrees;
  };
  /** the rest-list row a drop on `id` lands by: a folder (a worktree's, its repository's row), or the head of the group `id` is in */
  const restHeadOf = (id: string): string | undefined => {
    if (treeTop.has(id) && treeTop.get(id)!.kind !== "workspace") return id;
    if (parentOfFolder.has(id)) return parentOfFolder.get(id);
    if (folderById.has(id)) return pinnedFolderSet.has(folderById.get(id)!.cwd) ? undefined : id;
    return shownGroups.rest.find((group) => group.workspace.workspace_id === id || group.children.some((child) => child.workspace_id === id))?.workspace.workspace_id;
  };
  const restMovable = (id: string): boolean => (treeTop.has(id) && treeTop.get(id)!.kind !== "workspace") || movableGroups.some((group) => group.workspace.workspace_id === id);
  /** a worktree's folder among its siblings: the saved order only */
  const moveFolderChild = (id: string, targetId: string, side: "before" | "after"): void => {
    const keys = moveInMerged(restKeys, id, targetId, side);
    if (keys !== restKeys) setHostWorkspaces(withOrder(currentHostWorkspaces(), machineId, keys));
  };
  // a pin moves the row to the other list, so React draws it anew: the row that had the focus gets it back
  const refocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocusRow.current;
    if (id === null) return;
    refocusRow.current = null;
    workspaceRoot.current?.querySelector<HTMLElement>(`.workspace-group[data-workspace="${CSS.escape(id)}"] > .workspace-header .workspace-select`)?.focus({ preventScroll: true });
  }, [pins]);
  const togglePin = (state: MenuState): void => {
    const id = state.workspace.workspace_id;
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    if (back?.closest(`.workspace-group[data-workspace="${CSS.escape(id)}"]`)) refocusRow.current = id;
    // pins of workspaces gone from this PC leave with a change of the user's, never by themselves
    const live = new Set(snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? []);
    setSidebarPins(toggleSidebarPin(pruneWorkspacePins(pins, machineId, live), workspacePinKey(machineId, id)));
  };

  useLayoutEffect(() => {
    const id = revealOpenedWorkspace.current;
    if (!id) return;
    const row = [...(workspaceRoot.current?.querySelectorAll<HTMLElement>(".workspace-group") ?? [])].find((candidate) => candidate.dataset.workspace === id);
    const scroller = workspaceRoot.current?.closest<HTMLElement>(".machine-list");
    if (!row || !scroller || scroller.clientHeight === 0) return;
    const item = row.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    if (item.top < panel.top || item.bottom > panel.bottom) {
      scroller.scrollTop += (item.top + item.bottom - panel.top - panel.bottom) / 2;
    }
    revealOpenedWorkspace.current = null;
  }, [snapshot, selectedPaneId, branches]);

  const noteError = (message: string, workspaceId?: string, detail: string | null = null): void => setInlineError({ message, workspaceId, detail });

  /** the pane a workspace's row shows and opens, among the panes the row stands for */
  const currentPane = (workspace: WorkspaceInfo, panes: PaneInfo[]): PaneInfo => {
    const pick = (id: string | null | undefined) => (id ? panes.find((pane) => pane.pane_id === id) : undefined);
    return pick(selectedPaneId)
      ?? pick(lastViewedPane("workspace", machineId, workspace.workspace_id))
      ?? pick(snapshot?.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes.find((pane) => pane.focused)
      ?? panes[0]!;
  };

  /**
   * What leads a row: the coding agent in the pane the row opens, so the mark never promises an
   * agent a click would not reach. A shell is a terminal, a linked worktree without an agent its branch.
   */
  const rowMark = (pane: PaneInfo, linked: boolean) => {
    const mark = paneMark(agentByPane.get(pane.pane_id));
    return (
      <span className="sidebar-mark" aria-hidden="true">
        {mark !== null ? <AgentMark agent={mark} size={18} /> : linked ? <GitBranch /> : <Terminal />}
      </span>
    );
  };
  /** the mark in words, for a reader who cannot see it */
  const markName = (pane: PaneInfo): string => {
    const entry = agentByPane.get(pane.pane_id);
    return entry?.agentLabel ?? entry?.canonicalAgent ?? t("Shell");
  };
  const agentsTitle = (workspace: WorkspaceInfo): string | null => {
    const names = agentNames.get(workspace.workspace_id);
    return names ? t("Agents: {names}", { names: names.join(", ") }) : null;
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  // A close takes the workspace with it, so it asks first, as herdr's ui.confirm_close does.
  // The row is gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (close: () => Promise<void>): Promise<void> => {
    await close();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a pane closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const panes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const paneCount = Math.max(1, panes.length);
    // a worktree workspace: its checkout can be deleted; the repository's workspace: herdr closes
    // every workspace of the repository with it (any other one on the main checkout too, whatever
    // group it shows under here), and refuses without close_group
    const linked = workspace.worktree?.is_linked_worktree === true;
    const repoKey = workspace.worktree?.repo_key;
    const sameRepo = linked || repoKey === undefined ? [] : (snapshot?.workspaces.filter((candidate) => candidate.workspace_id !== workspace.workspace_id && candidate.worktree?.repo_key === repoKey) ?? []);
    const worktrees = sameRepo.filter((candidate) => candidate.worktree?.is_linked_worktree);
    const otherHeads = sameRepo.length > worktrees.length;
    const worktreeItems: RowMenuItem[] = (workspace.worktree || repositoryWorkspaces.has(workspace.workspace_id)) && !linked ? [
      { id: "new-worktree", label: t("New worktree"), icon: GitBranch, run: () => setWorktreeDialog({ mode: "create", workspace }) },
      { id: "open-worktree", label: t("Open worktree…"), icon: FolderOpen, run: () => setWorktreeDialog({ mode: "open", workspace }) },
    ] : [];
    const deleteItems: RowMenuItem[] = linked ? [{
      id: "delete-worktree", label: t("Delete worktree checkout…"), icon: Trash2, danger: true,
      run: () => setConfirm({
        title: t("Delete the checkout of {name}?", { name: workspace.label }),
        body: t("The folder at {path} is deleted and the workspace closes. The branch stays.", { path: workspace.worktree?.checkout_path ?? "" }),
        action: t("Delete"),
        run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id }); }),
        // git refuses a checkout with unsaved changes: the refusal shows, and the action becomes a forced one
        escalation: { label: t("Delete anyway"), code: "dirty_worktree_requires_force", run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id, force: true }); }) },
      }),
    }] : [];
    // a repository's other open workspaces go with it
    const closeItem: RowMenuItem = { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({
      title: t("Close workspace {name}?", { name: workspace.label }),
      body: (worktrees.length > 0
        ? t(paneCount === 1
          ? (worktrees.length === 1 ? "{n} pane and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} pane and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.")
          : (worktrees.length === 1 ? "{n} panes and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} panes and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay."), { n: paneCount, m: worktrees.length })
        : t(paneCount === 1 ? "{n} pane closes with it, and the agent in it stops." : "{n} panes close with it, and the agents in them stop.", { n: paneCount }))
        + (otherHeads ? ` ${t("The other workspaces open on this repository's main checkout close too.")}` : ""),
      run: () => leave(() => closeWorkspace(workspace.workspace_id, sameRepo.length > 0)),
    }) };
    // One native workspace menu for both the pointer and the explicit ⋯ button.
    const folded = repoKey !== undefined && collapsedWorktrees.has(repoKey);
    const pinned = pinnedIds.includes(workspace.workspace_id);
    return [
      pinned
        ? { id: "unpin-workspace", label: t("Unpin workspace"), icon: PinOff, run: () => togglePin(state) }
        : { id: "pin-workspace", label: t("Pin workspace"), icon: Pin, run: () => togglePin(state) },
      { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace) },
      { ...closeItem, label: t(sameRepo.length > 0 ? "Close group" : "Close workspace"), divider: false },
      ...worktreeItems, ...deleteItems,
      ...(worktrees.length > 0 && repoKey ? [{ id: "fold", label: t(folded ? "Expand" : "Collapse"), icon: folded ? ChevronRight : ChevronDown, run: () => setWorktreeCollapsed(repoKey, !folded) }] : []),
    ];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });
  // a rename's failure is answered after later renders: it asks the roster as it is then, and
  // reopens nothing over an editor the user opened since
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const editingRef = useRef({ workspace: editingWorkspaceId });
  editingRef.current = { workspace: editingWorkspaceId };
  const editorOpen = (): boolean => editingRef.current.workspace !== null;

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => {
    setEditingWorkspaceId(workspace.workspace_id);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const typed = workspaceLabel;
    const label = typed.trim();
    // herdr would keep an empty name, and the row would show none: the editor stays open
    if (label === "") { noteError(t("A workspace needs a name."), workspaceId); return; }
    setEditingWorkspaceId(null);
    // a name herdr set longer than the field allows is not sent back to be refused
    if (label === snapshotRef.current?.workspaces.find((candidate) => candidate.workspace_id === workspaceId)?.label) return;
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      // as for a pane: the typed name survives a failed request, for as long as the workspace does
      if (!editorOpen() && snapshotRef.current?.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) {
        setEditingWorkspaceId(workspaceId);
        setWorkspaceLabel(typed);
      }
      const failure = userErrorMessage(reason);
      noteError(t("Rename failed: {reason}", { reason: failure.message }), workspaceId, failure.detail);
    });
  };

  const reorderWorkspaces = (next: string[]): void => {
    const previous = workspaceOrder;
    const moves = workspaceMoves(previous, next);
    if (moves.length === 0) return;
    setWorkspaceOrder(next);
    void (async () => {
      for (const move of moves) await moveWorkspace(move.workspaceId, move.insertIndex);
    })().catch((reason: unknown) => {
      // only this move's own optimistic order is rolled back: if a later reorder has landed in
      // the meantime, its order is the newer one and reverting to `previous` would undo it
      setWorkspaceOrder((current) => (current.length === next.length && current.every((id, index) => id === next[index]) ? previous : current));
      const failure = userErrorMessage(reason);
      noteError(t("Reorder failed: {reason}", { reason: failure.message }), undefined, failure.detail);
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string, paneId: string | null): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
    // dropped on the pane area instead, the row opens its pane in half of it (lib/split.ts); a folder row has none
    if (paneId !== null) event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    dropVisible(sourceId, targetWorkspaceId);
  };

  // The roster shows groups: a repository's workspace moves past the next or previous group as
  // one, and a worktree moves among its siblings, by the neighbours the list shows (pinned rows
  // are not among them). herdr moves only the workspace it is told to, so a group's worktrees
  // (a pinned one too) are moved with it (lib/workspaceOrder.ts).
  const groupIds = (group: (typeof worktreeGroups)[number]): string[] => {
    const whole = worktreeGroups.find((candidate) => candidate.workspace.workspace_id === group.workspace.workspace_id) ?? group;
    return [whole.workspace, ...whole.children].map((workspace) => workspace.workspace_id);
  };
  /**
   * A rest-list row (a group's head or a folder) put before or after another: the saved order takes
   * the new list, and a herdr group also moves in herdr's order: by the herdr row it was dropped on,
   * else next to the herdr row it now follows (or before the one it now precedes).
   */
  const moveRest = (sourceId: string, targetId: string, side: "before" | "after"): void => {
    const source = rowKey(sourceId);
    const target = blockOf(targetId);
    const keys = moveBlock(restKeys, blockOf(sourceId), target[0]!, side, target);
    if (keys === restKeys) return;
    setHostWorkspaces(withOrder(currentHostWorkspaces(), machineId, keys));
    const group = movableGroups.find((candidate) => candidate.workspace.workspace_id === sourceId);
    if (!group) return;
    const at = keys.indexOf(source);
    const herdrRow = (key: string | undefined): WorkspaceGroup<WorkspaceInfo> | undefined => key === undefined || folderById.has(key) ? undefined : restGroupById.get(rowIdOf(key));
    const dropped = herdrRow(rowKey(targetId));
    const before = keys.slice(0, at).reverse().map(herdrRow).find(Boolean);
    const after = keys.slice(at + 1).map(herdrRow).find(Boolean);
    const [anchor, place] = dropped ? [dropped, side] as const : before ? [before, "after"] as const : after ? [after, "before"] as const : [undefined, side] as const;
    if (!anchor) return;
    const next = placeBlock(workspaceOrder, groupIds(group), groupIds(anchor), place);
    if (next.some((id, index) => id !== workspaceOrder[index])) reorderWorkspaces(next);
  };
  /** a worktree among its siblings, by the neighbours the list shows: herdr's order only */
  const moveChild = (workspaceId: string, targetId: string, side: "before" | "after"): string[] | null => {
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === workspaceId));
    if (!parent || workspaceId === targetId || !parent.children.some((child) => child.workspace_id === targetId)) return null;
    return placeBlock(workspaceOrder, [workspaceId], [targetId], side);
  };
  const pinnedRowOf = (id: string) => pinnedList.find((row) => row.id === id || row.group?.children.some((child) => child.workspace_id === id));
  const moveVisible = (workspaceId: string, direction: -1 | 1): void => {
    const side = direction === 1 ? "after" : "before";
    const pinnedIndex = pinnedList.findIndex((row) => row.id === workspaceId);
    if (pinnedIndex >= 0) {
      const target = pinnedList[pinnedIndex + direction];
      if (target) setSidebarPins(reorderPinnedRows(currentSidebarPins(), machineId, pinnedList[pinnedIndex]!.pin, target.pin));
      return;
    }
    if (restMovable(workspaceId)) {
      // the neighbour the list shows, a pinned head's worktree left where it stands
      const steps = tree.map(topId).filter(restMovable);
      const target = steps[steps.indexOf(workspaceId) + direction];
      if (target) moveRest(workspaceId, target, side);
      return;
    }
    const folderParent = parentOfFolder.get(workspaceId);
    if (folderParent !== undefined) {
      const siblings = blockOf(folderParent).filter((key) => parentOfFolder.get(key) === folderParent);
      const sibling = siblings[siblings.indexOf(workspaceId) + direction];
      if (sibling) moveFolderChild(workspaceId, sibling, side);
      return;
    }
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === workspaceId));
    const sibling = parent?.children[parent.children.findIndex((child) => child.workspace_id === workspaceId) + direction];
    const next = sibling ? moveChild(workspaceId, sibling.workspace_id, side) : null;
    if (next !== null) reorderWorkspaces(next);
  };

  /** A card drop belongs to the pin list; crossing the card's edge changes neither order. */
  const pinnedDropTarget = (sourceId: string, targetId: string) => {
    if (sourceId === targetId || !pinnedList.some((row) => row.id === sourceId)) return undefined;
    const target = pinnedRowOf(targetId);
    return target && target.id !== sourceId ? target : undefined;
  };
  /** where a drop of `sourceId` on `targetId` puts it, or none when it crosses a group's or the card's edge */
  const dropPlan = (sourceId: string, targetId: string): { kind: "pin"; target: NonNullable<ReturnType<typeof pinnedRowOf>>; side: "before" | "after" } | { kind: "rest"; target: string; side: "before" | "after" } | { kind: "child" | "folder-child"; target: string; side: "before" | "after" } | null => {
    const pinned = pinnedDropTarget(sourceId, targetId);
    if (pinned) return { kind: "pin", target: pinned, side: pinnedList.findIndex((row) => row.id === sourceId) < pinnedList.indexOf(pinned) ? "after" : "before" };
    if (restMovable(sourceId)) {
      const target = restHeadOf(targetId);
      if (target === undefined || target === sourceId) return null;
      const tops = tree.map(topId);
      return { kind: "rest", target, side: tops.indexOf(sourceId) < tops.indexOf(target) ? "after" : "before" };
    }
    if (parentOfFolder.has(sourceId)) {
      if (sourceId === targetId || parentOfFolder.get(targetId) !== parentOfFolder.get(sourceId)) return null;
      return { kind: "folder-child", target: targetId, side: restKeys.indexOf(sourceId) < restKeys.indexOf(targetId) ? "after" : "before" };
    }
    const side = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetId) ? "after" : "before";
    return moveChild(sourceId, targetId, side) === null ? null : { kind: "child", target: targetId, side };
  };
  const dropVisible = (sourceId: string, targetId: string): void => {
    const plan = dropPlan(sourceId, targetId);
    if (plan === null) return;
    if (plan.kind === "pin") setSidebarPins(reorderPinnedRows(currentSidebarPins(), machineId, pinnedList.find((row) => row.id === sourceId)!.pin, plan.target.pin));
    else if (plan.kind === "rest") moveRest(sourceId, plan.target, plan.side);
    else if (plan.kind === "folder-child") moveFolderChild(sourceId, plan.target, plan.side);
    else {
      const next = moveChild(sourceId, plan.target, plan.side);
      if (next !== null) reorderWorkspaces(next);
    }
  };

  // a finger's drag lands where the mouse's does: the same groups, the same index for herdr
  const touchHandlers = useRef<Parameters<typeof watchTouchReorder>[1] | null>(null);
  touchHandlers.current = {
    canLift: (id) => editingWorkspaceId !== id && !fixedIds.has(id),
    onLift: (id) => { setMenu(null); setTouchDrag({ source: id, over: id }); },
    onOver: (id) => setTouchDrag((current) => current && { ...current, over: id }),
    onDrop: (id, target) => {
      setTouchDrag(null);
      if (target !== null && target !== id) dropVisible(id, target);
    },
    onCancel: () => setTouchDrag(null),
  };
  useEffect(() => {
    const root = workspaceRoot.current;
    if (!root) return;
    return watchTouchReorder(root, {
      canLift: (id) => touchHandlers.current?.canLift(id) ?? false,
      onLift: (id) => touchHandlers.current?.onLift(id),
      onOver: (id) => touchHandlers.current?.onOver(id),
      onDrop: (id, target) => touchHandlers.current?.onDrop(id, target),
      onCancel: () => touchHandlers.current?.onCancel(),
    });
  }, []);

  /** where a held row would land, drawn as a line: before or after a row, or after a group's worktrees */
  const dropMark = ((): { id: string; side: "before" | "after"; children: boolean } | null => {
    if (!touchDrag?.over || touchDrag.over === touchDrag.source) return null;
    const plan = dropPlan(touchDrag.source, touchDrag.over);
    if (plan === null) return null;
    if (plan.kind === "child" || plan.kind === "folder-child") return { id: plan.target, side: plan.side, children: false };
    const id = plan.kind === "pin" ? plan.target.id : plan.target;
    const top = treeTop.get(id);
    const children = (plan.kind === "pin" ? plan.target.group?.children : restGroupById.get(id)?.children)?.length ?? (top && top.kind !== "workspace" ? top.worktrees.length : 0);
    return { id, side: plan.side, children: plan.side === "after" && children > 0 };
  })();

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveVisible(workspaceId, event.key === "ArrowUp" ? -1 : 1);
  };

  const renderWorkspaceRow = (workspace: WorkspaceInfo, children: WorkspaceInfo[] = [], nested = false, drop?: "before" | "after") => {
    const panes = roster.filter((pane) => pane.workspace_id === workspace.workspace_id);
    if (panes.length === 0) return null;
    const pane = currentPane(workspace, panes);
    // a workspace's host chats are its tabs too: the one open selects its row, and they count in its state
    const hostTabs = hostChats?.placement.tabs.get(workspace.workspace_id) ?? [];
    const selected = panes.some((candidate) => candidate.pane_id === selectedPaneId) || hostTabs.some((chat) => chat.session === hostChats?.selected);
    const repoKey = workspace.worktree?.repo_key;
    const linked = workspace.worktree?.is_linked_worktree === true;
    const branch = branches.get(workspace.workspace_id);
    const branchTitle = branch?.branch ?? (branch?.isDetached ? t("Detached HEAD") : null);
    // the row says the workspace's name, the one its owner gave it or herdr made from the branch; the
    // branch itself is the tooltip's and the menu's, where the name does not already say it
    const rowTitle = workspace.label;
    const secondaryBranch = linked && branchTitle && workspace.label !== branchTitle && workspace.label !== worktreeLabel(branchTitle) ? branchTitle : null;
    // as herdr's own sidebar: a top-level git workspace says its branch on a second line, while an
    // indented worktree (its name already the branch's), a pinned row (the card stays compact; the
    // branch is in its tooltip and menu) and a folder outside git keep one line
    const branchLine = !twoLine && !nested && !pinnedIds.includes(workspace.workspace_id) && branchTitle ? branchTitle : null;
    // the tooltip and the menu keep the exact branch (its slashes) even where the row does not repeat it
    const branchNote = branchTitle && branchTitle !== workspace.label ? branchTitle : null;
    const paths = [...new Set([workspace.worktree?.checkout_path, pane.cwd].filter((path): path is string => Boolean(path)))];
    const collapsed = children.length > 0 && repoKey !== undefined && collapsedWorktrees.has(repoKey);
    // a folded group's parent stands for its worktrees too, as herdr's collapsed parent does:
    // a checkout that waits or has finished must not hide behind the fold
    const statusPanes = collapsed ? [...panes, ...children.flatMap((child) => roster.filter((candidate) => candidate.workspace_id === child.workspace_id))] : panes;
    // on two lines the row says what its pane is doing, and the workspace it has named until now sits under that
    const lines = twoLine ? taskRowLines({ paneTitle: displayPaneTitle(pane), labelled: Boolean(pane.label?.trim()), folder: cwdBasename(pane.cwd), workspace: rowTitle, alias: secondaryBranch }) : null;
    // a folded group still shows the checkout that is open; the count is of the ones put away
    const foldedCount = collapsed ? children.filter((child) => !roster.some((candidate) => candidate.workspace_id === child.workspace_id && candidate.pane_id === selectedPaneId)).length : 0;
    const editingWorkspace = editingWorkspaceId === workspace.workspace_id;
    const fixed = fixedIds.has(workspace.workspace_id);
    const menuOpen = menu?.workspace.workspace_id === workspace.workspace_id;
    const contentsId = `${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`;
    // without a project icon the folder itself says the fold's state: open while the worktrees show
    const unfolded = children.length > 0 && repoKey !== undefined && !collapsed;
    const face = <WorkspaceFavicon root={workspace.worktree?.checkout_path ?? pane.cwd ?? null} fallback={<span className="sidebar-mark workspace-folder" aria-hidden="true">{unfolded ? <FolderOpen /> : <Folder />}</span>} />;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void => setMenu(menuOpen ? null : { anchor, point, previousFocus, workspace, title: rowTitle, place: [branchNote, ...paths].filter(Boolean).join(" · ") || workspace.label });
    return <li
      className={`workspace workspace-group pane-item${selected ? " is-selected" : ""}${collapsed ? " is-collapsed" : ""}${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${touchDrag?.source === workspace.workspace_id ? " is-lifted" : ""}`}
      key={workspace.workspace_id}
      data-workspace={workspace.workspace_id}
      data-branch={branchTitle ?? undefined}
      data-drop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => onDrop(event, workspace.workspace_id)}
    >
      <div className="workspace-header"
        onMouseDownCapture={(event) => { if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && !(event.target as HTMLElement).closest("input")) event.preventDefault(); }}
        onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
        {/* a workspace leads with its own face, the project's icon or else a folder; when linked
            worktrees sit under it, that face is also the fold, and turns to an open or closed folder under a pointer */}
        {nested ? null : children.length > 0 && repoKey !== undefined ? <button
          type="button"
          className="sidebar-row-action workspace-toggle"
          aria-label={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          title={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          aria-expanded={!collapsed}
          aria-controls={contentsId}
          onClick={() => setWorktreeCollapsed(repoKey, !collapsed)}
        >{face}<span className="workspace-toggle-fold" aria-hidden="true">{collapsed ? <Folder /> : <FolderOpen />}</span></button> : face}
        <div
          className="pane-select workspace-select"
          role="button"
          tabIndex={0}
          draggable={!coarsePointer && !editingWorkspace && !fixed}
          onDragStart={(event) => { if (!editingWorkspace) onDragStart(event, workspace.workspace_id, pane.pane_id); }}
          onDragEnd={() => setDragWorkspaceId(null)}
          aria-keyshortcuts={fixed ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          aria-description={fixed ? undefined : `${t("Reorder workspace {name}", { name: workspace.label })} · ${t("Drag to reorder · Alt+↑/↓")}`}
          data-pane={pane.pane_id}
          aria-current={selected ? "true" : undefined}
          title={[`${pane.pane_id} — ${rowTitle}`, branchNote, ...paths, paneTitle(pane), agentsTitle(workspace)].filter(Boolean).join(" — ")}
          onClick={() => actions.selectPane(pane.pane_id)}
          onKeyDown={(event) => {
            onRowKeyDown(event, workspace.workspace_id);
            if (event.defaultPrevented) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            actions.selectPane(pane.pane_id);
          }}
        >
          {rowMark(pane, workspace.worktree?.is_linked_worktree === true)}
          {editingWorkspace ? <input
            className="input workspace-rename-input"
            aria-label={t("Workspace name")}
            autoFocus
            maxLength={MAX_LABEL_CHARS}
            value={workspaceLabel}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setWorkspaceLabel(event.target.value)}
            onBlur={() => setEditingWorkspaceId(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
              if (event.key === "Escape") setEditingWorkspaceId(null);
            }}
          /> : lines ? <span className="workspace-copy is-two-line">
            <span className="workspace-line">
              <span className="workspace-name">{lines.title}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            </span>
            {lines.place && <span className="workspace-place">{lines.place}</span>}
          </span> : branchLine ? <span className="workspace-copy is-branch-line">
            <span className="workspace-line">
              <span className="workspace-name">{rowTitle}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            </span>
            <span className="workspace-place workspace-branch">{branchLine}</span>
          </span> : <span className="workspace-copy">
            <span className="workspace-name">{rowTitle}</span>
            {secondaryBranch && <span className="worktree-workspace-label">{secondaryBranch}</span>}
            {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
          </span>}
          <span className="sidebar-pane-meta">
            <span className="visually-hidden">{markName(pane)}</span>
            {online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={online ? rollupStatus([...statusPanes.map((candidate) => activity.status(machineId, candidate)), ...hostTabs.map(hostChatStatus)]) : undefined} />}
          </span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: rowTitle })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
      </div>
      {inlineError?.workspaceId === workspace.workspace_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>}
    </li>;
  };

  /** a top-level row, and a repository's worktrees indented under it */
  const renderGroup = ({ workspace, children }: WorkspaceGroup<WorkspaceInfo>) => {
    const childrenHidden = collapsedWorktrees.has(workspace.worktree?.repo_key ?? "") && !children.some((child) => roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId));
    // a group moved below this one lands after its worktrees, and the line says so
    const afterChildren = dropMark?.id === workspace.workspace_id && dropMark.children;
    return <Fragment key={workspace.workspace_id}>
      {renderWorkspaceRow(workspace, children, false, dropMark?.id === workspace.workspace_id && (!dropMark.children || childrenHidden) ? dropMark.side : undefined)}
      {children.length > 0 && <li
        className="worktree-children"
        id={`${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`}
        hidden={childrenHidden}
        data-drop={afterChildren && !childrenHidden ? "after" : undefined}
      ><ul className="workspace-list">
        {children.filter((child) => !collapsedWorktrees.has(workspace.worktree!.repo_key) || roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId)).map((child) => renderWorkspaceRow(child, [], true, dropMark?.id === child.workspace_id ? dropMark.side : undefined))}
      </ul></li>}
    </Fragment>;
  };

  // a folder no workspace works in: a row as a workspace's, whose tabs are its host chats
  const [folderMenu, setFolderMenu] = useState<{ anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; cwd: string; title: string } | null>(null);
  /** a folder's worktree folders, under it as herdr's are under their repository; folded by its face */
  const folderFold = (cwd: string): string => folderKey(cwd);
  const foldToggle = (cwd: string, name: string, worktrees: readonly string[], face: ReactNode) => {
    const folded = collapsedWorktrees.has(folderFold(cwd));
    const label = folded ? t("Expand worktrees of {name}", { name }) : t("Collapse worktrees of {name}", { name });
    return <button type="button" className="sidebar-row-action workspace-toggle" aria-label={label} title={label} aria-expanded={!folded}
      aria-controls={`${rosterId}-worktrees-${encodeURIComponent(folderFold(cwd))}`} onClick={() => setWorktreeCollapsed(folderFold(cwd), !folded)}>
      {face}<span className="workspace-toggle-fold" aria-hidden="true">{folded ? <Folder /> : <FolderOpen />}</span>
    </button>;
  };
  const folderChildren = (cwd: string, worktrees: readonly string[]) => {
    if (worktrees.length === 0) return null;
    const holdsSelected = worktrees.some((child) => folderById.get(folderKey(child))?.chats.some((chat) => chat.session === hostChats?.selected));
    const folded = collapsedWorktrees.has(folderFold(cwd));
    const shown = folded ? worktrees.filter((child) => folderById.get(folderKey(child))?.chats.some((chat) => chat.session === hostChats?.selected)) : worktrees;
    return <li className="worktree-children" id={`${rosterId}-worktrees-${encodeURIComponent(folderFold(cwd))}`} hidden={folded && !holdsSelected}
      data-drop={dropMark?.id === topIdOf(cwd) && dropMark.children && !folded ? "after" : undefined}>
      <ul className="workspace-list">{shown.map((child) => renderFolderRow(folderById.get(folderKey(child))!, dropMark?.id === folderKey(child) ? dropMark.side : undefined, true))}</ul>
    </li>;
  };
  const topIdOf = (cwd: string): string => treeTop.has(folderKey(cwd)) ? folderKey(cwd) : repoRowId(cwd);
  /** a repository none of whose own chats are open, only its worktrees': herdr's group header, a fold */
  const renderRepoRow = (cwd: string, worktrees: readonly string[]) => {
    const id = repoRowId(cwd);
    const name = basename(cwd);
    const chats = worktrees.flatMap((child) => folderById.get(folderKey(child))?.chats ?? []);
    const folded = collapsedWorktrees.has(folderFold(cwd));
    const drop = dropMark?.id === id && (!dropMark.children || folded) ? dropMark.side : undefined;
    const face = <span className="host-folder-face"><WorkspaceFavicon root={cwd} fallback={<span className="sidebar-mark workspace-folder" aria-hidden="true">{folded ? <Folder /> : <FolderOpen />}</span>} /></span>;
    return <Fragment key={id}>
      <li className={`workspace workspace-group pane-item host-folder host-repo${folded ? " is-collapsed" : ""}${dragWorkspaceId === id ? " is-dragging" : ""}${touchDrag?.source === id ? " is-lifted" : ""}`} data-host-repo={cwd} data-workspace={id} data-drop={drop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
        onDrop={(event) => onDrop(event, id)}>
        <div className="workspace-header">
          {foldToggle(cwd, name, worktrees, face)}
          <div className="pane-select workspace-select" role="button" tabIndex={0} title={cwd}
            draggable={!coarsePointer}
            onDragStart={(event) => onDragStart(event, id, null)}
            onDragEnd={() => setDragWorkspaceId(null)}
            aria-expanded={!folded}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            aria-description={`${t("Reorder workspace {name}", { name })} · ${t("Drag to reorder · Alt+↑/↓")}`}
            onClick={() => setWorktreeCollapsed(folderFold(cwd), !folded)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setWorktreeCollapsed(folderFold(cwd), !folded); return; }
              onRowKeyDown(event, id);
            }}>
            {/* an empty mark slot: its name lines up with the rows that lead with an agent's mark */}
            <span className="sidebar-mark" aria-hidden="true" />
            <span className="workspace-copy"><span className="workspace-line"><span className="workspace-name">{name}</span>{folded && <span className="workspace-fold-count" aria-hidden="true">+{worktrees.length}</span>}</span></span>
            <span className="sidebar-pane-meta">
              <StatusBadge compact status={online && folded ? rollupStatus(chats.map(hostChatStatus)) : undefined} />
            </span>
          </div>
        </div>
      </li>
      {folderChildren(cwd, worktrees)}
    </Fragment>;
  };
  const renderFolderRow = ({ cwd, chats }: { cwd: string; chats: HostChatRow[] }, drop?: "before" | "after", nested = false, worktrees: readonly string[] = []) => {
    if (!hostChats) return null;
    const id = folderKey(cwd);
    const name = basename(cwd);
    const folded = worktrees.length > 0 && collapsedWorktrees.has(folderFold(cwd));
    // a folded folder stands for its worktrees too, as herdr's folded repository does
    const statusChats = folded ? [...chats, ...worktrees.flatMap((child) => folderById.get(folderKey(child))?.chats ?? [])] : chats;
    const open = chats.find((chat) => chat.session === hostChats.selected);
    // the row opens the chat open there, else its newest
    const lead = open ?? chats[0]!;
    const lines = twoLine ? { title: lead.title.trim() || t("Copilot chat"), place: name } : null;
    const menuOpen = folderMenu?.cwd === cwd;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void => setFolderMenu(menuOpen ? null : { anchor, point, previousFocus, cwd, title: name });
    const face = <span className="host-folder-face"><WorkspaceFavicon root={cwd} fallback={<span className="sidebar-mark workspace-folder" aria-hidden="true">{worktrees.length > 0 && !folded ? <FolderOpen /> : <Folder />}</span>} /></span>;
    const row = <li className={`workspace workspace-group pane-item host-folder${open ? " is-selected" : ""}${folded ? " is-collapsed" : ""}${dragWorkspaceId === id ? " is-dragging" : ""}${touchDrag?.source === id ? " is-lifted" : ""}`} key={id} data-host-folder={cwd} data-workspace={id} data-drop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => onDrop(event, id)}>
      <div className="workspace-header"
        onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
        onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
        {/* the workspace's face (its project's icon, else a folder); with worktrees under it, the face is
            also their fold, as herdr's is */}
        {nested ? null : worktrees.length > 0 ? foldToggle(cwd, name, worktrees, face) : face}
        <div className="pane-select workspace-select" role="button" tabIndex={0} aria-current={open ? "true" : undefined} title={[cwd, ...chats.map((chat) => chat.title)].join(" — ")}
          draggable={!coarsePointer}
          onDragStart={(event) => onDragStart(event, id, null)}
          onDragEnd={() => setDragWorkspaceId(null)}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-description={`${t("Reorder workspace {name}", { name })} · ${t("Drag to reorder · Alt+↑/↓")}`}
          onClick={() => hostChats.onSelect(lead.session)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); hostChats.onSelect(lead.session); return; }
            onRowKeyDown(event, id);
          }}>
          {/* Copilot's mark leads the row, as an agent's leads herdr's rows, so names line up with theirs */}
          <span className="sidebar-mark" aria-hidden="true"><AgentMark agent="copilot" size={18} /></span>
          {lines ? <span className="workspace-copy is-two-line">
            <span className="workspace-line"><span className="workspace-name">{lines.title}</span></span>
            <span className="workspace-place">{lines.place}</span>
          </span> : <span className="workspace-copy"><span className="workspace-line"><span className="workspace-name">{name}</span>{folded && <span className="workspace-fold-count" aria-hidden="true">+{worktrees.length}</span>}</span></span>}
          <span className="sidebar-pane-meta">
            <span className="visually-hidden">Copilot</span>
            <StatusBadge compact status={online ? rollupStatus(statusChats.map(hostChatStatus)) : undefined} />
          </span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: name })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>;
    return worktrees.length === 0 ? row : <Fragment key={id}>{row}{folderChildren(cwd, worktrees)}</Fragment>;
  };
  const folderDrop = (id: string): "before" | "after" | undefined => dropMark?.id === id ? dropMark.side : undefined;
  const pinnedWorkspacesShown = shownGroups.pinned.some(({ workspace }) => roster.some((pane) => pane.workspace_id === workspace.workspace_id));

  return (
    <div className={`machine-workspaces${twoLine ? " is-two-line" : ""}`} ref={workspaceRoot}>
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        <>
          <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
          {snapshot && snapshot.workspaces.length === 0 && folders.length === 0 && (
            <div className="tree-state-empty">
              <p className="tree-state" role="status">{t("No workspaces yet")}</p>
              <button type="button" className="btn" onClick={actions.openNewSession}><Plus aria-hidden="true" />{t("New workspace")}</button>
            </div>
          )}
          {(pinnedWorkspacesShown || pinnedList.some((row) => row.folder)) && <>
            <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
            <ul className="workspace-list workspace-list-pinned sidebar-pinned" aria-label={t("Pinned")}>
              {pinnedList.map((row) => row.folder ? renderFolderRow(row.folder, folderDrop(row.id)) : pinnedWorkspacesShown ? renderGroup(row.group!) : null)}
            </ul>
          </>}
          <ul className="workspace-list">{tree.map((row) => row.kind === "workspace" ? renderGroup(restGroupById.get(row.id)!)
            : row.kind === "folder" ? renderFolderRow(folderById.get(folderKey(row.cwd))!, dropMark?.id === folderKey(row.cwd) && (!dropMark.children || collapsedWorktrees.has(folderFold(row.cwd))) ? dropMark.side : undefined, false, row.worktrees)
            : renderRepoRow(row.cwd, row.worktrees))}</ul>
          {inlineError && inlineError.workspaceId === undefined && (
            <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>
          )}
        </>
      </nav>
      {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={closeMenu} />}
      {folderMenu && hostChats && <RowMenu anchor={folderMenu.anchor} point={folderMenu.point} restoreFocusTo={folderMenu.previousFocus} title={folderMenu.title} subtitle={folderMenu.cwd} items={hostChats.folderMenu(folderMenu.cwd)} onClose={() => setFolderMenu(null)} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action ?? t("Close")} onConfirm={confirm.run} escalation={confirm.escalation} onClose={() => setConfirm(null)} />}
      {worktreeDialog && <WorktreeDialog mode={worktreeDialog.mode} workspace={worktreeDialog.workspace} onClose={() => setWorktreeDialog(null)} onOpened={(opened) => {
        rememberOpened(opened);
        revealOpenedWorkspace.current = opened.workspace_id;
        const repoKey = worktreeDialog.workspace.worktree?.repo_key;
        if (repoKey) setWorktreeCollapsed(repoKey, false);
        setWorktreeDialog(null);
        if (opened.agent_started === true) actions.agentStarted(machineId, opened.pane_id);
        actions.selectPane(opened.pane_id);
      }} />}
    </div>
  );
}
