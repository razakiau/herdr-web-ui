/**
 * Chat groups (ZAC-265): how a group's chats are doing, in the rows' own words and marks. Each
 * member's state is what its sidebar / All agents row draws (lib/hostPlacement.ts hostChatStatus,
 * lib/rowCache.ts rowCacheMark with keep-warm), and the group's summary counts them: the Agents
 * head's status counts (AgentSidebar.tsx agentsSummary, SummaryMarks), then how many caches are
 * warm or cooling in All agents' cache colours (AllAgentsSheet.css .all-agents-cache). A part that
 * is zero is left out; all idle and cold says nothing.
 */
import type { ReactElement } from "react";
import { Flame, Timer } from "lucide-react";

import "./AgentSidebar.css";
import "./AllAgentsSheet.css";

import type { HostChatCost, HostChatRow } from "../../shared/host-chats.ts";
import type { KeepWarmAnswer } from "../../shared/keep-warm.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { ChatGroup } from "../../shared/groups.ts";
import type { ChatPrices } from "../lib/api.ts";
import { chatKey } from "../lib/groups.ts";
import { useMinuteClock } from "../lib/hostChats.ts";
import { useT } from "../lib/i18n.ts";
import { keepWarmFor, keptWarmOf, useKeepWarm } from "../lib/keepWarm.ts";
import { hostChatStatus } from "../lib/hostPlacement.ts";
import { chatLog, rowCacheMark, type CostsFeed, type RowCacheMark } from "../lib/rowCache.ts";
import { useSettings } from "../lib/settings.ts";
import { agentsSummary, SummaryMarks } from "./AgentSidebar.tsx";

/** A member as its row draws it: its status glyph's state and its cache mark (null: none). */
export interface MemberState { status: AgentStatus | undefined; mark: RowCacheMark | null }

/** The row's state as the sidebar's: the glyph from the chat's status, the mark from its log, the prices and keep-warm. */
export function memberState(row: HostChatRow | undefined, log: HostChatCost | undefined, prices: ChatPrices | null, keepWarm: KeepWarmAnswer | null,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number }, now: number): MemberState {
  if (!row) return { status: undefined, mark: null };
  const mark = prices ? rowCacheMark(row, log, prices, settings, now, keptWarmOf(keepWarmFor(keepWarm, log, now))) : null;
  return { status: hostChatStatus(row), mark };
}

/**
 * Each member's state by chatKey, from the page's costs feed (the one the sidebar and All agents
 * read) and keep-warm, ticking by the minute as the rows do. Also what each needs to draw its row.
 */
export function useMemberStates(group: ChatGroup, rows: ReadonlyMap<string, HostChatRow>, feed: CostsFeed | null): {
  states: Map<string, MemberState>; logs: Map<string, HostChatCost>; keepWarm: KeepWarmAnswer | null; now: number;
} {
  const { settings } = useSettings();
  const now = useMinuteClock();
  const keepWarm = useKeepWarm(settings.trackCosts);
  const states = new Map<string, MemberState>();
  const logs = new Map<string, HostChatCost>();
  for (const member of group.members) {
    const key = chatKey(member.pc, member.session);
    const log = chatLog(feed, member.pc, member.session);
    if (log) logs.set(key, log);
    states.set(key, memberState(rows.get(key), log, feed?.prices ?? null, keepWarm, settings, now));
  }
  return { states, logs, keepWarm, now };
}

/** How many caches are warm (kept warm too) and cooling. */
export function cacheCounts(states: readonly MemberState[]): { warm: number; cooling: number; kept: number } {
  let warm = 0, cooling = 0, kept = 0;
  for (const { mark } of states) {
    if (!mark) continue;
    if (mark.kept) { warm += 1; kept += 1; } else if (mark.state === "warm") warm += 1;
    else if (mark.state === "cooling") cooling += 1;
  }
  return { warm, cooling, kept };
}

/** Whether the summary has anything to say: a status count or a cache not cold. */
export function hasGroupState(states: readonly MemberState[]): boolean {
  const caches = cacheCounts(states);
  return caches.warm + caches.cooling > 0 || states.some((state) => state.status === "blocked" || state.status === "working" || state.status === "done");
}

/**
 * "1 working · 2 warm": the status counts behind the rows' own marks, then the caches in their
 * colours (a flame when one is kept warm, as on its row). Nothing when all are idle and cold.
 */
export function GroupStateSummary({ states, className = "" }: { states: readonly MemberState[]; className?: string }) {
  const t = useT();
  const parts = agentsSummary(states.map((state) => state.status), t);
  const caches = cacheCounts(states);
  if (parts.length === 0 && caches.warm + caches.cooling === 0) return null;
  const cache: ReactElement[] = [];
  if (caches.warm > 0) cache.push(<span key="warm" className={`all-agents-cache is-warm${caches.kept > 0 ? " is-kept" : ""}`}>
    {caches.kept > 0 && <Flame aria-hidden="true" />}<span className="agent-summary-long">{t("{n} warm", { n: caches.warm })}</span>
    <span className="agent-summary-short" aria-hidden="true">{caches.kept > 0 ? caches.warm : t("{n} warm", { n: caches.warm })}</span></span>);
  // a narrow bar keeps the timer and the number (as the Agents head keeps the mark and the number); the words stay for a screen reader
  if (caches.cooling > 0) cache.push(<span key="cooling" className="all-agents-cache is-cooling" title={t("{n} cooling", { n: caches.cooling })}><Timer aria-hidden="true" />
    <span className="agent-summary-long">{t("{n} cooling", { n: caches.cooling })}</span><span className="agent-summary-short" aria-hidden="true">{caches.cooling}</span></span>);
  return <span className={`group-state ${className}`.trim()}>
    {parts.length > 0 && <span className="group-state-status"><SummaryMarks parts={parts} /></span>}
    {cache.flatMap((each, index) => index === 0 && parts.length === 0 ? [each] : [<span key={`sep-${index}`} className="group-state-sep" aria-hidden="true">·</span>, each])}
  </span>;
}
