/**
 * A big chat's cache in the chat lists (ZAC-260 phase 1): the sidebar's ring around the agent mark
 * (owner's pick A) and All agents' "· 268K · 12m left" (pick B), and the Going cold order. One costs
 * feed for the page (every PC's /host-chats/costs and the prices), shared by the sidebar, All agents
 * and the costs chip, so opening a list asks nothing new and every view tells the same story.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { cacheModel, coldRestartUsd, isBigChat } from "../../shared/cache-cost.ts";
import { fetchModelPrices, type ChatPrices } from "./api.ts";
import { fetchHostCosts, onHostChatResume, onHostChatRows } from "./hostChats.ts";
import { cacheState, type CacheState, keptCacheState, type KeptWarm, renewedAt } from "./sessionCost.ts";

/** How often the feed asks again while a list is shown (plan, ZAC-260): costs move by the call, not by the second. */
export const COSTS_REFRESH_MS = 5 * 60_000;

/** Every PC's last costs answer (null: a bridge before costs; a PC not answered yet or down has none) and the prices. */
export interface CostsFeed { answers: ReadonlyMap<string, HostCostsAnswer | null>; prices: ChatPrices | null }

const EMPTY: CostsFeed = { answers: new Map(), prices: null };

/** How long the feed waits after a PC's list changed before it asks that PC (a turn ends in a burst of pushes). */
export const COSTS_CHANGE_DEBOUNCE_MS = 3_000;

/** What moves the feed besides its timer: the page shown again or the event stream reopened, and a PC's rows read anew. */
export interface CostsFeedEvents {
  resume(listener: () => void): () => void;
  rows(listener: (machineId: string, rows: readonly HostChatRow[]) => void): () => void;
}

const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/** what of a PC's rows says a call may have happened: a row's last change and its status */
const rowsKey = (rows: readonly HostChatRow[]): string => rows.map((row) => `${row.session}\t${row.modified_at}\t${row.status}`).sort().join("\n");

/**
 * The page's costs feed, outside React: `want(ids)` registers a list's PCs and returns its release;
 * while anything is wanted and the page is shown it asks each PC every COSTS_REFRESH_MS. `ask()`
 * asks at once (a sheet opening). `fetchers` and `events` are swapped by a test.
 *
 * Kept in step without a reload (ZAC-260 phase 1b: the owner restarted the app for fresh minutes
 * left): while anything is wanted it asks every wanted PC at once when the page is shown again or
 * the event stream reopens (onHostChatResume), and a PC whose rows changed (a row's modified_at or
 * status: a turn ended, a chat started asking) COSTS_CHANGE_DEBOUNCE_MS after the last change, one
 * request in flight per PC (a change meanwhile asks once more when it lands). Never while hidden.
 */
export function createCostsFeed(
  fetchers: { costs: (machineId: string) => Promise<HostCostsAnswer | null>; prices: () => Promise<ChatPrices> } = { costs: fetchHostCosts, prices: fetchModelPrices },
  events: CostsFeedEvents = { resume: onHostChatResume, rows: onHostChatRows },
  debounceMs = COSTS_CHANGE_DEBOUNCE_MS,
) {
  let feed = EMPTY;
  const wants = new Map<number, readonly string[]>();
  let nextId = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stops: (() => void)[] = [];
  const listeners = new Set<() => void>();
  /** per PC: a request in flight, and whether another was asked for meanwhile */
  const flying = new Map<string, boolean>();
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  const seen = new Map<string, string>();
  const emit = (next: CostsFeed): void => { feed = next; for (const listener of listeners) listener(); };
  const ids = (): string[] => [...new Set([...wants.values()].flat())];
  /** bumped by reset(): a request from before it neither lands nor holds its PC's slot */
  let epoch = 0;
  const askPc = (machineId: string): void => {
    if (flying.has(machineId)) { flying.set(machineId, true); return; }
    flying.set(machineId, false);
    const mine = epoch;
    const landed = (): void => {
      if (mine !== epoch) return;
      const again = flying.get(machineId); flying.delete(machineId);
      if (again && wants.size > 0) askPc(machineId);
    };
    // a down host keeps what it said last, and says nothing until it answers
    void fetchers.costs(machineId).then((answer) => {
      if (mine === epoch) emit({ ...feed, answers: new Map(feed.answers).set(machineId, mergeNoted(answer, feed.answers.get(machineId)?.chats ?? [])) });
      landed();
    }, landed);
  };
  const ask = (only?: readonly string[]): void => {
    void fetchers.prices().then((prices) => emit({ ...feed, prices }));
    for (const machineId of only ?? ids()) askPc(machineId);
  };
  const changed = (machineId: string, rows: readonly HostChatRow[]): void => {
    const key = rowsKey(rows);
    const before = seen.get(machineId);
    seen.set(machineId, key);
    // the first rows read are what want() asked about; a PC no list wants is not asked
    if (before === undefined || before === key || !ids().includes(machineId) || hidden()) return;
    clearTimeout(debounce.get(machineId));
    debounce.set(machineId, setTimeout(() => { debounce.delete(machineId); if (wants.size > 0 && !hidden()) askPc(machineId); }, debounceMs));
  };
  const sync = (): void => {
    if (wants.size > 0 && timer === null) {
      timer = setInterval(() => { if (!hidden()) ask(); }, COSTS_REFRESH_MS);
      stops = [events.resume(() => { if (!hidden()) ask(); }), events.rows(changed)];
    } else if (wants.size === 0 && timer !== null) {
      clearInterval(timer); timer = null;
      for (const stop of stops) stop();
      stops = [];
      for (const each of debounce.values()) clearTimeout(each);
      debounce.clear();
    }
  };
  return {
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: (): CostsFeed => feed,
    /** a list's PCs: asked now for the ones not answered yet, then with the rest on the timer */
    want(machineIds: readonly string[]): () => void {
      const id = nextId++;
      wants.set(id, machineIds);
      const fresh = machineIds.filter((machineId) => !feed.answers.has(machineId));
      if (fresh.length > 0 || feed.prices === null) ask(fresh);
      sync();
      return () => { wants.delete(id); sync(); };
    },
    ask: (): void => ask(),
    /**
     * The open chat's own log (useChatCostLog), asked as its turn ends: it replaces the feed's
     * entry for that chat when its last call is newer, so the row and the chat screen say the same.
     */
    note(machineId: string, log: HostChatCost): void {
      const answer = feed.answers.get(machineId);
      if (!answer) return;
      const merged = mergeNoted(answer, [log]);
      if (merged !== answer) emit({ ...feed, answers: new Map(feed.answers).set(machineId, merged) });
    },
    /** forget every answer (costs tracking turned off) */
    reset: (): void => { epoch += 1; flying.clear(); seen.clear(); emit(EMPTY); },
  };
}

/** The log whose last call is newer (the open chat's own, the feed's): either when only one is known. */
export function newerLog(a: HostChatCost | null | undefined, b: HostChatCost | null | undefined): HostChatCost | null | undefined {
  if (!a || !b) return a ?? b;
  const at = (log: HostChatCost): number => { const value = Date.parse(log.lastCallAt ?? ""); return Number.isFinite(value) ? value : -Infinity; };
  return at(b) > at(a) ? b : a;
}

/**
 * `answer` with each chat replaced by the one in `newer` whose last call is newer (a chat screen's
 * own log, noted after the PC answered); a chat the answer does not list is not added. The same
 * object when nothing moves.
 */
function mergeNoted(answer: HostCostsAnswer | null, newer: readonly HostChatCost[]): HostCostsAnswer | null {
  if (answer === null || newer.length === 0) return answer;
  let moved = false;
  const chats = answer.chats.map((chat): HostChatCost => {
    const other = newer.find((each) => each.session === chat.session);
    const pick = newerLog(chat, other);
    if (pick && pick !== chat) { moved = true; return pick; }
    return chat;
  });
  return moved ? { ...answer, chats } : answer;
}

export const costsFeed = createCostsFeed();

/** The page's costs feed as it stands, without asking for anything (the chat screen, against its own log). */
export function useCostsFeedRead(on: boolean): CostsFeed | null {
  const feed = useSyncExternalStore(costsFeed.subscribe, costsFeed.read, costsFeed.read);
  return on ? feed : null;
}

/** The page's costs feed for these PCs while `on` (costs tracked): null while off. */
export function useCostsFeed(machineIds: readonly string[], on: boolean): CostsFeed | null {
  const key = machineIds.join("\n");
  useEffect(() => {
    if (!on) return;
    return costsFeed.want(key === "" ? [] : key.split("\n"));
  }, [key, on]);
  const feed = useSyncExternalStore(costsFeed.subscribe, costsFeed.read, costsFeed.read);
  return on ? feed : null;
}

/** A PC's log of one chat from the feed: undefined when it has none (or has not answered). */
export function chatLog(feed: CostsFeed | null, machineId: string, session: string): HostChatCost | undefined {
  return feed?.answers.get(machineId)?.chats.find((chat) => chat.session === session);
}

/** What a list row shows of a big chat's cache: its state, minutes left, its share of the lifetime left and its size. */
export interface RowCacheMark {
  state: CacheState; leftMin: number; ageMin: number; fraction: number; context: number; restartUsd: number;
  /** OmniRoute's keep-warm plugin keeps it warm (ZAC-260 phase 2): the ring stays green, with a flame, draining from the last ping (ZAC-266) */
  kept?: boolean;
}

/**
 * A row's cache mark (ZAC-260): only for a big chat (its cold restart costs at least the threshold;
 * an unpriced or local one never is) that is not working (one asking waits on the owner: its cache drains), whose log has a last call.
 * `fraction` drains from 1 right after the last call to 0 at expiry (0 when cold).
 */
export function rowCacheMark(
  row: Pick<HostChatRow, "status">, log: HostChatCost | undefined, prices: ChatPrices | null,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number }, now: number, kept: KeptWarm | null = null,
): RowCacheMark | null {
  // only a working chat keeps its cache warm: one that asks waits on the owner and calls nothing
  if (!log || !prices || row.status === "working") return null;
  const context = log.context ?? 0;
  const restartUsd = coldRestartUsd(context, cacheModel(log), prices.prices ?? {}, prices.fallback);
  if (restartUsd === null || !isBigChat(restartUsd, settings.coldRestartAlertUsd)) return null;
  const lifetime = settings.cacheLifetimeMin * 60_000;
  // kept warm (ZAC-266): warm, draining from its last renewal (a call or a ping); the next ping refills it
  if (kept) {
    const at = renewedAt(log.lastCallAt, kept);
    const cache = keptCacheState(log.lastCallAt, kept, now, settings.cacheLifetimeMin);
    if (at === null || !cache) return null;
    return { ...cache, fraction: Math.max(0, Math.min(1, 1 - (now - at) / lifetime)), context, restartUsd, kept: true };
  }
  const cache = cacheState(log.lastCallAt, now, settings.cacheLifetimeMin, false);
  if (!cache) return null;
  const lastAt = Date.parse(log.lastCallAt!);
  const fraction = cache.state === "cold" ? 0 : Math.max(0, Math.min(1, 1 - (now - lastAt) / lifetime));
  return { ...cache, fraction, context, restartUsd };
}

/**
 * All agents' Going cold order (owner, ZAC-260): the big chats not yet cold, least time left first,
 * then the cold big ones by their last call, newest first, then every other chat as Recent (by
 * when it last changed). Busy chats carry no mark, so they fall with the rest.
 */
export function byGoingCold(rows: readonly HostChatRow[], marks: ReadonlyMap<string, RowCacheMark>, logs: ReadonlyMap<string, HostChatCost>): HostChatRow[] {
  const modified = (row: HostChatRow): number => { const at = Date.parse(row.modified_at); return Number.isFinite(at) ? at : 0; };
  const lastCall = (row: HostChatRow): number => { const at = Date.parse(logs.get(row.session)?.lastCallAt ?? ""); return Number.isFinite(at) ? at : 0; };
  const rank = (row: HostChatRow): number => { const mark = marks.get(row.session); return !mark ? 2 : mark.state === "cold" ? 1 : 0; };
  return [...rows].sort((a, b) => {
    const tier = rank(a) - rank(b);
    if (tier !== 0) return tier;
    if (rank(a) === 0) return marks.get(a.session)!.leftMin - marks.get(b.session)!.leftMin || lastCall(a) - lastCall(b);
    if (rank(a) === 1) return lastCall(b) - lastCall(a);
    return modified(b) - modified(a);
  });
}
