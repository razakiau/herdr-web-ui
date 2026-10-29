import { describe, expect, it } from "bun:test";
import { chatCost, formatUsd, listUsd, priceOf, priceWithFallback, wholeUsd } from "./chatCost.ts";

const PRICES = {
  cc: { "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 } },
  gh: { "gpt-5": { input: 1.25, output: 10 } },
  anthropic: { "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3 } },
  openai: { "gpt-5": { input: 1.25, output: 10 }, "gpt-5.5": { input: 5, output: 30 } },
  zai: { "glm-5": { input: 1, output: 3 } },
  other: { "glm-5": { input: 2, output: 4 } },
};

describe("priceOf", () => {
  it("finds a routed model under its provider, any case, a dot read as a dash", () => {
    expect(priceOf("cc/claude-opus-5-5", PRICES)).toEqual({ input: 4, output: 20, cached: 0.2 });
    expect(priceOf("CC/Claude-Opus-5.5", PRICES)).toEqual({ input: 4, output: 20, cached: 0.2 });
    // the provider is the routed one: no falling back to another provider's price
    expect(priceOf("cc/claude-sonnet-4-6", PRICES)).toBeNull();
  });

  it("a bare id is Copilot's first, then the one price every provider agrees on, else none", () => {
    expect(priceOf("gpt-5", PRICES)).toEqual({ input: 1.25, output: 10 });
    expect(priceOf("claude-sonnet-4.6", PRICES)).toEqual({ input: 3, output: 15, cached: 0.3 });
    expect(priceOf("glm-5", PRICES)).toBeNull();
    expect(priceOf("unknown", PRICES)).toBeNull();
  });
});

describe("priceWithFallback (ZAC-224)", () => {
  const FALLBACK = { "deepseek-v4-flash": { input: 0.3, output: 1.2, cached: 0.006 }, "glm-5.3": { input: 1.4, output: 4.4 }, "claude-opus-5-5": { input: 9, output: 9 } };
  it("OmniRoute's own row first, LiteLLM's by the bare name next", () => {
    expect(priceWithFallback("cc/claude-opus-5-5", PRICES, FALLBACK)).toEqual({ price: { input: 4, output: 20, cached: 0.2 }, via: "omniroute" });
    expect(priceWithFallback("opencode-go/glm-5.3", PRICES, FALLBACK)).toEqual({ price: { input: 1.4, output: 4.4 }, via: "litellm" });
  });
  it("a point release with no row of its own takes its base model's price, and says so", () => {
    expect(priceWithFallback("opencode-go/deepseek-v4.1-flash", PRICES, FALLBACK)).toEqual({ price: { input: 0.3, output: 1.2, cached: 0.006 }, via: "litellm", base: "deepseek-v4-flash" });
    // only a .x point release: a different size or family is no price
    expect(priceWithFallback("opencode-go/deepseek-v5-flash", PRICES, FALLBACK)).toBeNull();
    expect(priceWithFallback("opencode-go/glm-5.3-flash", PRICES, FALLBACK)).toBeNull();
    expect(priceWithFallback("deepseek-v4.1-flash", PRICES, null)).toBeNull();
  });
});

describe("chatCost", () => {
  it("counts fallback and base-model prices, and names the models priced that way", () => {
    const cost = chatCost([{ model: "opencode-go/deepseek-v4.1-flash", input: 1_000_000, cached: 0, output: 0 }, { model: "cc/claude-opus-5-5", input: 0, cached: 0, output: 1_000_000 }], PRICES, { "deepseek-v4-flash": { input: 0.3, output: 1.2 } });
    expect(cost).toEqual({ usd: 20.3, missing: [], estimated: ["opencode-go/deepseek-v4.1-flash"] });
  });

  it("prices input less the cache, the cache, and output as OmniRoute does, and names the unpriced", () => {
    // the live chat of 2026-10-24: 214,936 in, 214,282 of them cached, 1,549 out on Opus 5.5
    const live = chatCost([{ model: "cc/claude-opus-5-5", input: 214936, cached: 214282, output: 1549 }], PRICES);
    expect(live.usd).toBeCloseTo((654 * 4 + 214282 * 0.2 + 1549 * 20) / 1e6, 10);
    // a cache price missing is the input price; a model with no price is named, not guessed
    const mixed = chatCost([{ model: "gpt-5.5", input: 1000, cached: 500, output: 100 }, { model: "mystery", input: 5, cached: 0, output: 5 }], PRICES);
    expect(mixed).toEqual({ usd: (1000 * 5 + 100 * 30) / 1e6, missing: ["mystery"], estimated: [] });
  });
});

describe("formatUsd", () => {
  it("cents, a crumb, whole dollars past a hundred", () => {
    expect([formatUsd(0), formatUsd(0.004), formatUsd(0.0759), formatUsd(12.345), formatUsd(1234.5)]).toEqual(["$0.00", "<$0.01", "$0.08", "$12.35", "$1,235"]);
  });
});

describe("listUsd", () => {
  it("prints an estimate with ~, whole dollars from $10 to $100, cents below", () => {
    expect([listUsd(38.4, false), listUsd(3.1, false), listUsd(149.6, false)]).toEqual(["~$38", "~$3.10", "~$150"]);
  });
  it("rounds a floor down, so it never claims more than was counted", () => {
    expect([listUsd(149.6, true), listUsd(38.9, true), listUsd(1.629, true), listUsd(1234.9, true)]).toEqual(["≥ $149", "≥ $38", "≥ $1.62", "≥ $1,234"]);
  });
});

describe("wholeUsd", () => {
  it("whole dollars without a ~, a floor rounded down with ≥", () => {
    expect([wholeUsd(211.6, false), wholeUsd(211.6, true), wholeUsd(0.4, false), wholeUsd(1234.5, false)]).toEqual(["$212", "≥ $211", "$0", "$1,235"]);
  });
});
