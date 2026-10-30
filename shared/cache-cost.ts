/**
 * What a chat's prompt cache costs (ZAC-260), shared by the client's cost views and the server's
 * cold-cache alert so both call the same chat big and quote the same prices.
 */
import type { HostChatCost, HostCostModel } from "./host-chats.ts";
import type { ModelPrice, ModelPrices } from "./protocol.ts";
import { priceWithFallback } from "./model-price.ts";

/**
 * The price per million tokens of writing to the cache, which the price table lacks (builder's
 * call, ZAC-260): 2× input for Anthropic models (their 1 h cache, which OmniRoute asks for), the
 * input price for the rest (DeepSeek, OpenAI bill no write).
 */
export function writePrice(model: string, input: number): number {
  return /claude|anthropic|cc\//i.test(model) ? input * 2 : input;
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
 * The model a log's chat runs on when nothing live says it: the one that read the most, as the
 * Session sheet picks it. "" for a log with no model.
 */
export function chatModel(log: Pick<HostChatCost, "models">): string {
  return [...log.models].sort((a, b) => b.input - a.input)[0]?.model ?? "";
}

/** a model id without its route ("omniroute/claude-opus-5-5" and the log's "cc/claude-opus-5-5" are one model) */
const bareModel = (id: string): string => id.split("/").at(-1) ?? id;

/**
 * The model whose cache a list or the cold alert weighs (phase 1b): the main agent's last call's,
 * which is the cache the next call reads unless someone switches; from a bridge before 1071, the
 * model that read the most (chatModel).
 */
export function cacheModel(log: Pick<HostChatCost, "models" | "lastModel">): string {
  return log.lastModel ?? chatModel(log);
}

/**
 * The last call whose cache `model`'s next call reads (ZAC-260 phase 1b). A prompt cache is one
 * model's: switching model means the next call stores the whole context again on the new one,
 * while the old model's cache stays warm for its lifetime. `model` (the composer's pick) is the
 * log's last model: the chat's last call. Another model: its own last main-agent call
 * (`HostCostModel.lastCallAt`), null when it has none, and `switched`. From a bridge before 1071
 * (no `lastModel`), or with no model given, the chat's last call, as before.
 * Out of scope: a router's fallback (OmniRoute serving another model than the one asked for) is not
 * seen here; the log's model is the one asked for.
 */
export function modelLastCall(log: Pick<HostChatCost, "models" | "lastCallAt" | "lastModel">, model?: string | null): { lastCallAt: string | null; switched: boolean } {
  if (!model || log.lastModel === undefined || log.lastModel === null || bareModel(log.lastModel) === bareModel(model)) return { lastCallAt: log.lastCallAt, switched: false };
  const want = bareModel(model);
  const calls = log.models.flatMap((each) => bareModel(each.model) === want && each.lastCallAt ? [each.lastCallAt] : []);
  const lastCallAt = calls.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  return { lastCallAt, switched: true };
}

/** A log's average output per call, what nextCall adds to each call. */
export function avgOutput(log: Pick<HostChatCost, "models">): number {
  const calls = log.models.reduce((sum, each) => sum + each.calls, 0);
  return calls > 0 ? log.models.reduce((sum, each) => sum + each.output, 0) / calls : 0;
}

/**
 * What a cold restart of the chat costs in dollars (owner, ZAC-260): its whole context written to
 * the cache again, context × writePrice / 1e6. It follows the model's price and a context that
 * shrank after a compaction by itself. Null when the model has no price (never a guess); a local
 * model is $0.
 */
export function coldRestartUsd(context: number, model: string, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): number | null {
  if (context <= 0 || model === "") return null;
  const found = priceWithFallback(model, prices, fallback);
  if (!found) return null;
  return context * writePrice(model, found.price.input) / 1e6;
}

/**
 * A big chat: one whose cold restart would cost at least `thresholdUsd` (owner, ZAC-260: "Mark
 * chats whose cold restart costs over", $1 by default). An unpriced chat is not big; a local one
 * ($0) never is.
 */
export function isBigChat(restartUsd: number | null, thresholdUsd: number): boolean {
  return restartUsd !== null && restartUsd > 0 && restartUsd >= thresholdUsd;
}

/**
 * The main agent's calls a /handoff takes: it reads the conversation and writes the summary.
 * Measured on the owner's logs (ZAC-260, 2026-11-01): 5 handoffs, median 3 main calls (3, 3, 3,
 * 5, 8). A small sample: an estimate, quoted with "~".
 */
export const HANDOFF_CALLS = 3;

/**
 * What handing off costs now, while the cache is warm (ZAC-260): HANDOFF_CALLS warm calls at the
 * chat's context. The Cache tab's "Hand off now" and the server's cold-cache alert both quote it.
 * Null when the model has no price.
 */
export function handoffUsd(context: number, model: string, avg: number, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): number | null {
  const next = nextCall(context, model, avg, prices, fallback);
  return next ? HANDOFF_CALLS * next.warm : null;
}

/**
 * A chat's cost in dollars by what the money went on (ZAC-260; here since ZAC-262, so the server's
 * weekly digest prices days as the Costs sheet does): `fresh` (the prompt less what it
 * read from the cache: Copilot's `inputTokens` holds the read, not the write, checked against
 * OmniRoute's call_logs) at the input price, `reads` at the cache price (the input price when it has
 * none), `writes` (storing each call's new text: the writes less the cold restarts') and `restarts`
 * (`coldWrite`, the whole conversation stored again after the cache expired; 0 from a bridge before
 * 1069) at `writePrice`, `output` at the output price; `usd` their sum. `firstWrite` (ZAC-262) is
 * the chat's first call storing the conversation, also at `writePrice`: already inside `writes`
 * (there was no cache to lose, so not a restart), kept apart only for its chip, never added to `usd`
 * twice; 0 from a bridge before ZAC-262. A model with no price adds nothing and is named in
 * `missing`, which makes the sum a `floor`; a local model adds $0 and is named in `local`.
 */
export interface CostSplit { usd: number; reads: number; writes: number; restarts: number; firstWrite: number; output: number; fresh: number; floor: boolean; missing: string[]; local: string[] }

export const emptySplit = (): CostSplit => ({ usd: 0, reads: 0, writes: 0, restarts: 0, firstWrite: 0, output: 0, fresh: 0, floor: false, missing: [], local: [] });

export function costSplit(models: readonly HostCostModel[], prices: ModelPrices, fallback: Record<string, ModelPrice> | null): CostSplit {
  const split = emptySplit();
  for (const each of models) {
    const found = priceWithFallback(each.model, prices, fallback);
    if (!found) { split.missing.push(each.model); continue; }
    if (found.via === "local") { if (!split.local.includes(each.model)) split.local.push(each.model); continue; }
    const { price } = found;
    const cold = Math.min(each.coldWrite ?? 0, each.cacheWrite);
    split.fresh += Math.max(0, each.input - each.cacheRead) * price.input / 1e6;
    split.reads += each.cacheRead * (price.cached ?? price.input) / 1e6;
    split.writes += (each.cacheWrite - cold) * writePrice(each.model, price.input) / 1e6;
    split.restarts += cold * writePrice(each.model, price.input) / 1e6;
    split.firstWrite += Math.min(each.firstWrite ?? 0, each.cacheWrite - cold) * writePrice(each.model, price.input) / 1e6;
    split.output += each.output * price.output / 1e6;
  }
  split.usd = split.fresh + split.reads + split.writes + split.restarts + split.output;
  split.floor = split.missing.length > 0;
  return split;
}

/** `part` into `into`: the sums, a floor when either is, each model named once */
export function addSplit(into: CostSplit, part: CostSplit): void {
  into.usd += part.usd;
  into.reads += part.reads;
  into.writes += part.writes;
  into.restarts += part.restarts;
  into.firstWrite += part.firstWrite;
  into.output += part.output;
  into.fresh += part.fresh;
  into.floor ||= part.floor;
  for (const model of part.missing) if (!into.missing.includes(model)) into.missing.push(model);
  for (const model of part.local) if (!into.local.includes(model)) into.local.push(model);
}
