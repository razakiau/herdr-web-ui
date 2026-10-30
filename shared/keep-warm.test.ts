import { describe, expect, it } from "bun:test";

import { keepWarmKeyFor, keepWarmSettingsFrom, keepWarmStateFrom, keptWarm, type KeepWarmKey } from "./keep-warm.ts";

const T = Date.parse("2026-10-31T12:00:00Z");
const key = (over: Partial<KeepWarmKey> = {}): KeepWarmKey => ({
  key: "a".repeat(40), model: "claude-opus-5-5", apiKey: "cop", tokens: 268_000, prompt: 268_000,
  lastRealAt: T, lastPingAt: null, nextPingAt: T + 55 * 60_000, until: T + 8 * 3_600_000,
  pings: 0, usd: 0, restartUsd: 2.1, missed: false, disabled: false, kept: true, ...over,
});
const chat = (over: Partial<{ lastCallAt: string | null; context: number | null; lastModel: string | null }> = {}) =>
  ({ lastCallAt: new Date(T + 40_000).toISOString(), context: 267_400, lastModel: "omniroute/claude-opus-5.5", ...over });

describe("keepWarmKeyFor", () => {
  it("matches a chat to the conversation with its prompt size at its last call", () => {
    expect(keepWarmKeyFor(chat(), [key()])?.key).toBe("a".repeat(40));
  });

  it("matches on what the cache holds, not OmniRoute's prompt_tokens, which leaves out a fresh write", () => {
    expect(keepWarmKeyFor(chat(), [key({ prompt: 87 })])?.key).toBe("a".repeat(40));
  });

  it("matches nothing for another size, another time, or no last call", () => {
    expect(keepWarmKeyFor(chat({ context: 190_000 }), [key()])).toBeNull();
    expect(keepWarmKeyFor(chat({ lastCallAt: new Date(T + 30 * 60_000).toISOString() }), [key()])).toBeNull();
    expect(keepWarmKeyFor(chat({ lastCallAt: null }), [key()])).toBeNull();
    expect(keepWarmKeyFor(chat({ context: null }), [key()])).toBeNull();
  });

  it("takes the closest in time, and the same model on a tie", () => {
    const near = key({ key: "near", lastRealAt: T + 30_000 });
    const far = key({ key: "far", lastRealAt: T - 5 * 60_000 });
    expect(keepWarmKeyFor(chat(), [far, near])?.key).toBe("near");
    const other = key({ key: "sonnet", model: "claude-sonnet-5-5", lastRealAt: T + 40_000 });
    expect(keepWarmKeyFor(chat(), [other, key({ key: "opus" })])?.key).toBe("opus");
  });
});

describe("keptWarm", () => {
  it("is kept only while the plugin keeps it, nothing missed, inside its window", () => {
    expect(keptWarm(key(), T + 60_000)).toBe(true);
    expect(keptWarm(key({ missed: true }), T + 60_000)).toBe(false);
    expect(keptWarm(key({ disabled: true }), T + 60_000)).toBe(false);
    expect(keptWarm(key({ kept: false }), T + 60_000)).toBe(false);
    expect(keptWarm(key(), T + 9 * 3_600_000)).toBe(false);
    expect(keptWarm(null, T)).toBe(false);
  });
});

describe("wire shapes", () => {
  it("reads only a v1 state, dropping malformed keys", () => {
    expect(keepWarmStateFrom(null)).toBeNull();
    expect(keepWarmStateFrom({ v: 2, keys: [], today: {} })).toBeNull();
    const state = keepWarmStateFrom({ v: 1, keys: [key(), { key: 3 }], today: { day: "2026-10-31" } });
    expect(state?.keys).toHaveLength(1);
  });

  it("reads the plugin's finished days, none from a plugin before them, a malformed day dropped", () => {
    expect(keepWarmStateFrom({ v: 1, keys: [], today: { day: "2026-10-31" } })?.history).toEqual([]);
    expect(keepWarmStateFrom({ v: 1, keys: [], today: {}, history: "x" })?.history).toEqual([]);
    const day = { day: "2026-10-30", pings: 12, usd: 0.4, avoided: 2, avoidedUsd: 3.1 };
    expect(keepWarmStateFrom({ v: 1, keys: [], today: {}, history: [day, { day: "yesterday", pings: 1, usd: 0, avoided: 0, avoidedUsd: 0 }, { ...day, usd: "1" }, null] })?.history).toEqual([day]);
  });

  it("clamps settings to the plugin's own limits", () => {
    expect(keepWarmSettingsFrom({ enabled: false, windowHours: 99, fusePerDay: 5000.7, disabled: ["x", "x", 4] }))
      .toEqual({ enabled: false, windowHours: 24, fusePerDay: 1000, disabled: ["x"] });
    expect(keepWarmSettingsFrom({ windowHours: -1, fusePerDay: "200" })).toEqual({});
  });
});
