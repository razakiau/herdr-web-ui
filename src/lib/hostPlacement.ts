/**
 * Where each host chat of a PC goes in the sidebar (spec §1, §1b). A host chat is a Copilot agent:
 * a tab of the workspace one of whose panes works in its folder, else a tab of a folder row of its
 * own. Only the recent ones are placed (VS Code's "Recent": 10 from the last 7 days); the rest
 * wait in "All agents on <PC>…". The Agents list keeps the ones that want a look, and with many PCs
 * the ones not in use fold under "Other PCs".
 */
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";

export interface HostPlacement {
  /** by workspace_id: its host chats, newest first, drawn after its panes' tabs */
  tabs: Map<string, HostChatRow[]>;
  /** the folders no workspace works in, each a row whose tabs are its chats; newest chat's folder first */
  folders: { cwd: string; chats: HostChatRow[] }[];
  /** the chats left out: older, archived, over the limit, or without a folder */
  hidden: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_DAYS = 7;
export const RECENT_MAX = 10;

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : 0;
};
const newestFirst = (rows: readonly HostChatRow[]): HostChatRow[] => [...rows].sort((a, b) => modified(b) - modified(a));

/** A folder as the comparison sees it: one trailing slash dropped (the root stays `/`); case and the rest kept. */
export function samePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Working or waiting on an answer. */
export const isLive = (row: HostChatRow): boolean => row.status === "working" || row.status === "asks";

/**
 * One PC's chats placed: live, unread, pinned or changed in the last 7 days, at most 10 (live and
 * pinned are never cut, so they can make more), newest first; archived ones never. Each goes to the
 * first workspace whose panes' cwds hold its folder exactly, else to its folder's row.
 */
export function placeHostChats(rows: HostChatRow[], workspaces: { workspace_id: string; cwds: string[] }[], pinned: (s: string) => boolean, now: number): HostPlacement {
  const since = now - RECENT_DAYS * DAY_MS;
  const candidates = newestFirst(rows).filter((row) => !row.archived && row.cwd !== null && row.cwd !== "");
  const kept = (row: HostChatRow): boolean => isLive(row) || pinned(row.session);
  let room = RECENT_MAX - candidates.filter(kept).length;
  const shown = candidates.filter((row) => {
    if (kept(row)) return true;
    if (room <= 0 || (!row.unread && modified(row) < since)) return false;
    room -= 1;
    return true;
  });
  const owner = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const cwd of workspace.cwds) if (!owner.has(samePath(cwd))) owner.set(samePath(cwd), workspace.workspace_id);
  }
  const tabs = new Map<string, HostChatRow[]>();
  const folders = new Map<string, HostChatRow[]>();
  for (const row of shown) {
    const folder = samePath(row.cwd!);
    const workspace = owner.get(folder);
    if (workspace !== undefined) tabs.set(workspace, [...tabs.get(workspace) ?? [], row]);
    else folders.set(folder, [...folders.get(folder) ?? [], row]);
  }
  return { tabs, folders: [...folders].map(([cwd, chats]) => ({ cwd, chats })), hidden: rows.length - shown.length };
}

/** The host chats the Agents list shows: working, asking, unread (finished and not opened since) or pinned; never archived. */
export function agentsListHostChats(rows: HostChatRow[], pinned: (s: string) => boolean): HostChatRow[] {
  return rows.filter((row) => !row.archived && (isLive(row) || row.unread || pinned(row.session)));
}

/**
 * The PCs drawn as full groups and the ones under "Other PCs": with one or two PCs none fold;
 * otherwise the current PC (else the first) and every PC that needs you stay open, in roster order.
 */
export function foldPcs(machines: Machine[], current: string | null, needsYou: (id: string) => boolean): { open: Machine[]; folded: Machine[] } {
  if (machines.length <= 2) return { open: machines, folded: [] };
  const here = machines.some((machine) => machine.id === current) ? current : machines[0]?.id ?? null;
  const open: Machine[] = [];
  const folded: Machine[] = [];
  for (const machine of machines) (machine.id === here || needsYou(machine.id) ? open : folded).push(machine);
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
 * One PC's placement as the sidebar and the tab strip draw it: its pinned chats are kept, and so is
 * the chat open now, so one opened from "All agents on <PC>…" stands as a tab while it is open.
 */
export function pcPlacement(snapshot: Parameters<typeof workspaceCwds>[0], chats: HostChatRow[], pinned: (session: string) => boolean, open: string | null, now: number): HostPlacement {
  return placeHostChats(chats, workspaceCwds(snapshot), (session) => session === open || pinned(session), now);
}

/** Where a placed chat stands: its workspace's id, or its folder; null when it is not placed. */
export function hostChatHome(placement: HostPlacement, session: string): { workspace: string } | { folder: string } | null {
  for (const [workspace, rows] of placement.tabs) if (rows.some((row) => row.session === session)) return { workspace };
  const folder = placement.folders.find((group) => group.chats.some((row) => row.session === session));
  return folder ? { folder: folder.cwd } : null;
}
