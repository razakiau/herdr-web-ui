import type { HostChatCost, HostCostModel, HostTokenTotal } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { priceWithFallback } from "./chatCost.ts";

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

export type Advice = "keep" | "handoff-warm" | "handoff-cooling" | "handoff-cold";

/**
 * What to do with the chat (the spec's advice table): keep going under the handoff threshold, a
 * cold cache costing one rewrite of a small context; at or above it, hand off, the cache's state
 * saying how urgent (warm: if work remains, cooling: before it goes cold, cold: a free moment).
 */
export function advice(state: CacheState, context: number, threshold: number): Advice {
  return context >= threshold ? `handoff-${state}` : "keep";
}

/**
 * What the meter and the handoff banner show (ZAC-260): the context's tokens, the live read's
 * (what the meter showed before) else the log's; the cache's state and minutes left from the log's
 * last call; the advice. `cache` is null without a log (a bridge before costs, or not answered yet):
 * tokens alone, no state, no advice.
 */
export function cacheMeter(
  read: { busy: boolean; context?: { currentTokens: number } | null },
  log: HostChatCost | null | undefined,
  settings: { costHandoffAt: number; cacheLifetimeMin: number },
  now: number,
): { context: number; cache: ReturnType<typeof cacheState>; advised: Advice } {
  const context = read.context?.currentTokens ?? log?.context ?? 0;
  const cache = log ? cacheState(log.lastCallAt, now, settings.cacheLifetimeMin, read.busy) : null;
  return { context, cache, advised: cache ? advice(cache.state, context, settings.costHandoffAt) : "keep" };
}

/**
 * The price per million tokens of writing to the cache, which the price table lacks (builder's
 * call, ZAC-260): 2× input for Anthropic models (their 1 h cache, which OmniRoute asks for), the
 * input price for the rest (DeepSeek, OpenAI bill no write).
 */
export function writePrice(model: string, input: number): number {
  return /claude|anthropic|cc\//i.test(model) ? input * 2 : input;
}

/**
 * A chat's cost in dollars by what the money went on: `fresh` (prompt neither read from nor written
 * to the cache) at the input price, `reads` at the cache price (the input price when it has none),
 * `writes` at `writePrice`, `output` at the output price; `usd` their sum. A model with no price
 * adds nothing and is named in `missing`, which makes the sum a `floor`.
 */
export interface CostSplit { usd: number; reads: number; writes: number; output: number; fresh: number; floor: boolean; missing: string[] }

export function costSplit(models: readonly HostCostModel[], prices: ModelPrices, fallback: Record<string, ModelPrice> | null): CostSplit {
  const split: CostSplit = { usd: 0, reads: 0, writes: 0, output: 0, fresh: 0, floor: false, missing: [] };
  for (const each of models) {
    const found = priceWithFallback(each.model, prices, fallback);
    if (!found) { split.missing.push(each.model); continue; }
    const { price } = found;
    split.fresh += Math.max(0, each.input - each.cacheRead - each.cacheWrite) * price.input / 1e6;
    split.reads += each.cacheRead * (price.cached ?? price.input) / 1e6;
    split.writes += each.cacheWrite * writePrice(each.model, price.input) / 1e6;
    split.output += each.output * price.output / 1e6;
  }
  split.usd = split.fresh + split.reads + split.writes + split.output;
  split.floor = split.missing.length > 0;
  return split;
}

/**
 * What the chat's next call costs in dollars (builder's call, ZAC-260): its context read from the
 * cache plus the chat's average output (`warm`), or after the cache expired, the context written
 * again (`cold`). Null when the model has no price.
 */
export function nextCall(context: number, model: string, avgOutput: number, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): { warm: number; cold: number } | null {
  const found = priceWithFallback(model, prices, fallback);
  if (!found) return null;
  const { price } = found;
  const output = avgOutput * price.output;
  return {
    warm: (context * (price.cached ?? price.input) + output) / 1e6,
    cold: (context * writePrice(model, price.input) + output) / 1e6,
  };
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
