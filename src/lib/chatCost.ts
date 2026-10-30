import type { HostTokenTotal } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";
import { formatUsd, priceWithFallback } from "../../shared/model-price.ts";

export { formatUsd, isLocalModel, priceOf, priceWithFallback, type FoundPrice } from "../../shared/model-price.ts";

/**
 * The chat's cost at list price, as OmniRoute counts one (computeCostFromPricing): input less the
 * cached part at the input price, the cached part at the cache price (the input price when it has
 * none), the output at the output price. Every model priced at its list price, a subscription's
 * included: what the chat would cost on the API (owner, ZAC-224). `missing`: models with no price
 * (a local model is $0, never missing); `estimated`: models priced as their base model.
 */
export function chatCost(totals: readonly HostTokenTotal[], prices: ModelPrices, fallback: Record<string, ModelPrice> | null = null): { usd: number; missing: string[]; estimated: string[] } {
  let usd = 0;
  const missing: string[] = [];
  const estimated: string[] = [];
  for (const total of totals) {
    const found = priceWithFallback(total.model, prices, fallback);
    if (!found) { missing.push(total.model); continue; }
    if (found.base) estimated.push(total.model);
    const { price } = found;
    const cached = Math.min(total.cached, total.input);
    usd += ((total.input - cached) * price.input + cached * (price.cached ?? price.input) + total.output * price.output) / 1_000_000;
  }
  return { usd, missing, estimated };
}

/** A floor's dollars rounded down, so it never claims more than was counted: whole from $10, cents below. */
const floorUsd = (usd: number): string => usd >= 10
  ? `$${Math.floor(usd + 1e-9).toLocaleString("en-US")}`
  : `$${(Math.floor(usd * 100 + 1e-9) / 100).toFixed(2)}`;

/**
 * A cost as a list prints it (ZAC-260): an estimate "~$38", whole dollars from $10 up, cents below
 * ("~$3.10"); a floor "≥ $6", rounded down.
 */
export function listUsd(usd: number, floor: boolean): string {
  if (floor) return `≥ ${floorUsd(usd)}`;
  return `~${usd >= 10 && usd < 100 ? `$${Math.round(usd)}` : formatUsd(usd)}`;
}

/** Whole dollars without the estimate's "~" (the sidebar's costs chip); a floor "≥ $211", rounded down. */
export function wholeUsd(usd: number, floor: boolean): string {
  return floor ? `≥ $${Math.floor(usd + 1e-9).toLocaleString("en-US")}` : `$${Math.round(usd).toLocaleString("en-US")}`;
}
