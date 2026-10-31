/**
 * A model's list price, shared by the client's cost views and the server's cold-cache alert
 * (ZAC-260): moved here from src/lib/chatCost.ts so both price a chat the same way.
 */
import type { ModelPrice, ModelPrices } from "./protocol.ts";

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

/** A `.x` point release's base model (`deepseek-v4.1-flash` → `deepseek-v4-flash`), null when the name has none. */
function baseModel(name: string): string | null {
  const base = name.replace(/(\d+)\.\d+(?=-|$)/, "$1");
  return base === name ? null : base;
}

export interface FoundPrice { price: ModelPrice; via: "omniroute" | "litellm" | "local"; base?: string }

/**
 * A model on the owner's own GPU (ZAC-260): an id starting with `desktop-`, bare or after any
 * `provider/` (`litellm/desktop-coder-heretic`), or routed through `llama-swap/` or `local/`. It
 * costs $0 and is labelled local, never listed as missing a price.
 */
export function isLocalModel(model: string): boolean {
  const lower = model.toLowerCase();
  return /^(?:[^/]+\/)*desktop-/.test(lower) || /^(?:llama-swap|local)\//.test(lower);
}

const LOCAL: FoundPrice = { price: { input: 0, output: 0, cached: 0 }, via: "local" };

/**
 * The reasoning effort Copilot appends to a model's id (`cc/claude-opus-5-5-high`, ZAC-260): the
 * same model at the same price, so not an estimate. Tried only when the full name has no price.
 */
const EFFORT = /-(?:minimal|low|medium|high|xhigh|max)$/;

/**
 * A model's price: $0 for a local model; OmniRoute's row first, then LiteLLM's maker price by the
 * bare name (owner, ZAC-224), then the same two for a point release's base model (owner: v4.1 is
 * priced as v4), named in `base`; a name with an effort suffix with none of those is priced as its
 * name without it.
 */
export function priceWithFallback(model: string, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): FoundPrice | null {
  if (isLocalModel(model)) return { ...LOCAL, price: { ...LOCAL.price } };
  const found = listedPrice(model, prices, fallback);
  if (found || !EFFORT.test(model)) return found;
  return listedPrice(model.replace(EFFORT, ""), prices, fallback);
}

/**
 * The picker names an OpenCode Go model by its OmniRoute alias (`omniroute/opencode-go-glm-5.3`),
 * a turn by its route (`opencode-go/glm-5.3`): both are the same model at the same price (ZAC-267).
 */
const OPENCODE_GO_ALIAS = /^omniroute\/opencode-go-/;

function listedPrice(model: string, prices: ModelPrices, fallback: Record<string, ModelPrice> | null): FoundPrice | null {
  const lower = model.toLowerCase().replace(OPENCODE_GO_ALIAS, "opencode-go/");
  const slash = lower.lastIndexOf("/");
  const prefix = slash > 0 ? lower.slice(0, slash + 1) : "";
  const name = lower.slice(slash + 1);
  const litellm = (each: string): ModelPrice | null => fallback?.[each] ?? fallback?.[each.replace(/\./g, "-")] ?? null;
  const at = (each: string, base?: string): FoundPrice | null => {
    const own = priceOf(prefix + each, prices);
    if (own) return { price: own, via: "omniroute", ...(base ? { base } : {}) };
    const other = litellm(each);
    return other ? { price: other, via: "litellm", ...(base ? { base } : {}) } : null;
  };
  const base = baseModel(name);
  return at(name) ?? (base ? at(base, base) : null);
}

/** Dollars as a person reads a running cost: cents under $100, whole dollars above, "<$0.01" for a crumb. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}
