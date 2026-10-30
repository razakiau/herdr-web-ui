/**
 * The weekly cost digest's snapshot (ZAC-262): built and stored by server/digest.ts, shown as is by
 * the "This week" page (src/components/WeekSheet.tsx). Here so the client reads the type without
 * importing server code.
 */
import type { HostCostModel } from "./host-chats.ts";
import type { KeepWarmToday } from "./keep-warm.ts";
import { formatUsd } from "./model-price.ts";

export type DigestCounts = { restarts: number; firstWrites: number; handoffs: number };
export type DigestKeepWarm = { pings: number; usd: number; avoided: number; avoidedUsd: number };

export interface DigestSnapshot {
  /** the Monday (UTC date) of the week holding the scheduled cut */
  week: string;
  /** what the week counts: from the previous digest's cut (or Monday 00:00 UTC) to `cut` (ms) */
  from: number; cut: number; built: number;
  /** a floor when a model had no price, a log was partly read, or a PC's first scan was not done */
  total: { usd: number; floor: boolean };
  /** each UTC day from `from`'s to `cut`'s: the first one is the previous cut day's rest */
  days: { day: string; usd: number; restartsUsd: number }[];
  /** the 5 costliest chats */
  chats: { machineId: string; session: string; title: string; usd: number; restarts: number }[];
  /** the PCs that spent, costliest first */
  pcs: { machineId: string; name: string; usd: number; chats: number }[];
  /** the PCs whose logs could not be read (disconnected, or a bridge before costs): not counted */
  offline: string[];
  /** the PCs whose bridge has no per-day counts (before ZAC-262): their money counts, their restarts and hand-offs do not */
  noCounts: string[];
  restarts: { n: number; usd: number };
  firstWrites: { n: number; usd: number };
  handoffs: number;
  keepWarm: DigestKeepWarm;
  /** what was counted of the cut day, by `chatKey`: next week counts the rest */
  cutDay: { day: string; perChat: Record<string, HostCostModel[]>; counts: Record<string, DigestCounts>; keepWarm: KeepWarmToday | null };
}

/** The digest's dollars, the notification's and the page's alike: whole from $10 on (a week's sums), cents under */
export const digestUsd = (usd: number): string => Math.abs(usd) >= 9.995 ? `$${Math.round(Math.abs(usd)).toLocaleString("en-US")}` : formatUsd(Math.abs(usd));
