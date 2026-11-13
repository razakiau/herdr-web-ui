import { describe, expect, it } from "bun:test";

import { budgetTone, chatUsd, defaultJudge, judgeUsd, modelFamily, suggestedRaises } from "./goal-budget.ts";
import type { HostCostModel } from "./host-chats.ts";
import type { ModelPrices } from "./usage.ts";

const PRICES: ModelPrices = { fictional: { "opus-x": { input: 10, output: 50, cached: 1 }, "flat-x": { input: 2, output: 4 } } };
const model = (name: string, over: Partial<HostCostModel> = {}): HostCostModel =>
  ({ model: name, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1, ...over });

describe("budgetTone", () => {
  it("is ok below 80 %, a notice from 80 % and over from 100 %", () => {
    expect(budgetTone(19.99, 25)).toBe("ok");
    expect(budgetTone(20, 25)).toBe("notice");
    expect(budgetTone(25, 25)).toBe("over");
    expect(budgetTone(30, 25)).toBe("over");
  });

  it("is over for a spend that is no number: it fails closed", () => {
    expect(budgetTone(Number.NaN, 25)).toBe("over");
    expect(budgetTone(Number.POSITIVE_INFINITY, 25)).toBe("over");
  });
});

describe("suggestedRaises", () => {
  it("adds 2 and 4 more checks at the run's rate, rounded up to the next $5", () => {
    expect(suggestedRaises(21, 3)).toEqual([35, 50]);
  });

  it("stays above the spend with no checks and no spend", () => {
    expect(suggestedRaises(0, 0)).toEqual([5, 10]);
  });

  it("is always above the spend, the second above the first", () => {
    for (const [spent, checks] of [[25, 100], [24.99, 1], [10, 0], [0.01, 50]] as const) {
      const [first, second] = suggestedRaises(spent, checks);
      expect(first).toBeGreaterThan(spent);
      expect(second).toBeGreaterThan(first);
      expect(first % 5).toBe(0);
      expect(second % 5).toBe(0);
    }
  });
});

describe("chatUsd", () => {
  it("counts a priced model and lists an unknown one", () => {
    const got = chatUsd([model("fictional/opus-x", { input: 1_000_000, output: 100_000 }), model("fictional/mystery-1", { input: 5_000_000, output: 5_000_000 })], PRICES, null);
    expect(got.usd).toBeCloseTo(15, 9);
    expect(got.unpriced).toEqual(["fictional/mystery-1"]);
  });

  it("lists a local model too, each name once", () => {
    const got = chatUsd([model("local/fictional-7b", { input: 1_000 }), model("fictional/mystery-1"), model("local/fictional-7b"), model("fictional/mystery-1")], PRICES, null);
    expect(got.usd).toBe(0);
    expect(got.unpriced).toEqual(["fictional/mystery-1", "local/fictional-7b"]);
  });
});

describe("judgeUsd", () => {
  it("prices the uncached input, the cached part at the cache price and the output", () => {
    expect(judgeUsd("fictional/opus-x", { input: 1_000_000, cached: 400_000, output: 100_000 }, PRICES, null)).toBeCloseTo(11.4, 9);
  });

  it("prices cached input at the input price when the model has no cache price", () => {
    expect(judgeUsd("fictional/flat-x", { input: 1_000_000, cached: 500_000, output: 250_000 }, PRICES, null)).toBeCloseTo(3, 9);
  });

  it("is $0 for an unpriced or a local model", () => {
    expect(judgeUsd("fictional/mystery-1", { input: 1_000_000, cached: 0, output: 1_000_000 }, PRICES, null)).toBe(0);
    expect(judgeUsd("local/fictional-7b", { input: 1_000_000, cached: 0, output: 1_000_000 }, PRICES, null)).toBe(0);
  });
});

describe("modelFamily", () => {
  it("is the last path segment up to the first dash", () => {
    expect(modelFamily("cc/claude-opus-5-5")).toBe("claude");
    expect(modelFamily("opencode-go/deepseek-v4-pro")).toBe("deepseek");
    expect(modelFamily("gpt-6-luna")).toBe("gpt");
  });
});

describe("defaultJudge", () => {
  it("picks the first model of another family", () => {
    expect(defaultJudge("cc/claude-opus-5-5", ["cc/claude-sonnet-5-5", "gpt-6-luna"])).toBe("gpt-6-luna");
  });

  it("falls back to the first model when every one is the same family", () => {
    expect(defaultJudge("cc/claude-opus-5-5", ["cc/claude-sonnet-5-5", "gh/claude-haiku-5"])).toBe("cc/claude-sonnet-5-5");
  });

  it("takes the first model without a worker model, and none from an empty list", () => {
    expect(defaultJudge(null, ["cc/claude-sonnet-5-5", "gpt-6-luna"])).toBe("cc/claude-sonnet-5-5");
    expect(defaultJudge("cc/claude-opus-5-5", [])).toBeNull();
  });
});
