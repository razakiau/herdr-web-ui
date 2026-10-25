/**
 * The rules of agent host workspaces (shared/host-workspaces.ts): a folder is open because the user
 * opened it, as a herdr workspace is; its tabs are the chats the user opened there. Closing either
 * hides, never archives. Pure: each returns the state it was given when nothing changed, so a
 * caller writes only a change.
 */
import type { HostChatRow } from "../../shared/host-chats.ts";
import { fitHostWorkspaces, sanitizeHostWorkspaces, type HostWorkspace, type HostWorkspaceState, type PcHostWorkspaces } from "../../shared/host-workspaces.ts";
import { hostChatLive, type HostPc } from "./hostChats.ts";
import { isLive, samePath } from "./hostPlacement.ts";
import type { HostAutoOpen } from "./settings.ts";

export { fitHostWorkspaces, HOST_WORKSPACES_BUDGET, sanitizeHostWorkspaces } from "../../shared/host-workspaces.ts";
export type { HostWorkspace, HostWorkspaceState, PcHostWorkspaces } from "../../shared/host-workspaces.ts";

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};
const folderOf = (row: Pick<HostChatRow, "cwd">): string | null => (row.cwd ? samePath(row.cwd) : null);
const usable = (row: HostChatRow): boolean => !row.archived && folderOf(row) !== null;

function find(pc: PcHostWorkspaces | undefined, cwd: string): HostWorkspace | undefined {
  const folder = samePath(cwd);
  return pc?.open.find((each) => each.cwd === folder);
}

export function isOpenFolder(pc: PcHostWorkspaces | undefined, cwd: string): boolean {
  return find(pc, cwd) !== undefined;
}

export function tabsOf(pc: PcHostWorkspaces | undefined, cwd: string): string[] {
  return find(pc, cwd)?.tabs ?? [];
}

/** Whether the chat is an open tab; one on screen that is not is a look, which nothing saves. */
export function isTabOpen(pc: PcHostWorkspaces | undefined, session: string): boolean {
  return pc?.open.some((each) => each.tabs.includes(session)) ?? false;
}

/** The tab to show when `session`'s closes while on screen: the next in its strip, else the one before; null when it was the last. */
export function tabAfterClose(pc: PcHostWorkspaces, session: string): string | null {
  const tabs = pc.open.find((each) => each.tabs.includes(session))?.tabs ?? [];
  const at = tabs.indexOf(session);
  return at < 0 ? null : tabs[at + 1] ?? tabs[at - 1] ?? null;
}

/**
 * What a PC with no herdr pane opens on its own: the first tab of its first agent host workspace
 * that has one, in the sidebar's order (the order they were opened when none is saved); null when
 * no workspace has a tab.
 */
export function firstHostTab(pc: PcHostWorkspaces | undefined): string | null {
  if (!pc) return null;
  const rank = new Map((pc.order ?? []).map((key, at) => [key, at] as const));
  const place = (each: HostWorkspace): number => rank.get(folderKey(each.cwd)) ?? Number.MAX_SAFE_INTEGER;
  const sorted = pc.open.map((each, at) => ({ each, at })).sort((a, b) => place(a.each) - place(b.each) || a.at - b.at);
  return sorted.find(({ each }) => each.tabs.length > 0)?.each.tabs[0] ?? null;
}

const withOpen = (pc: PcHostWorkspaces, open: HostWorkspace[]): PcHostWorkspaces => ({ ...pc, open });

/**
 * The tabs a workspace opens with: its chats that work, ask or are unread (newest first), then its
 * newest one if not among them. Usually one to three, never its whole history.
 */
function firstTabs(cwd: string, chats: readonly HostChatRow[]): string[] {
  const own = chats.filter((row) => usable(row) && folderOf(row) === cwd).sort((a, b) => modified(b) - modified(a));
  const wanted = [...own.filter(isLive), ...own.filter((row) => !isLive(row) && row.unread)];
  const newest = own[0];
  if (newest && !wanted.includes(newest)) wanted.push(newest);
  return wanted.map((row) => row.session);
}

/** Opens `cwd` with its first tabs; an open one is left as it is. */
export function openWorkspace(pc: PcHostWorkspaces, cwd: string, chats: readonly HostChatRow[]): PcHostWorkspaces {
  if (isOpenFolder(pc, cwd)) return pc;
  const folder = samePath(cwd);
  return withOpen(pc, [...pc.open, { cwd: folder, tabs: firstTabs(folder, chats) }]);
}

export function closeWorkspace(pc: PcHostWorkspaces, cwd: string): PcHostWorkspaces {
  const folder = samePath(cwd);
  return isOpenFolder(pc, folder) ? withOpen(pc, pc.open.filter((each) => each.cwd !== folder)) : pc;
}

/** The chat as a tab of its folder's workspace, which opens (with this tab only) if it was closed. */
export function openTab(pc: PcHostWorkspaces, chat: Pick<HostChatRow, "session" | "cwd">): PcHostWorkspaces {
  const folder = folderOf(chat);
  if (folder === null) return pc;
  const open = find(pc, folder);
  if (!open) return withOpen(pc, [...pc.open, { cwd: folder, tabs: [chat.session] }]);
  if (open.tabs.includes(chat.session)) return pc;
  return withOpen(pc, pc.open.map((each) => each === open ? { ...each, tabs: [...each.tabs, chat.session] } : each));
}

/** The chat's tab closed; a workspace left with none closes, as herdr's does with its last tab. */
export function closeTab(pc: PcHostWorkspaces, session: string): PcHostWorkspaces {
  if (!pc.open.some((each) => each.tabs.includes(session))) return pc;
  return withOpen(pc, pc.open.flatMap((each) => {
    if (!each.tabs.includes(session)) return [each];
    const tabs = each.tabs.filter((tab) => tab !== session);
    return tabs.length > 0 ? [{ ...each, tabs }] : [];
  }));
}

/**
 * Tabs whose chat is gone or archived dropped; a workspace left with none closes. `keep` (the chat
 * on screen) stays: a new chat is not listed until its first message.
 */
export function prunePc(pc: PcHostWorkspaces, chats: readonly HostChatRow[], keep: string | null = null): PcHostWorkspaces {
  const alive = new Set(chats.filter((row) => !row.archived).map((row) => row.session));
  if (keep !== null && !chats.some((row) => row.session === keep && row.archived)) alive.add(keep);
  let changed = false;
  const open = pc.open.flatMap((each) => {
    const tabs = each.tabs.filter((tab) => alive.has(tab));
    if (tabs.length === each.tabs.length) return [each];
    changed = true;
    return tabs.length > 0 ? [{ ...each, tabs }] : [];
  });
  return changed ? withOpen(pc, open) : pc;
}

/**
 * A PC's first state, the first time the app sees it with nothing saved: its pinned folders, the
 * folders with a chat that works or asks, and the folder of the chat on screen, each with its first
 * tabs (the one on screen among them). Everything else starts closed. `policy` (Settings, Agent
 * host): "pinned" leaves the working ones closed, "none" the pinned ones too; the one on screen opens
 * whatever it says, as it is already shown.
 */
export function seedPc(chats: readonly HostChatRow[], pinnedFolders: ReadonlySet<string>, onScreen: string | null, policy: HostAutoOpen = "active"): PcHostWorkspaces {
  const pinned = new Set([...pinnedFolders].map(samePath));
  let pc: PcHostWorkspaces = { open: [] };
  for (const row of [...chats].filter(usable).sort((a, b) => modified(b) - modified(a))) {
    const folder = folderOf(row)!;
    const wanted = (policy !== "none" && pinned.has(folder)) || (policy === "active" && isLive(row));
    if (wanted || row.session === onScreen) pc = openWorkspace(pc, folder, chats);
  }
  const shown = chats.find((row) => row.session === onScreen && usable(row));
  return shown ? openTab(pc, shown) : pc;
}

/**
 * The folders New workspace → Agent host offers: each folder the PC's chats work in (archived ones
 * aside), with how many chats it has and when the newest changed, newest first, and whether it is open.
 */
export function hostFolders(chats: readonly HostChatRow[], pc: PcHostWorkspaces | undefined): { cwd: string; chats: number; modified_at: string; open: boolean }[] {
  const folders = new Map<string, { cwd: string; chats: number; modified_at: string; open: boolean }>();
  for (const row of chats) {
    if (!usable(row) || row.no_folder) continue;
    const cwd = folderOf(row)!;
    const was = folders.get(cwd);
    if (!was) folders.set(cwd, { cwd, chats: 1, modified_at: row.modified_at, open: isOpenFolder(pc, cwd) });
    else folders.set(cwd, { ...was, chats: was.chats + 1, modified_at: modified(row) > Date.parse(was.modified_at) ? row.modified_at : was.modified_at });
  }
  return [...folders.values()].sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at));
}

/**
 * What a folder row says beyond its name: whether it is the No folder row (chats the host was given
 * no folder for), and its branch, the newest chat's (VS Code reports the checkout per chat; a
 * detached HEAD has none: herdr's rows then say Detached HEAD, and so does this one).
 */
export function folderFace(chats: readonly HostChatRow[]): { noFolder: boolean; branch: string | null; detached: boolean } {
  const newest = [...chats].sort((a, b) => modified(b) - modified(a))[0];
  return { noFolder: chats.some((row) => row.no_folder === true), branch: newest?.branch ?? null, detached: newest?.detached === true };
}

/**
 * Whether to seed a PC now: nothing saved for it, and a list its connected host just gave (a host
 * that is not up, or a list that failed, says nothing about which chats exist).
 */
export function shouldSeed(stored: HostWorkspaceState, machineId: string, read: HostPc | undefined): boolean {
  return stored[machineId] === undefined && hostChatLive(read);
}

/**
 * A PC's saved state brought up to date with the list its connected host just gave: seeded the
 * first time (seedPc), else its gone and archived tabs dropped (prunePc). The same object when
 * nothing changed, so a caller writes only a change.
 */
export function upkeepPc(stored: HostWorkspaceState, machineId: string, read: HostPc | undefined, pinnedFolders: ReadonlySet<string>, onScreen: string | null, policy: HostAutoOpen = "active"): HostWorkspaceState {
  if (!hostChatLive(read)) return stored;
  const was = stored[machineId];
  const next = was === undefined ? seedPc(read!.chats, pinnedFolders, onScreen, policy) : prunePc(was, read!.chats, onScreen);
  return next === was ? stored : { ...stored, [machineId]: next };
}

/** A herdr workspace's entry in a PC's saved sidebar order. */
export function workspaceKey(id: string): string {
  return `w:${id}`;
}

/** An agent host workspace's entry in a PC's saved sidebar order (and its row's id while it moves). */
export function folderKey(cwd: string): string {
  return `f:${samePath(cwd)}`;
}

export type MergedRow = { kind: "workspace"; id: string } | { kind: "folder"; cwd: string };

/**
 * One list of herdr's workspaces and the open agent host workspaces. herdr's rows keep herdr's order,
 * which herdr owns and another browser may change. Each host row stays right after the row saved
 * before it (first when none), so it moves with that row. Saved entries no longer shown are skipped;
 * host rows never placed go last, in the order given.
 */
export function mergedOrder(herdrIds: readonly string[], hostCwds: readonly string[], saved: readonly string[] | undefined): MergedRow[] {
  const herdr = new Set(herdrIds.map(workspaceKey));
  const host = new Map(hostCwds.map((cwd) => [folderKey(cwd), samePath(cwd)] as const));
  const after = new Map<string | null, string[]>();
  let previous: string | null = null;
  for (const key of new Set(saved ?? [])) {
    if (herdr.has(key)) previous = key;
    else if (host.has(key)) {
      after.set(previous, [...after.get(previous) ?? [], key]);
      previous = key;
    }
  }
  const rows: MergedRow[] = [];
  const placed = new Set<string>();
  const emitFolders = (anchor: string | null): void => {
    for (const key of after.get(anchor) ?? []) {
      rows.push({ kind: "folder", cwd: host.get(key)! });
      placed.add(key);
      emitFolders(key);
    }
  };
  emitFolders(null);
  for (const id of herdrIds) {
    rows.push({ kind: "workspace", id });
    emitFolders(workspaceKey(id));
  }
  for (const [key, cwd] of host) if (!placed.has(key)) rows.push({ kind: "folder", cwd });
  return rows;
}

export function mergedKeys(rows: readonly MergedRow[]): string[] {
  return rows.map((row) => row.kind === "workspace" ? workspaceKey(row.id) : folderKey(row.cwd));
}

/** `item` moved before or after `target`; the same array when that changes nothing. */
export function moveInMerged(keys: readonly string[], item: string, target: string, side: "before" | "after"): readonly string[] {
  if (item === target || !keys.includes(item) || !keys.includes(target)) return keys;
  const rest = keys.filter((key) => key !== item);
  const at = rest.indexOf(target) + (side === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), item, ...rest.slice(at)];
  return next.every((key, index) => key === keys[index]) ? keys : next;
}

export type TreeRow = { kind: "workspace"; id: string } | { kind: "folder" | "repo"; cwd: string; worktrees: string[] };

/**
 * herdr's tree for agent host folders: a linked worktree's folder sits under its repository's
 * (`repoOf`, the host's project). A repository whose own folder is not open gets a header row,
 * where its first worktree stood, as herdr shows a group when only its worktrees are open.
 */
export function folderTree(rows: readonly MergedRow[], repoOf: (cwd: string) => string | undefined): TreeRow[] {
  const open = new Set(rows.flatMap((row) => row.kind === "folder" ? [samePath(row.cwd)] : []));
  const under = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "folder") continue;
    const repo = repoOf(row.cwd);
    if (repo !== undefined && samePath(repo) !== samePath(row.cwd)) under.set(samePath(repo), [...under.get(samePath(repo)) ?? [], row.cwd]);
  }
  const tree: TreeRow[] = [];
  const headed = new Set<string>();
  for (const row of rows) {
    if (row.kind === "workspace") { tree.push(row); continue; }
    const repo = repoOf(row.cwd);
    const key = repo !== undefined && samePath(repo) !== samePath(row.cwd) ? samePath(repo) : null;
    if (key === null) { tree.push({ kind: "folder", cwd: row.cwd, worktrees: under.get(samePath(row.cwd)) ?? [] }); continue; }
    if (open.has(key) || headed.has(key)) continue;
    headed.add(key);
    tree.push({ kind: "repo", cwd: repo!, worktrees: under.get(key)! });
  }
  return tree;
}

/**
 * `block` (a row and the worktrees under it) put before or after `target` in the saved keys; a
 * target with worktrees under it (`targetBlock`) is passed whole, so a row dropped after it lands
 * after them. The same keys when nothing moves.
 */
export function moveBlock(keys: readonly string[], block: readonly string[], target: string, side: "before" | "after", targetBlock: readonly string[] = [target]): readonly string[] {
  if (block.includes(target)) return keys;
  const moving = new Set(block);
  const rest = keys.filter((key) => !moving.has(key));
  const edge = side === "after" ? targetBlock.filter((key) => rest.includes(key)).at(-1) ?? target : target;
  const at = rest.indexOf(edge);
  if (at < 0) return keys;
  const placed = block.filter((key) => keys.includes(key));
  const next = [...rest.slice(0, at + (side === "after" ? 1 : 0)), ...placed, ...rest.slice(at + (side === "after" ? 1 : 0))];
  return next.length === keys.length && next.every((key, index) => key === keys[index]) ? keys : next;
}

/**
 * The PC's saved sidebar order set; the same state when it already is that, or when nothing is saved
 * for the PC yet (an order alone would stand for "seeded" and keep its first workspaces from opening).
 */
export function withOrder(stored: HostWorkspaceState, machineId: string, order: readonly string[]): HostWorkspaceState {
  const was = stored[machineId];
  if (was === undefined) return stored;
  if (was.order && was.order.length === order.length && was.order.every((key, index) => key === order[index])) return stored;
  return { ...stored, [machineId]: { ...was, order: [...order] } };
}

const STORAGE_KEY = "herdr-web-ui:host-workspaces";

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function load(): HostWorkspaceState {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value ? sanitizeHostWorkspaces(JSON.parse(value)) ?? {} : {};
  } catch { return {}; }
}

/**
 * The open host workspaces this page holds, for the sidebar and the tab strip and for the sync with
 * the other browsers (lib/preferencesSync.ts): set here, they are saved and every reader hears it.
 */
let state: HostWorkspaceState | null = null;
const listeners = new Set<() => void>();

export function currentHostWorkspaces(): HostWorkspaceState {
  state ??= load();
  return state;
}

export function setHostWorkspaces(wanted: HostWorkspaceState): void {
  // kept to what the server takes, so a long day of opened tabs never blocks the preferences' sync
  const next = fitHostWorkspaces(wanted);
  if (JSON.stringify(next) === JSON.stringify(currentHostWorkspaces())) return;
  state = next;
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch { /* storage denied: they last for the session */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeHostWorkspaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
