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
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts each PC's rows by that PC's own counters */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
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
