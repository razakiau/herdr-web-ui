/**
 * What a chat's prompt cache costs (ZAC-260), shared by the client's cost views and the server's
 * cold-cache alert so both call the same chat big and quote the same prices.
 */
import type { HostChatCost } from "./host-chats.ts";
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
