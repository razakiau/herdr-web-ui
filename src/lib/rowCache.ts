/**
 * A big chat's cache in the chat lists (ZAC-260 phase 1): the sidebar's ring around the agent mark
 * (owner's pick A) and All agents' "· 268K · 12m left" (pick B), and the Going cold order. One costs
 * feed for the page (every PC's /host-chats/costs and the prices), shared by the sidebar, All agents
 * and the costs chip, so opening a list asks nothing new and every view tells the same story.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { chatModel, coldRestartUsd, isBigChat } from "../../shared/cache-cost.ts";
import { fetchModelPrices, type ChatPrices } from "./api.ts";
import { fetchHostCosts } from "./hostChats.ts";
import { cacheState, type CacheState } from "./sessionCost.ts";

/** How often the feed asks again while a list is shown (plan, ZAC-260): costs move by the call, not by the second. */
export const COSTS_REFRESH_MS = 5 * 60_000;

/** Every PC's last costs answer (null: a bridge before costs; a PC not answered yet or down has none) and the prices. */
export interface CostsFeed { answers: ReadonlyMap<string, HostCostsAnswer | null>; prices: ChatPrices | null }

const EMPTY: CostsFeed = { answers: new Map(), prices: null };

/**
 * The page's costs feed, outside React: `want(ids)` registers a list's PCs and returns its release;
 * while anything is wanted and the page is shown it asks each PC every COSTS_REFRESH_MS. `ask()`
 * asks at once (a sheet opening). `fetchers` are swapped by a test.
 */
export function createCostsFeed(fetchers: { costs: (machineId: string) => Promise<HostCostsAnswer | null>; prices: () => Promise<ChatPrices> } = { costs: fetchHostCosts, prices: fetchModelPrices }) {
  let feed = EMPTY;
  const wants = new Map<number, readonly string[]>();
  let nextId = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const emit = (next: CostsFeed): void => { feed = next; for (const listener of listeners) listener(); };
  const ids = (): string[] => [...new Set([...wants.values()].flat())];
  const ask = (only?: readonly string[]): void => {
    void fetchers.prices().then((prices) => emit({ ...feed, prices }));
    for (const machineId of only ?? ids()) {
      // a down host keeps what it said last, and says nothing until it answers
      void fetchers.costs(machineId).then((answer) => emit({ ...feed, answers: new Map(feed.answers).set(machineId, answer) }), () => {});
    }
  };
  const sync = (): void => {
    if (wants.size > 0 && timer === null) {
      timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") ask(); }, COSTS_REFRESH_MS);
    } else if (wants.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
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
    /** forget every answer (costs tracking turned off) */
    reset: (): void => emit(EMPTY),
  };
}

export const costsFeed = createCostsFeed();

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
export interface RowCacheMark { state: CacheState; leftMin: number; ageMin: number; fraction: number; context: number; restartUsd: number }

/**
 * A row's cache mark (ZAC-260): only for a big chat (its cold restart costs at least the threshold;
 * an unpriced or local one never is) that is not working or asking, whose log has a last call.
 * `fraction` drains from 1 right after the last call to 0 at expiry (0 when cold).
 */
export function rowCacheMark(
  row: Pick<HostChatRow, "status">, log: HostChatCost | undefined, prices: ChatPrices | null,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number }, now: number,
): RowCacheMark | null {
  if (!log || !prices || row.status === "working" || row.status === "asks") return null;
  const context = log.context ?? 0;
  const restartUsd = coldRestartUsd(context, chatModel(log), prices.prices ?? {}, prices.fallback);
  if (restartUsd === null || !isBigChat(restartUsd, settings.coldRestartAlertUsd)) return null;
  const cache = cacheState(log.lastCallAt, now, settings.cacheLifetimeMin, false);
  if (!cache) return null;
  const lastAt = Date.parse(log.lastCallAt!);
  const fraction = cache.state === "cold" ? 0 : Math.max(0, Math.min(1, 1 - (now - lastAt) / (settings.cacheLifetimeMin * 60_000)));
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
