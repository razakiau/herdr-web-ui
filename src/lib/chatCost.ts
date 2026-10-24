import type { HostTokenTotal } from "../../shared/host-chats.ts";
import type { ModelPrice, ModelPrices } from "../../shared/protocol.ts";

/**
 * A model id as a turn names it (`cc/claude-opus-5-5`, OmniRoute's provider then its model; a
 * Copilot model has no prefix) to its row in OmniRoute's price table, as OmniRoute's own cost
 * calculator finds it (getPricingForModel): the provider by its id, the model by its name, any
 * case, `.` read as `-`. A bare id is looked up under Copilot's `gh`, then under every provider:
 * one match is its price, several or none are no price, never a guess.
 */
export function priceOf(model: string, prices: ModelPrices): ModelPrice | null {
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  const find = (table: Record<string, ModelPrice> | undefined, name: string): ModelPrice | null => {
    if (!table) return null;
    for (const candidate of [name, name.replace(/\./g, "-")]) {
      const hit = Object.entries(table).find(([key]) => key.toLowerCase() === candidate);
      if (hit) return hit[1];
    }
    return null;
  };
  const providers = Object.entries(prices);
  const provider = (id: string) => providers.find(([key]) => key.toLowerCase() === id)?.[1];
  if (slash > 0) return find(provider(lower.slice(0, slash)), lower.slice(slash + 1));
  const copilot = find(provider("gh"), lower);
  if (copilot) return copilot;
  const found = providers.flatMap(([, table]) => { const hit = find(table, lower); return hit ? [hit] : []; });
  const first = found[0];
  return first && found.every((each) => each.input === first.input && each.output === first.output && each.cached === first.cached) ? first : null;
}

/**
 * The chat's cost at list price, as OmniRoute counts one (computeCostFromPricing): input less the
 * cached part at the input price, the cached part at the cache price (the input price when it has
 * none), the output at the output price. Every model priced at its list price, a subscription's
 * included: what the chat would cost on the API (owner, ZAC-224). `missing`: models with no price.
 */
export function chatCost(totals: readonly HostTokenTotal[], prices: ModelPrices): { usd: number; missing: string[] } {
  let usd = 0;
  const missing: string[] = [];
  for (const total of totals) {
    const price = priceOf(total.model, prices);
    if (!price) { missing.push(total.model); continue; }
    const cached = Math.min(total.cached, total.input);
    usd += ((total.input - cached) * price.input + cached * (price.cached ?? price.input) + total.output * price.output) / 1_000_000;
  }
  return { usd, missing };
}

/** Dollars as a person reads a running cost: cents under $100, whole dollars above, "<$0.01" for a crumb. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}
