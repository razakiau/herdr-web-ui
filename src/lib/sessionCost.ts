import type { HostChatCost, HostCostsAnswer, HostTokenTotal } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { addSplit, cacheModel, coldRestartUsd, costSplit, type CostSplit, emptySplit, isBigChat, modelLastCall } from "../../shared/cache-cost.ts";

export { addSplit, avgOutput, cacheModel, chatModel, coldRestartUsd, costSplit, type CostSplit, emptySplit, FRESH_CHAT_CONTEXT, freshHandoffUsd, handoffUsd, isBigChat, modelLastCall, nextCall, writePrice } from "../../shared/cache-cost.ts";

export type CacheState = "warm" | "cooling" | "cold";

/** The lifetime's last minutes in which a warm cache reads as cooling (owner, ZAC-260). */
const COOLING_MIN = 15;

/**
 * How warm a chat's prompt cache is, from its main agent's last call (`lastCallAt`): warm, then
 * cooling in the lifetime's last 15 minutes, then cold once the lifetime is over. A chat working
 * right now is warm whatever the age, since its calls keep the cache alive. `ageMin` and `leftMin`
 * are whole minutes, rounded down; null with no call yet.
 */
export function cacheState(lastCallAt: string | null, now: number, lifetimeMin: number, busy: boolean): { state: CacheState; ageMin: number; leftMin: number } | null {
  if (!lastCallAt) return null;
  const at = Date.parse(lastCallAt);
  if (Number.isNaN(at)) return null;
  const age = Math.max(0, now - at) / 60_000;
  const ageMin = Math.floor(age);
  const leftMin = Math.max(0, Math.floor(lifetimeMin - age));
  if (busy) return { state: "warm", ageMin, leftMin };
  const state: CacheState = age >= lifetimeMin ? "cold" : age >= lifetimeMin - COOLING_MIN ? "cooling" : "warm";
  return { state, ageMin, leftMin };
}

/**
 * Whether the chat's model is being called right now, which is what keeps its cache warm (ZAC-260,
 * owner's phone check): a turn running, and not waiting on the owner. A chat that asks (ask_user, a
 * permission) has a turn open (`busy`) but calls nothing while it waits, so its cache drains like
 * an idle one's; the owner's "Needs you" rows had waited 2–3 h, cold, and showed nothing.
 */
export function callingModel(read: { busy: boolean; status?: string }): boolean {
  return read.busy && read.status !== "asks";
}

export type Advice = "keep" | "handoff-warm" | "handoff-cooling" | "handoff-cold";

/**
 * What to do with the chat (the spec's advice table): keep going while a cold restart is cheap
 * (under the threshold in dollars, or unpriced: no guess); a big chat hands off, the cache's state
 * saying how urgent (warm: if work remains, cooling: before it goes cold, cold: a free moment).
 */
export function advice(state: CacheState, big: boolean): Advice {
  return big ? `handoff-${state}` : "keep";
}

/** The prices a chat is weighed with: null until they are in, or a table missing. */
export interface CachePrices { prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null }

/**
 * What the meter and the handoff banner show (ZAC-260): the context's tokens, the live read's
 * (what the meter showed before) else the log's; the cache's state and minutes left from the log's
 * last call; what a cold restart would cost (`restartUsd`, null unpriced) and the advice, a big chat
 * being one whose cold restart costs at least `coldRestartAlertUsd`. `cache` is null without a log
 * (a bridge before costs, or not answered yet): tokens alone, no state, no advice; with no prices
 * yet nothing is big.
 */
export function cacheMeter(
  read: { busy: boolean; status?: string; context?: { currentTokens: number } | null; model?: { id: string } | null },
  log: HostChatCost | null | undefined,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number },
  now: number,
  prices: CachePrices | null,
): { context: number; cache: ReturnType<typeof cacheState>; advised: Advice; restartUsd: number | null; switched: boolean } {
  const context = read.context?.currentTokens ?? log?.context ?? 0;
  // the cache of the model the next call uses (phase 1b): the composer's pick, else the last call's
  const model = read.model?.id ?? (log ? cacheModel(log) : "");
  const own = log ? modelLastCall(log, model) : { lastCallAt: null, switched: false };
  const calling = callingModel(read);
  const found = log ? cacheState(own.lastCallAt ?? log.lastCallAt, now, settings.cacheLifetimeMin, calling) : null;
  // a model switched to with no call of its own: nothing of the chat is in its cache yet
  const cache = found && own.switched && own.lastCallAt === null && !calling ? { ...found, state: "cold" as const, leftMin: 0 } : found;
  // the next call stores the whole context again on the new model: the Cache tab says why
  const switched = own.switched && !calling && cache?.state === "cold";
  const restartUsd = prices ? coldRestartUsd(context, model, prices.prices ?? {}, prices.fallback) : null;
  return { context, cache, restartUsd, switched, advised: cache ? advice(cache.state, isBigChat(restartUsd, settings.coldRestartAlertUsd)) : "keep" };
}

/** The cache's state as the handoff banner reads it (cacheMeter's), null without a log: a cold chat hands off from its record (ZAC-266). */
export function cacheStateOf(
  read: Parameters<typeof cacheMeter>[0],
  log: HostChatCost | null | undefined,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number },
  now: number,
  prices: CachePrices | null,
): CacheState | null {
  return cacheMeter(read, log, settings, now, prices).cache?.state ?? null;
}

/**
 * What switching the chat to `target` costs in the model picker (ZAC-260 phase 2, owner-approved):
 * a prompt cache is one model's, so the next call on another model stores the whole context again,
 * priced on the TARGET model. Null (no line) on the last call's own model, for a model still warm
 * (its own last main-agent call within the cache's lifetime), for a chat under the big-chat
 * threshold, unpriced, or from a bridge before 1071 (no `lastModel`: no per-model calls to weigh).
 */
export function switchCost(
  log: HostChatCost | null | undefined,
  target: string,
  context: number,
  settings: { coldRestartAlertUsd: number; cacheLifetimeMin: number },
  now: number,
  prices: CachePrices | null,
): { tokens: number; usd: number } | null {
  if (!log || !prices || context <= 0) return null;
  const own = modelLastCall(log, target);
  if (!own.switched) return null;
  const at = own.lastCallAt === null ? NaN : Date.parse(own.lastCallAt);
  if (!Number.isNaN(at) && now - at < settings.cacheLifetimeMin * 60_000) return null;
  const usd = coldRestartUsd(context, target, prices.prices ?? {}, prices.fallback);
  return isBigChat(usd, settings.coldRestartAlertUsd) ? { tokens: context, usd: usd! } : null;
}

/**
 * The log's sums with the open chat's live totals (`turnTokenTotals`, every turn and sub-agent),
 * which run ahead of the log by the running turn's calls. Per model only what the live totals hold
 * beyond the log is added (input, cache reads, output), a model the log lacks whole; nothing is ever
 * subtracted, so the same call is never counted twice. The rest of the log stays as is.
 */
export function mergeLive(log: HostChatCost, live: HostTokenTotal[] | undefined): HostChatCost {
  if (!live?.length) return log;
  const models = log.models.map((each) => ({ ...each }));
  for (const total of live) {
    const known = models.find((each) => each.model === total.model);
    if (!known) {
      models.push({ model: total.model, input: total.input, cacheRead: total.cached, cacheWrite: 0, output: total.output, calls: 0 });
      continue;
    }
    known.input += Math.max(0, total.input - known.input);
    known.cacheRead += Math.max(0, total.cached - known.cacheRead);
    known.output += Math.max(0, total.output - known.output);
  }
  return { ...log, models };
}

export type CostPeriod = "today" | "7d" | "30d";
const PERIOD_DAYS: Record<CostPeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** A PC's spend in a period: its sum, how many of its chats made calls then, and the costliest of them. */
export interface PcPeriod { machineId: string; split: CostSplit; chats: number; biggest: { session: string; split: CostSplit } | null }
/** Every PC's spend in a period (the Costs sheet and its chip): the PCs costliest first, and the PCs whose bridge predates costs. */
export interface PeriodTotals { total: CostSplit; pcs: PcPeriod[]; oldBridge: string[] }

/**
 * What every PC spent in a period, by the day each call was made (builder's call, ZAC-260): a
 * chat that spans two days counts in each day for that day's calls. The periods are whole UTC days,
 * the bridge's `days` keys: today is the UTC date of `now`, 7 days that date and the 6 before, 30
 * days likewise, so in Paris (UTC+1) a day turns at 01:00 local, and an hour's calls can land in
 * the day next to the one the owner would say. A log no listed chat runs on still counts: it is a
 * Copilot chat of that PC that spent. A PC whose answer is null (a bridge before costs) is left
 * out of the sums and named in `oldBridge`; a chat partly read, or any while its PC's first scan
 * runs, makes the sums floors, as does a model with no price.
 */
export function periodTotals(
  answers: ReadonlyMap<string, HostCostsAnswer | null>, period: CostPeriod, now: number,
  prices: ModelPrices, fallback: Record<string, ModelPrice> | null,
): PeriodTotals {
  const days = new Set(Array.from({ length: PERIOD_DAYS[period] }, (_, back) => new Date(now - back * 86_400_000).toISOString().slice(0, 10)));
  const total = emptySplit();
  const pcs: PcPeriod[] = [];
  const oldBridge: string[] = [];
  for (const [machineId, answer] of answers) {
    if (answer === null) { oldBridge.push(machineId); continue; }
    const pc: PcPeriod = { machineId, split: emptySplit(), chats: 0, biggest: null };
    pc.split.floor = !answer.complete;
    for (const chat of answer.chats) {
      const models = Object.entries(chat.days).flatMap(([key, each]) => days.has(key) ? each : []);
      if (models.length === 0) continue;
      const split = costSplit(models, prices, fallback);
      split.floor ||= chat.partial || !answer.complete;
      addSplit(pc.split, split);
      pc.chats += 1;
      if (!pc.biggest || split.usd > pc.biggest.split.usd) pc.biggest = { session: chat.session, split };
    }
    addSplit(total, pc.split);
    pcs.push(pc);
  }
  pcs.sort((a, b) => b.split.usd - a.split.usd);
  return { total, pcs, oldBridge };
}
