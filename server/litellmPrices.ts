import type { ModelPrice } from "../shared/protocol.ts";

/**
 * LiteLLM's community price map, read when OmniRoute's table has no row for a chat's model (owner,
 * ZAC-224: OmniRoute had no deepseek-v4.1-flash). It is updated several times a day, and it lists a
 * model under every host that resells it, at that host's price; only the maker's own row is kept,
 * by bare model name, so a cut-price reseller never stands in for the list price.
 */
export const LITELLM_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Providers whose LiteLLM rows are the maker's own API, by LiteLLM's provider id */
const MAKERS = new Set(["openai", "anthropic", "gemini", "deepseek", "zai", "moonshot", "xiaomi_mimo", "minimax", "xai", "mistral", "dashscope", "tencent"]);
const MODES = new Set(["chat", "responses"]);
const PRICES_MS = 6 * 3600_000;
const RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

const perMillion = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1e6 : null;
// 1e6 × a per-token price carries float noise (0.19999999999999998): six decimals is a millionth of a cent
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** The map's maker rows as USD per million tokens, by lowercase bare model name; the bare key wins a tie. */
export function litellmPricesFrom(raw: unknown): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  if (typeof raw !== "object" || raw === null) return prices;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const provider = row["litellm_provider"];
    if (typeof provider !== "string" || !MAKERS.has(provider)) continue;
    if (row["mode"] !== undefined && !MODES.has(String(row["mode"]))) continue;
    const slash = key.indexOf("/");
    if (slash > 0 && key.slice(0, slash) !== provider) continue;
    const name = key.slice(slash + 1).toLowerCase();
    if (name.includes("/") || (slash > 0 && name in prices)) continue;
    const input = perMillion(row["input_cost_per_token"]), output = perMillion(row["output_cost_per_token"]), cached = perMillion(row["cache_read_input_token_cost"]);
    if (input === null || output === null) continue;
    prices[name] = { input: round(input), output: round(output), ...(cached === null ? {} : { cached: round(cached) }) };
  }
  return prices;
}

/** The map, read at most every six hours, the last one kept through a failure, retried after ten minutes. */
export class LiteLlmPrices {
  private prices: Record<string, ModelPrice> | null = null;
  private readAt = 0;
  private retryAt = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch, private readonly now: () => number = Date.now) {}

  async read(): Promise<Record<string, ModelPrice> | null> {
    const now = this.now();
    if (this.prices !== null && now < this.readAt + PRICES_MS) return this.prices;
    if (now < this.retryAt) return this.prices;
    this.pending ??= this.fetcher(LITELLM_PRICES_URL, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`LiteLLM's price map answered ${response.status}`);
        this.prices = litellmPricesFrom(await response.json()); this.readAt = this.now();
      })
      .catch(() => { this.retryAt = this.now() + RETRY_MS; })
      .finally(() => { this.pending = null; });
    await this.pending;
    return this.prices;
  }
}
