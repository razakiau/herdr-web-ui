/**
 * Where each host chat of a PC goes in the sidebar (spec §1, §1b; "Agent host workspaces"). A host
 * chat is a Copilot agent: a tab of the herdr workspace one of whose panes works in its folder,
 * else a tab of its folder's agent host workspace. Only the chats the user opened as tabs are
 * placed, in the workspaces the user opened (lib/hostWorkspaces.ts), plus the one on screen while
 * it is a look; the rest wait in Agents and "All agents on <PC>…". The Agents list keeps the ones
 * that want a look, and with many PCs the ones not in use fold under "Other PCs".
 */
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { PcHostWorkspaces } from "../../shared/host-workspaces.ts";
import type { Machine } from "../../shared/machines.ts";
import type { Translate } from "./i18n.ts";

export interface HostPlacement {
  /** by workspace_id: its host chats in strip order, drawn after its panes' tabs */
  tabs: Map<string, HostChatRow[]>;
  /**
   * the open agent host workspaces no herdr workspace works in, in the order opened, each a row
   * whose tabs are its open chats; `look` when the row stands only for the chat on screen
   */
  folders: { cwd: string; chats: HostChatRow[]; look: boolean }[];
  /** the chats left out: not a tab, archived, or without a folder */
  hidden: number;
}

/** A folder as the comparison sees it: one trailing slash dropped (the root stays `/`); case and the rest kept. */
export function samePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Working or waiting on an answer. */
export const isLive = (row: HostChatRow): boolean => row.status === "working" || row.status === "asks";

/**
 * One PC's chats placed: each open workspace's tabs, in strip order, and `look` (the chat on
 * screen) in its folder whether or not that is open; archived ones never. Each goes to the first
 * herdr workspace whose panes' cwds hold its folder exactly, else to its folder's row.
 */
export function placeHostChats(rows: HostChatRow[], workspaces: { workspace_id: string; cwds: string[] }[], open: PcHostWorkspaces | undefined, look: string | null): HostPlacement {
  const bySession = new Map(rows.filter((row) => !row.archived && row.cwd).map((row) => [row.session, row]));
  const owner = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const cwd of workspace.cwds) if (!owner.has(samePath(cwd))) owner.set(samePath(cwd), workspace.workspace_id);
  }
  const tabs = new Map<string, HostChatRow[]>();
  const folders = new Map<string, { cwd: string; chats: HostChatRow[]; look: boolean }>();
  const placed = new Set<string>();
  const place = (folder: string, row: HostChatRow, asLook: boolean) => {
    if (placed.has(row.session)) return;
    placed.add(row.session);
    const workspace = owner.get(folder);
    if (workspace !== undefined) { tabs.set(workspace, [...tabs.get(workspace) ?? [], row]); return; }
    const group = folders.get(folder);
    if (group) group.chats.push(row);
    else folders.set(folder, { cwd: folder, chats: [row], look: asLook });
  };
  for (const workspace of open?.open ?? []) {
    const folder = samePath(workspace.cwd);
    for (const session of workspace.tabs) {
      const row = bySession.get(session);
      if (row && samePath(row.cwd!) === folder) place(folder, row, false);
    }
  }
  const shown = look === null ? undefined : bySession.get(look);
  if (shown) place(samePath(shown.cwd!), shown, true);
  return { tabs, folders: [...folders.values()], hidden: rows.length - placed.size };
}

/** The host chats the Agents list shows: working, asking, unread (finished and not opened since) or pinned; never archived. */
export function agentsListHostChats(rows: HostChatRow[], pinned: (s: string) => boolean): HostChatRow[] {
  return rows.filter((row) => !row.archived && (isLive(row) || row.unread || pinned(row.session)));
}

/**
 * The PCs the user placed by hand on this device (MachineSidebar.tsx): kept open from Other PCs, or
 * folded from a PC's header. One PC is in one list at most; the latest choice wins.
 */
export interface PcLists { keptOpen: string[]; keptFolded: string[] }

export function openPc(lists: PcLists, id: string): PcLists {
  return { keptOpen: lists.keptOpen.includes(id) ? [...lists.keptOpen] : [...lists.keptOpen, id], keptFolded: lists.keptFolded.filter((each) => each !== id) };
}

export function foldPc(lists: PcLists, id: string): PcLists {
  return { keptOpen: lists.keptOpen.filter((each) => each !== id), keptFolded: lists.keptFolded.includes(id) ? [...lists.keptFolded] : [...lists.keptFolded, id] };
}

/** The kept ids that are still PCs of the roster: a removed PC does not linger in storage */
export function keptPcs(kept: readonly string[], roster: readonly string[]): string[] {
  return kept.filter((id) => roster.includes(id));
}

/** What decides a PC's fold besides being the current one: `active` is an agent working or asking. */
export interface FoldPrefs { active(id: string): boolean; keptOpen: readonly string[]; keptFolded: readonly string[] }

/**
 * The PCs drawn as full groups and the ones under "Other PCs" (owner, 2026-10-25): with one or two
 * PCs none fold. Otherwise the current PC (else the first) is always open, for as long as it is the
 * current one; a PC the user folded stays folded even while its agents work or ask (his choice beats
 * the default, Other PCs then shows the asking); a PC he kept open, or with an agent working or
 * asking, is open; the rest fold. Both lists keep roster order.
 */
export function foldPcs(machines: Machine[], current: string | null, prefs: FoldPrefs): { open: Machine[]; folded: Machine[] } {
  if (machines.length <= 2) return { open: machines, folded: [] };
  const here = machines.some((machine) => machine.id === current) ? current : machines[0]?.id ?? null;
  const open: Machine[] = [];
  const folded: Machine[] = [];
  for (const machine of machines) {
    const id = machine.id;
    const shown = id === here || (!prefs.keptFolded.includes(id) && (prefs.keptOpen.includes(id) || prefs.active(id)));
    (shown ? open : folded).push(machine);
  }
  return { open, folded };
}

/** A snapshot's workspaces with the working directories of their panes, for placeHostChats. */
export function workspaceCwds(snapshot: { workspaces: { workspace_id: string }[]; panes: { workspace_id: string; cwd?: string | null }[] } | null): { workspace_id: string; cwds: string[] }[] {
  return (snapshot?.workspaces ?? []).map((workspace) => ({
    workspace_id: workspace.workspace_id,
    cwds: snapshot!.panes.flatMap((pane) => pane.workspace_id === workspace.workspace_id && pane.cwd ? [pane.cwd] : []),
  }));
}

/**
 * A host chat's state in the words of a pane's (herdr's AgentStatus), so a roll-up counts it like
 * any agent: working, asking ("blocked", the "?"), finished and not looked at ("done"), else idle.
 */
export function hostChatStatus(row: HostChatRow): "working" | "blocked" | "done" | "idle" {
  return row.status === "working" ? "working" : row.status === "asks" ? "blocked" : row.unread ? "done" : "idle";
}

/**
 * One PC's placement as the sidebar and the tab strip draw it: the open workspaces and tabs, and the
 * chat on screen, so one opened from Agents or "All agents on <PC>…" stands as a tab while it is open.
 */
export function pcPlacement(snapshot: Parameters<typeof workspaceCwds>[0], chats: HostChatRow[], open: PcHostWorkspaces | undefined, onScreen: string | null): HostPlacement {
  return placeHostChats(chats, workspaceCwds(snapshot), open, onScreen);
}

/** Where a placed chat stands: its workspace's id, or its folder; null when it is not placed. */
export function hostChatHome(placement: HostPlacement, session: string): { workspace: string } | { folder: string } | null {
  for (const [workspace, rows] of placement.tabs) if (rows.some((row) => row.session === session)) return { workspace };
  const folder = placement.folders.find((group) => group.chats.some((row) => row.session === session));
  return folder ? { folder: folder.cwd } : null;
}

/**
 * What a PC's header says while the search shows it: a PC that is folded when nothing is searched
 * comes up in place with its hits, and says where it otherwise lives.
 */
export function searchPlace(folded: boolean, t: Translate): string | null {
  return folded ? t("In Other PCs") : null;
}
