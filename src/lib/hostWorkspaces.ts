/**
 * The rules of agent host workspaces (shared/host-workspaces.ts): a folder is open because the user
 * opened it, as a herdr workspace is; its tabs are the chats the user opened there. Closing either
 * hides, never archives. Pure: each returns the state it was given when nothing changed, so a
 * caller writes only a change.
 */
import type { HostChatRow } from "../../shared/host-chats.ts";
import { sanitizeHostWorkspaces, type HostWorkspace, type HostWorkspaceState, type PcHostWorkspaces } from "../../shared/host-workspaces.ts";
import { hostChatLive, type HostPc } from "./hostChats.ts";
import { isLive, samePath } from "./hostPlacement.ts";

export { sanitizeHostWorkspaces };
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
 * tabs (the one on screen among them). Everything else starts closed.
 */
export function seedPc(chats: readonly HostChatRow[], pinnedFolders: ReadonlySet<string>, onScreen: string | null): PcHostWorkspaces {
  const pinned = new Set([...pinnedFolders].map(samePath));
  let pc: PcHostWorkspaces = { open: [] };
  for (const row of [...chats].filter(usable).sort((a, b) => modified(b) - modified(a))) {
    const folder = folderOf(row)!;
    if (pinned.has(folder) || isLive(row) || row.session === onScreen) pc = openWorkspace(pc, folder, chats);
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
    if (!usable(row)) continue;
    const cwd = folderOf(row)!;
    const was = folders.get(cwd);
    if (!was) folders.set(cwd, { cwd, chats: 1, modified_at: row.modified_at, open: isOpenFolder(pc, cwd) });
    else folders.set(cwd, { ...was, chats: was.chats + 1, modified_at: modified(row) > Date.parse(was.modified_at) ? row.modified_at : was.modified_at });
  }
  return [...folders.values()].sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at));
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
export function upkeepPc(stored: HostWorkspaceState, machineId: string, read: HostPc | undefined, pinnedFolders: ReadonlySet<string>, onScreen: string | null): HostWorkspaceState {
  if (!hostChatLive(read)) return stored;
  const was = stored[machineId];
  const next = was === undefined ? seedPc(read!.chats, pinnedFolders, onScreen) : prunePc(was, read!.chats, onScreen);
  return next === was ? stored : { ...stored, [machineId]: next };
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

export function setHostWorkspaces(next: HostWorkspaceState): void {
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
