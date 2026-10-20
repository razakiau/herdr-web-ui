/**
 * How "All agents on <PC>…" sorts a PC's host chats: a pill per folder to narrow them, and the
 * chats under VS Code's session-list ages (Today, Yesterday, Last 7 days, Last 30 days, Older),
 * counted by calendar day in the phone's own time zone.
 */
import type { HostChatRow } from "../../shared/host-chats.ts";

export type ChatAge = "today" | "yesterday" | "week" | "month" | "older";
const AGES: readonly ChatAge[] = ["today", "yesterday", "week", "month", "older"];

const modified = (row: HostChatRow): number => {
  const at = Date.parse(row.modified_at);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** A folder as the list keys it: no trailing slash. */
export const folderKey = (cwd: string | null): string | null => (cwd ? cwd.replace(/(.)\/$/, "$1") : null);

const dayStart = (time: number): number => { const day = new Date(time); day.setHours(0, 0, 0, 0); return day.getTime(); };
/** whole calendar days between `time` and `now` (0: today) */
export const daysBack = (time: number, now: number): number => Math.round((dayStart(now) - dayStart(time)) / 86_400_000);

function ageOf(row: HostChatRow, now: number): ChatAge {
  // an unreadable time is -Infinity: NaN days, which every test below fails, so Older
  const days = daysBack(modified(row), now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "older";
}

/** The chats by age, newest first within each; an age with no chat is left out. */
export function byAge(rows: readonly HostChatRow[], now: number): { age: ChatAge; chats: HostChatRow[] }[] {
  const sorted = [...rows].sort((a, b) => modified(b) - modified(a));
  return AGES.map((age) => ({ age, chats: sorted.filter((row) => ageOf(row, now) === age) })).filter((group) => group.chats.length > 0);
}

/** The folders the chats are in, the most recently active first, chats without a folder last. */
export function folderPills(rows: readonly HostChatRow[]): { cwd: string | null; count: number }[] {
  const folders = new Map<string | null, { cwd: string | null; count: number; newest: number }>();
  for (const row of rows) {
    const cwd = folderKey(row.cwd);
    const folder = folders.get(cwd) ?? { cwd, count: 0, newest: Number.NEGATIVE_INFINITY };
    folder.count += 1;
    folder.newest = Math.max(folder.newest, modified(row));
    folders.set(cwd, folder);
  }
  return [...folders.values()]
    .sort((a, b) => (a.cwd === null ? 1 : 0) - (b.cwd === null ? 1 : 0) || b.newest - a.newest)
    .map(({ cwd, count }) => ({ cwd, count }));
}
