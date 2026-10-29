import { describe, expect, it } from "bun:test";
import type { HostChatCost, HostCostModel } from "../../shared/host-chats.ts";
import { advice, cacheState, costSplit, mergeLive, nextCall, writePrice } from "./sessionCost.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const PRICES = {
  cc: { "claude-opus-5-5": { input: 5, output: 25, cached: 0.5 } },
  deepseek: { "deepseek-v4-flash": { input: 0.3, output: 1.2 } },
};

const model = (over: Partial<HostCostModel> & { model: string }): HostCostModel => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, ...over });

describe("cacheState", () => {
  it("is warm, then cooling in the lifetime's last 15 min, then cold", () => {
    expect(cacheState(ago(4), NOW, 60, false)).toEqual({ state: "warm", ageMin: 4, leftMin: 56 });
    expect(cacheState(ago(48), NOW, 60, false)).toEqual({ state: "cooling", ageMin: 48, leftMin: 12 });
    expect(cacheState(ago(61), NOW, 60, false)).toEqual({ state: "cold", ageMin: 61, leftMin: 0 });
  });
  it("is warm while the chat works, however old the last call", () => {
    expect(cacheState(ago(90), NOW, 60, true)?.state).toBe("warm");
  });
  it("is null with no call yet", () => {
    expect(cacheState(null, NOW, 60, false)).toBeNull();
  });
});

describe("advice", () => {
  it("keeps going under the threshold and hands off at or above it", () => {
    expect(advice("warm", 40_000, 150_000)).toBe("keep");
    expect(advice("cold", 40_000, 150_000)).toBe("keep");
    expect(advice("cooling", 210_000, 150_000)).toBe("handoff-cooling");
    expect(advice("cold", 210_000, 150_000)).toBe("handoff-cold");
    expect(advice("warm", 210_000, 150_000)).toBe("handoff-warm");
  });
});

describe("writePrice", () => {
  it("is twice the input for Anthropic models, the input otherwise", () => {
    expect(writePrice("cc/claude-opus-5-5", 5)).toBe(10);
    expect(writePrice("deepseek-v4.1-flash", 0.3)).toBe(0.3);
  });
});

describe("costSplit", () => {
  it("reproduces the marathon's shares: reads two thirds, writes a quarter", () => {
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 50_810_000, cacheRead: 49_800_000, cacheWrite: 970_000, output: 120_000, calls: 400 })], PRICES, null);
    expect(split.floor).toBe(false);
    expect(split.missing).toEqual([]);
    expect(Math.abs(split.reads / split.usd - 0.66)).toBeLessThan(0.02);
    expect(Math.abs(split.writes / split.usd - 0.26)).toBeLessThan(0.02);
    expect(split.usd).toBeCloseTo(split.fresh + split.reads + split.writes + split.output, 9);
    expect(split.fresh).toBeCloseTo(0.2, 6);
  });
  it("is a floor naming a model with no price", () => {
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 1_000_000, output: 0 }), model({ model: "mystery-1", input: 1_000_000, output: 1_000 })], PRICES, null);
    expect(split.floor).toBe(true);
    expect(split.missing).toEqual(["mystery-1"]);
    expect(split.usd).toBeCloseTo(5, 6);
  });
});

describe("nextCall", () => {
  it("prices the context at the cache read now and at the write after expiry", () => {
    const next = nextCall(100_000, "cc/claude-opus-5-5", 2_000, PRICES, null);
    expect(next?.warm).toBeCloseTo(100_000 * 0.5 / 1e6 + 2_000 * 25 / 1e6, 9);
    expect(next?.cold).toBeCloseTo(100_000 * 10 / 1e6 + 2_000 * 25 / 1e6, 9);
  });
  it("falls back to the input price with no cache price, and is null with no price", () => {
    const next = nextCall(100_000, "deepseek/deepseek-v4-flash", 0, PRICES, null);
    expect(next?.warm).toBeCloseTo(0.03, 9);
    expect(next?.cold).toBeCloseTo(0.03, 9);
    expect(nextCall(100_000, "mystery-1", 0, PRICES, null)).toBeNull();
  });
});

describe("mergeLive", () => {
  const log: HostChatCost = {
    session: "s1", models: [model({ model: "cc/claude-opus-5-5", input: 1_000, cacheRead: 800, cacheWrite: 100, output: 50, calls: 2 })],
    lastCallAt: ago(1), context: 500, peak: 600, rewrites: 0, days: {}, partial: false,
  };
  it("leaves the log as is with no live totals", () => {
    expect(mergeLive(log, undefined)).toEqual(log);
  });
  it("does not double-count live totals equal to the log", () => {
    expect(mergeLive(log, [{ model: "cc/claude-opus-5-5", input: 1_000, cached: 800, output: 50 }])).toEqual(log);
  });
  it("adds a call the log doesn't hold yet, once", () => {
    const merged = mergeLive(log, [{ model: "cc/claude-opus-5-5", input: 1_600, cached: 1_300, output: 80 }]);
    expect(merged.models).toEqual([model({ model: "cc/claude-opus-5-5", input: 1_600, cacheRead: 1_300, cacheWrite: 100, output: 80, calls: 2 })]);
    expect(merged.lastCallAt).toBe(log.lastCallAt);
    expect(merged.days).toBe(log.days);
  });
  it("adds a live model the log lacks whole, and never subtracts", () => {
    const merged = mergeLive(log, [{ model: "cc/claude-opus-5-5", input: 10, cached: 0, output: 0 }, { model: "gpt-5", input: 300, cached: 100, output: 20 }]);
    expect(merged.models).toEqual([log.models[0]!, model({ model: "gpt-5", input: 300, cacheRead: 100, output: 20 })]);
  });
});
