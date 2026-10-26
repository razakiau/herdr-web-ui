/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in that PC's own Activity order when Settings asks
 * for it (lib/sidebarOrder.ts). A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { attentionRank } from "./agentNow.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { hostChatPinKey, sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";
import { agentsListHostChats } from "./hostPlacement.ts";
import type { HostPc } from "./hostChats.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts each PC's rows by that PC's own counters */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/**
 * How many rows the Agents list holds (the Agents tab's number, owner ZAC-233): every PC's herdr agents
 * and the host chats the list shows (AgentSidebar: working, asking, unread or pinned), whatever their status.
 */
export function agentListCount(machines: readonly Machine[], hostChats: ReadonlyMap<string, Pick<HostPc, "chats">>, pinned: readonly string[]): number {
  return machines.reduce((sum, machine) => sum + sidebarAgents(machine.snapshot).length
    + agentsListHostChats(hostChats.get(machine.id)?.chats ?? [], (session) => pinned.includes(hostChatPinKey(machine.id, session))).length, 0);
}

/** Every PC's agent rows as the list draws them: the pinned ones first, then the rest in source order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}

/**
 * Rows in the Agents list's groups (lib/agentNow.ts attentionRank): what needs you first, then what
 * works, then an unread finish, then the rest; each group keeps the order it was given (Workspaces or
 * Activity). `status` is the shown one, so a finish already read ranks with the rest.
 */
export function byAttention<T>(rows: readonly T[], status: (row: T) => AgentStatus | undefined): T[] {
  return rows.map((row, index) => ({ row, index, rank: attentionRank(status(row)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((each) => each.row);
}

/**
 * The Agents lens's order (Settings → Agents order, owner ZAC-233): the status groups first (byAttention),
 * then inside each group either the latest change on top (`latest`; a row with no time goes last) or the PCs
 * in their listed order, each PC's rows as given. Herdr agents and host chats sort alike, so the setting
 * moves every row, not only herdr's.
 */
export function lensOrder<T>(rows: readonly T[], how: { status(row: T): AgentStatus | undefined; pc(row: T): number; at(row: T): number | undefined; latest: boolean }): T[] {
  return rows.map((row, index) => ({ row, index, rank: attentionRank(how.status(row)), pc: how.pc(row), at: how.at(row) ?? -Infinity }))
    .sort((a, b) => a.rank - b.rank || (how.latest ? b.at - a.at : a.pc - b.pc) || a.index - b.index)
    .map((each) => each.row);
}

/** How many rows that need you or work the list shows before "Show all" (the owner's pick, 2026-10-25). */
export const ACTIVE_CAP = 8;

/**
 * The Agents list with many agents (the owner, 2026-10-25): what needs you, works or finished unread stays;
 * idle, read and away rows fold into "N resting"; past ACTIVE_CAP of the asking and working ones the rest
 * wait behind "Show all" (`hidden` counts them). Rows come in byAttention order, so asks are the last cut.
 * The selected row is always shown, where it stands.
 */
export function restingSplit<T>(rows: readonly T[], status: (row: T) => AgentStatus | undefined, selected: (row: T) => boolean, all: boolean): { shown: T[]; resting: T[]; hidden: number } {
  const shown: T[] = [];
  const resting: T[] = [];
  let active = 0;
  let hidden = 0;
  for (const row of rows) {
    const rank = attentionRank(status(row));
    if (rank <= 1) {
      active += 1;
      if (all || active <= ACTIVE_CAP || selected(row)) shown.push(row);
      else hidden += 1;
    } else if (rank === 2 || selected(row)) shown.push(row);
    else resting.push(row);
  }
  return { shown, resting, hidden };
}
