/**
 * Chat groups (ZAC-265 PR 2), the digest's sums for its card (DigestCard.tsx): how many chats moved
 * on since it was written, its facts line ("3 issues open · 2 PRs in review"), its per-chat lines in
 * weeks past ~20 chats, and its estimate's words. Pure: the page passes what the server and the
 * costs feed know.
 */
import type { DigestEstimate, GroupDigest, GroupMember } from "../../shared/groups.ts";
import type { HostArtifact } from "../../shared/host-chats.ts";
import type { ReferenceState } from "./artifacts.ts";
import { chatKey } from "./groups.ts";

/**
 * Members that moved on since the digest (spec §3 Honesty): a chat with a model call newer than the
 * digest, a chat that joined after it, and a chat it saw that has since left.
 * `lastCalls` is each chat's `lastCallAt` by chatKey, from the costs feed.
 */
export function staleCount(digest: GroupDigest, members: readonly GroupMember[], lastCalls: ReadonlyMap<string, string>): number {
  const written = Date.parse(digest.writtenAt);
  const seen = new Set(digest.chatsSeen);
  const now = new Set(members.map((member) => chatKey(member.pc, member.session)));
  let moved = 0;
  for (const key of now) {
    if (!seen.has(key)) { moved += 1; continue; }
    const last = Date.parse(lastCalls.get(key) ?? "");
    if (Number.isFinite(last) && last > written) moved += 1;
  }
  for (const key of seen) if (!now.has(key)) moved += 1;
  return moved;
}

/** A PR still to land: open or a draft, or one GitHub flags. */
const prOpen = (state: ReferenceState | undefined): boolean => state === "open" || state === "draft" || state === "attention" || state === undefined || state === "unknown";
/** An issue still open. */
const issueOpen = (state: ReferenceState | undefined): boolean => state === "open" || state === undefined || state === "unknown";

/**
 * The card's facts from the digest's Still open items: open issues and PRs in review (open, draft
 * or flagged) from their own artifacts and live states, and the threads still waiting (an item with
 * no artifact: something an agent meant to do). A PR merged or an issue closed since no longer counts.
 */
export function digestFacts(digest: GroupDigest, states: Readonly<Record<string, ReferenceState>>): { issues: number; prs: number; threads: number } {
  const seen = new Set<string>();
  let issues = 0;
  let prs = 0;
  let threads = 0;
  for (const item of digest.open) {
    const artifact = item.artifact;
    if (!artifact) { threads += 1; continue; }
    const key = artifact.link ?? artifact.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = artifact.link ? states[artifact.link] : undefined;
    if (artifact.type === "issue" && issueOpen(state)) issues += 1;
    if (artifact.type === "pullRequest" && prOpen(state)) prs += 1;
  }
  return { issues, prs, threads };
}

/** Every artifact the digest links, for one state read. */
export function digestArtifacts(digest: GroupDigest | null): HostArtifact[] {
  if (!digest) return [];
  return [...digest.open, ...digest.done].flatMap((item) => item.artifact ? [item.artifact] : []);
}

/** Past this many chats, Per chat folds into a line per week (spec §3). */
export const PER_CHAT_WEEKS_FROM = 20;

export interface PerChatLine { pc: string; session: string; line: string; at: number }
export interface PerChatWeek<L extends PerChatLine = PerChatLine> { start: number; lines: L[] }

/** Monday 00:00 of `at`'s week, local time. */
function weekStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/** Per chat newest first, by week (newest first) once there are more than PER_CHAT_WEEKS_FROM. */
export function perChatWeeks<L extends PerChatLine>(lines: readonly L[]): PerChatWeek<L>[] | null {
  if (lines.length <= PER_CHAT_WEEKS_FROM) return null;
  const weeks = new Map<number, L[]>();
  for (const line of [...lines].sort((a, b) => b.at - a.at)) {
    const start = weekStart(line.at);
    weeks.set(start, [...weeks.get(start) ?? [], line]);
  }
  return [...weeks].map(([start, each]) => ({ start, lines: each }));
}

/** A digest's cost as the card says it: tenths of a cent where a refresh costs that little. */
export function digestUsd(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** The estimate's numbers, apart from its words: "≈ $0.003", "~38K". */
export function estimateParts(estimate: DigestEstimate): { usd: string | null; tokens: string } {
  const k = estimate.tokensIn >= 1_000_000 ? `${(estimate.tokensIn / 1_000_000).toFixed(1)}M` : estimate.tokensIn >= 1000 ? `${Math.round(estimate.tokensIn / 1000)}K` : String(estimate.tokensIn);
  // a model with no price: the tokens still say how big the run is
  return { usd: estimate.usd === null ? null : `≈ ${digestUsd(estimate.usd)}`, tokens: `~${k}` };
}
