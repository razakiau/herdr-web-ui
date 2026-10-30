import { describe, expect, it } from "bun:test";
import type { HostChatCost, HostCostModel, HostCostsAnswer } from "../../shared/host-chats.ts";
import { advice, cacheMeter, cacheState, coldRestartUsd, costSplit, handoffUsd, isBigChat, mergeLive, nextCall, periodTotals, writePrice } from "./sessionCost.ts";

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
  it("keeps going for a small chat and hands off a big one, as urgent as its cache's state", () => {
    expect(advice("warm", false)).toBe("keep");
    expect(advice("cold", false)).toBe("keep");
    expect(advice("cooling", true)).toBe("handoff-cooling");
    expect(advice("cold", true)).toBe("handoff-cold");
    expect(advice("warm", true)).toBe("handoff-warm");
  });
});

describe("coldRestartUsd / isBigChat (ZAC-260: a big chat is weighed in dollars)", () => {
  it("prices the whole context written again: 312K of Opus at $4 in, written at $8, is $2.50", () => {
    const opus = { cc: { "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 } } };
    expect(coldRestartUsd(312_000, "cc/claude-opus-5-5", opus, null)).toBeCloseTo(2.496, 9);
    expect(isBigChat(coldRestartUsd(312_000, "cc/claude-opus-5-5", opus, null), 1)).toBe(true);
  });
  it("is null for a model with no price: not big, no guess", () => {
    expect(coldRestartUsd(900_000, "mystery-1", PRICES, null)).toBeNull();
    expect(isBigChat(null, 0.25)).toBe(false);
  });
  it("is $0 for a local model, which is never big", () => {
    expect(coldRestartUsd(900_000, "desktop-coder-heretic", PRICES, null)).toBe(0);
    expect(isBigChat(0, 0.25)).toBe(false);
  });
  it("follows a context that shrank after a compaction: the same chat is small again", () => {
    // 210K of a $5 Claude model written at $10: $2.10; compacted to 60K: $0.60
    expect(isBigChat(coldRestartUsd(210_000, "cc/claude-opus-5-5", PRICES, null), 1)).toBe(true);
    expect(isBigChat(coldRestartUsd(60_000, "cc/claude-opus-5-5", PRICES, null), 1)).toBe(false);
  });
  it("weighs a cheap model by its own price: 400K of DeepSeek at $0.30 is $0.12", () => {
    expect(coldRestartUsd(400_000, "deepseek/deepseek-v4-flash", PRICES, null)).toBeCloseTo(0.12, 9);
    expect(isBigChat(0.12, 1)).toBe(false);
  });
  it("cacheMeter advises a handoff by the dollar threshold, the read's model first", () => {
    const log: HostChatCost = { session: "s", models: [model({ model: "deepseek/deepseek-v4-flash", input: 10 })], lastCallAt: ago(30), context: 210_000, peak: 210_000, rewrites: 0, days: {}, partial: false };
    const settings = { coldRestartAlertUsd: 1, cacheLifetimeMin: 60 };
    const prices = { prices: PRICES, fallback: null };
    // the log's model alone (DeepSeek): $0.06, keep going
    expect(cacheMeter({ busy: false }, log, settings, NOW, prices)).toMatchObject({ advised: "keep" });
    // the chat runs on Opus now: $2.10, hand off
    expect(cacheMeter({ busy: false, model: { id: "cc/claude-opus-5-5" } }, log, settings, NOW, prices)).toMatchObject({ advised: "handoff-warm" });
    // prices not in yet: nothing is big
    expect(cacheMeter({ busy: false, model: { id: "cc/claude-opus-5-5" } }, log, settings, NOW, null).advised).toBe("keep");
  });
});

describe("a prompt cache is one model's (phase 1b)", () => {
  const settings = { coldRestartAlertUsd: 1, cacheLifetimeMin: 60 };
  const prices = { prices: PRICES, fallback: null };
  // the chat ran on Opus until 40 min ago, then one call on DeepSeek 10 min ago
  const log: HostChatCost = {
    session: "s", lastCallAt: ago(10), lastModel: "deepseek/deepseek-v4-flash", context: 210_000, peak: 210_000, rewrites: 0, days: {}, partial: false,
    models: [model({ model: "cc/claude-opus-5-5", input: 9_000_000, calls: 30, lastCallAt: ago(40) }), model({ model: "deepseek/deepseek-v4-flash", input: 210_000, calls: 1, lastCallAt: ago(10) })],
  };
  it("counts down from the composer's model's own last call: switching back to Opus within the hour finds it warm", () => {
    // the picker's id has another route prefix than the log's: one model
    expect(cacheMeter({ busy: false, model: { id: "omniroute/claude-opus-5-5" } }, log, settings, NOW, prices)).toMatchObject({ cache: { state: "warm", leftMin: 20 }, switched: false });
    expect(cacheMeter({ busy: false, model: { id: "cc/claude-opus-5-5" } }, log, settings, NOW, prices)).toMatchObject({ cache: { state: "warm", leftMin: 20 }, advised: "handoff-warm" });
    expect(cacheMeter({ busy: false, model: { id: "deepseek/deepseek-v4-flash" } }, log, settings, NOW, prices)).toMatchObject({ cache: { state: "warm", leftMin: 50 }, switched: false });
  });
  it("reads cold for a model with no call in the chat: the next call stores it all again, priced on that model", () => {
    const meter = cacheMeter({ busy: false, model: { id: "cc/claude-sonnet-5-5" } }, log, settings, NOW, { prices: { cc: { ...PRICES.cc, "claude-sonnet-5-5": { input: 3, output: 15, cached: 0.3 } } }, fallback: null });
    expect(meter).toMatchObject({ cache: { state: "cold", leftMin: 0 }, switched: true });
    // 210K × $3 × 2 (Anthropic's write) = $1.26
    expect(meter.restartUsd).toBeCloseTo(1.26, 9);
  });
  it("lists and the alert weigh the last call's model; an older bridge (no lastModel) keeps the chat's last call", () => {
    expect(cacheMeter({ busy: false }, log, settings, NOW, prices)).toMatchObject({ cache: { state: "warm", leftMin: 50 }, switched: false });
    const old = { ...log, lastModel: undefined };
    expect(cacheMeter({ busy: false, model: { id: "cc/claude-sonnet-5-5" } }, old, settings, NOW, prices)).toMatchObject({ cache: { state: "warm", leftMin: 50 }, switched: false });
  });
});

describe("handoffUsd", () => {
  it("is three warm calls at the chat's context", () => {
    const next = nextCall(268_000, "cc/claude-opus-5-5", 2_000, PRICES, null)!;
    expect(handoffUsd(268_000, "cc/claude-opus-5-5", 2_000, PRICES, null)).toBeCloseTo(3 * next.warm, 9);
    expect(handoffUsd(268_000, "mystery-1", 2_000, PRICES, null)).toBeNull();
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
    // the prompt holds the cache read and 40K sent without it; the 970K written is on top
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 49_840_000, cacheRead: 49_800_000, cacheWrite: 970_000, output: 120_000, calls: 400 })], PRICES, null);
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

describe("costSplit: what the money went on (ZAC-260 fix wave)", () => {
  it("fresh input is the prompt less the cache read: the writes are not inside the prompt", () => {
    // Copilot's input 99,947 = read 99,607 + 340 sent without the cache; 2,454 stored on top
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 99_947, cacheRead: 99_607, cacheWrite: 2_454, output: 0 })], PRICES, null);
    expect(split.fresh).toBeCloseTo(340 * 5 / 1e6, 12);
    expect(split.writes).toBeCloseTo(2_454 * 10 / 1e6, 12);
  });
  it("splits the writes into storing new text and cold restarts", () => {
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 300_000, cacheRead: 200_000, cacheWrite: 110_000, coldWrite: 100_000, output: 1_000 })], PRICES, null);
    expect(split.writes).toBeCloseTo(10_000 * 10 / 1e6, 12);
    expect(split.restarts).toBeCloseTo(100_000 * 10 / 1e6, 12);
    expect(split.usd).toBeCloseTo(split.fresh + split.reads + split.writes + split.restarts + split.output, 12);
  });
  it("reads a bridge without coldWrite as no restart", () => {
    const split = costSplit([model({ model: "cc/claude-opus-5-5", input: 100, cacheRead: 0, cacheWrite: 100 })], PRICES, null);
    expect(split.restarts).toBe(0);
    expect(split.writes).toBeCloseTo(100 * 10 / 1e6, 12);
  });
  it("a local model costs $0, is named in local, never missing; an effort suffix is priced", () => {
    const split = costSplit([
      model({ model: "desktop-coder-heretic", input: 1_000_000, output: 1_000_000 }),
      model({ model: "cc/claude-opus-5-5-high", input: 1_000_000, cacheRead: 0, output: 0 }),
    ], PRICES, null);
    expect(split).toMatchObject({ floor: false, missing: [], local: ["desktop-coder-heretic"] });
    expect(split.usd).toBeCloseTo(5, 9);
    expect(nextCall(100_000, "llama-swap/qwen", 2_000, PRICES, null)).toEqual({ warm: 0, cold: 0 });
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

describe("periodTotals", () => {
  // 2026-10-29 12:00 UTC: today is the 29th, 7 days reach back to the 23rd, 30 days to the 30th of September
  const opus = (output: number): HostCostModel[] => [model({ model: "cc/claude-opus-5-5", input: 0, output, calls: 1 })];
  const chat = (session: string, days: Record<string, HostCostModel[]>, over: Partial<HostChatCost> = {}): HostChatCost =>
    ({ session, models: [], lastCallAt: null, context: null, peak: 0, rewrites: 0, days, partial: false, ...over });
  const answers = new Map<string, HostCostsAnswer | null>([
    // $25 per million output: 1M today ($25) and 2M on the 24th ($50), and 4M on the 10th ($100)
    ["desk", { complete: true, chats: [
      chat("a", { "2026-10-29": opus(1_000_000), "2026-10-24": opus(2_000_000) }),
      chat("b", { "2026-10-10": opus(4_000_000) }),
    ] }],
    ["cde", { complete: true, chats: [chat("c", { "2026-10-23": opus(400_000) }), chat("d", { "2026-10-22": opus(400_000) })] }],
    ["old", null],
  ]);

  it("sums each PC's calls by the UTC day they were made, and names a bridge before costs", () => {
    const week = periodTotals(answers, "7d", NOW, PRICES, null);
    expect(week.total.usd).toBeCloseTo(85, 9);
    expect(week.total.floor).toBe(false);
    expect(week.oldBridge).toEqual(["old"]);
    expect(week.pcs.map((pc) => [pc.machineId, Math.round(pc.split.usd), pc.chats, pc.biggest?.session])).toEqual([["desk", 75, 1, "a"], ["cde", 10, 1, "c"]]);
    const today = periodTotals(answers, "today", NOW, PRICES, null);
    expect(today.total.usd).toBeCloseTo(25, 9);
    expect(today.pcs.map((pc) => [pc.machineId, pc.chats])).toEqual([["desk", 1], ["cde", 0]]);
    expect(today.pcs[1]!.biggest).toBeNull();
    const month = periodTotals(answers, "30d", NOW, PRICES, null);
    expect(month.total.usd).toBeCloseTo(195, 9);
    expect(month.pcs[0]!.chats).toBe(2);
    expect(month.pcs[0]!.biggest?.session).toBe("b");
    expect(month.pcs[0]!.biggest?.split.usd).toBeCloseTo(100, 9);
  });

  it("splits a chat that spans two days across them, and keeps the parts", () => {
    const split = periodTotals(new Map([["desk", { complete: true, chats: [chat("a", {
      "2026-10-29": [model({ model: "cc/claude-opus-5-5", input: 1_000_000, cacheRead: 1_000_000 })],
      "2026-10-28": [model({ model: "cc/claude-opus-5-5", input: 100_000, cacheWrite: 100_000 })],
    })] }]]), "today", NOW, PRICES, null);
    expect(split.total.reads).toBeCloseTo(0.5, 9);
    expect(split.total.writes).toBe(0);
  });

  it("is a floor when a chat is partly read, the first scan runs, or a model has no price", () => {
    const partly = periodTotals(new Map([["desk", { complete: true, chats: [chat("a", { "2026-10-29": opus(1_000_000) }, { partial: true })] }]]), "today", NOW, PRICES, null);
    expect([partly.total.floor, partly.pcs[0]!.split.floor, partly.pcs[0]!.biggest?.split.floor]).toEqual([true, true, true]);
    const scanning = periodTotals(new Map([["desk", { complete: false, chats: [chat("a", { "2026-10-29": opus(1_000_000) })] }]]), "today", NOW, PRICES, null);
    expect(scanning.total.floor).toBe(true);
    const unpriced = periodTotals(new Map([["desk", { complete: true, chats: [chat("a", { "2026-10-29": [model({ model: "mystery-1", output: 5 }), ...opus(1_000_000)] })] }]]), "today", NOW, PRICES, null);
    expect(unpriced.total.floor).toBe(true);
    expect(unpriced.total.missing).toEqual(["mystery-1"]);
    expect(unpriced.total.usd).toBeCloseTo(25, 9);
  });

  it("is empty with no answer yet", () => {
    const none = periodTotals(new Map(), "7d", NOW, PRICES, null);
    expect([none.total.usd, none.pcs, none.oldBridge]).toEqual([0, [], []]);
  });
});
