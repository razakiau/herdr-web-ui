import { describe, expect, it } from "bun:test";

import type { HostCostCall } from "../../shared/host-chats.ts";
import { translate } from "../lib/i18n.ts";
import { chartCard, chartMode, chartTicks, dayCosts, dayTicks, messageCosts, niceTicks, tickTokens, tickUsd, type ChartBar, type MessageCost } from "./CostChart.tsx";

const OPUS = { input: 4, output: 20, cached: 0.2 };
const call = (over: Partial<HostCostCall>): HostCostCall => ({ at: "2026-10-29T12:00:00.000Z", input: 0, cacheRead: 0, cacheWrite: 0, output: 0, main: true, context: 0, lastCacheRead: 0, ...over });

describe("messageCosts", () => {
  it("prices the prompt less the cache read as new input: the writes are not inside it", () => {
    // Copilot's input 99,947 = read 99,607 + 340 new; 2,454 stored on top, warm
    const [reply] = messageCosts([call({ input: 99_947, cacheRead: 99_607, cacheWrite: 2_454, output: 100 })], "cc/claude-opus-5-5", OPUS);
    expect(reply?.restart).toBe(0);
    expect(reply?.rest).toBeCloseTo((340 * 4 + 99_607 * 0.2 + 2_454 * 8 + 100 * 20) / 1e6, 12);
  });

  it("the red part is the cold restarts' write only; a bridge without coldWrite has none", () => {
    const [cold, old] = messageCosts([
      call({ input: 100_000, cacheRead: 0, cacheWrite: 110_000, coldWrite: 100_000 }),
      call({ input: 100_000, cacheRead: 0, cacheWrite: 100_000 }),
    ], "cc/claude-opus-5-5", OPUS);
    expect(cold?.restart).toBeCloseTo(100_000 * 8 / 1e6, 12);
    expect(cold?.rest).toBeCloseTo((100_000 * 4 + 10_000 * 8) / 1e6, 12);
    expect(old?.restart).toBe(0);
  });

  it("a sub-agent's calls stay in the reply that started them", () => {
    const replies = messageCosts([
      call({ output: 1_000, context: 50_000 }),
      call({ output: 1_000, main: false, context: 9_000 }),
      call({ at: "2026-10-29T12:10:00.000Z", output: 1_000, context: 60_000 }),
    ], "cc/claude-opus-5-5", OPUS);
    expect(replies.map((each) => [each.at, each.context])).toEqual([["2026-10-29T12:00:00.000Z", 50_000], ["2026-10-29T12:10:00.000Z", 60_000]]);
    expect(replies[0]?.rest).toBeCloseTo(2_000 * 20 / 1e6, 12);
  });
});

describe("chartTicks", () => {
  it("the first reply's time, the replies a third and two thirds along (the bars are spaced by reply), and now", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).toISOString();
    const replies = [at(13, 38), at(13, 50), at(14, 0), at(15, 0), at(15, 20), at(16, 30), at(16, 40)];
    expect(chartTicks(replies, (iso) => new Date(iso).toTimeString().slice(0, 5), "now")).toEqual(["13:38", "14:00", "15:20", "now"]);
  });
  it("one reply: its time and now", () => {
    expect(chartTicks(["2026-10-29T12:00:00.000Z"], () => "12:00", "now")).toEqual(["12:00", "now"]);
  });
});

describe("messageCosts: calls per reply (chart B's card)", () => {
  it("a reply counts its main and sub-agent calls together, and its cold restarts", () => {
    const [reply, next] = messageCosts([
      call({ output: 1, calls: 37, restarts: 1, coldWrite: 10, cacheWrite: 10 }),
      call({ output: 1, main: false, calls: 4, restarts: 0 }),
      call({ at: "2026-10-29T12:10:00.000Z", output: 1, calls: 2, restarts: 0 }),
    ], "cc/claude-opus-5-5", OPUS);
    expect([reply?.calls, reply?.restarts, next?.calls]).toEqual([41, 1, 2]);
  });
  it("a bridge before 1071 counts no calls: null, never a made-up number", () => {
    expect(messageCosts([call({ output: 1 })], "cc/claude-opus-5-5", OPUS)[0]?.calls).toBeNull();
  });
});

describe("niceTicks", () => {
  it("3 or 4 ticks from 0, a step of 1, 2, 2.5 or 5 × 10ⁿ, the last at or above the top", () => {
    expect(niceTicks(1.73)).toEqual([0, 1, 2]);
    expect(niceTicks(21.9)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(0.42)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(318_000)).toEqual([0, 200_000, 400_000]);
    expect(niceTicks(123_000)).toEqual([0, 50_000, 100_000, 150_000]);
    expect(niceTicks(0.0123)).toEqual([0, 0.005, 0.01, 0.015]);
    for (const max of [0.0007, 0.9, 3, 7.5, 49, 101, 999, 4_321_000]) {
      const ticks = niceTicks(max);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });
  it("labels: dollars short, context in K", () => {
    expect([0, 0.25, 2.5, 20, 1500].map(tickUsd)).toEqual(["$0", "$0.25", "$2.5", "$20", "$1.5K"]);
    expect([0, 150_000, 1_500_000].map(tickTokens)).toEqual(["0K", "150K", "1.5M"]);
  });
});

const message = (at: string, over: Partial<MessageCost> = {}): MessageCost => ({ at, restart: 0, rest: 1, context: 100_000, calls: 10, restarts: 0, ...over });

describe("dayCosts", () => {
  it("one bar per calendar day: the cost and cold restarts summed, the context the day's largest", () => {
    const days = dayCosts([
      message("2026-10-22T08:00:00Z", { rest: 1, context: 200_000, calls: 30 }),
      message("2026-10-22T20:00:00Z", { rest: 2, restart: 0.5, restarts: 1, context: 318_000, calls: 40 }),
      message("2026-10-22T21:00:00Z", { rest: 3, restart: 0.25, restarts: 1, context: 250_000, calls: 5 }),
      message("2026-10-23T09:00:00Z", { rest: 4 }),
    ], "UTC");
    expect(days.map((day) => [day.index, day.at, day.replies, day.rest, day.restart, day.restarts, day.context, day.calls])).toEqual([
      [0, "2026-10-22T08:00:00Z", 3, 6, 0.75, 2, 318_000, 75],
      [1, "2026-10-23T09:00:00Z", 1, 4, 0, 0, 100_000, 10],
    ]);
  });
  it("the day is the device's: 23:30 UTC is the next day in Paris and the same day in New York", () => {
    const replies = [message("2026-10-22T20:00:00Z"), message("2026-10-22T23:30:00Z")];
    expect(dayCosts(replies, "Europe/Paris").map((day) => day.replies)).toEqual([1, 1]);
    expect(dayCosts(replies, "America/New_York").map((day) => day.replies)).toEqual([2]);
    expect(dayCosts(replies, "UTC").map((day) => day.replies)).toEqual([2]);
  });
  it("a day with a reply from an old bridge has no call count", () => {
    expect(dayCosts([message("2026-10-22T08:00:00Z"), message("2026-10-22T09:00:00Z", { calls: null })], "UTC")[0]?.calls).toBeNull();
  });
});

describe("chartMode", () => {
  it("up to 40 replies one bar each; past 40 days, unless replies were chosen on this device", () => {
    expect(chartMode(40, "days")).toBe("replies");
    expect(chartMode(41, null)).toBe("days");
    expect(chartMode(209, "replies")).toBe("replies");
    expect(chartMode(209, "junk")).toBe("days");
  });
});

describe("dayTicks", () => {
  it("the first, middle and last day", () => {
    const at = ["a", "b", "c", "d", "e"];
    expect(dayTicks(at, (each) => each)).toEqual(["a", "c", "e"]);
    expect(dayTicks(["a", "b"], (each) => each)).toEqual(["a", "b"]);
    expect(dayTicks(["a"], (each) => each)).toEqual(["a"]);
  });
});

describe("chartCard", () => {
  const t = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);
  const bar = (over: Partial<ChartBar>): ChartBar => ({ ...message("2026-10-29T20:22:00Z"), index: 10, replies: 1, ...over });
  it("a reply: its number, date and time, calls; Cost; Context at the end; no cold restart row when there was none", () => {
    const card = chartCard(bar({ rest: 1.92, context: 214_000, calls: 37 }), "replies", t, "UTC");
    expect(card.title).toMatch(/^Reply 11 · Oct 29, (08:22 PM|20:22) · 37 calls$/);
    expect(card.rows).toEqual([
      { kind: "cost", label: "Cost", value: "$1.92" },
      { kind: "context", label: "Context at the end", value: "214K" },
    ]);
  });
  it("a day: its weekday and date, replies and calls; the cold restarts with their count; the largest context", () => {
    const card = chartCard(bar({ at: "2026-10-22T09:00:00Z", rest: 53.3, restart: 5.1, restarts: 2, context: 318_000, calls: 1104, replies: 31 }), "days", t, "UTC");
    expect(card.title).toBe("Thu, Oct 22 · 31 replies · 1,104 calls");
    expect(card.rows).toEqual([
      { kind: "cost", label: "Cost", value: "$58.40" },
      { kind: "restart", label: "Cold restarts (2)", value: "$5.10" },
      { kind: "context", label: "Largest context", value: "318K" },
    ]);
  });
  it("an old bridge's reply: no call count in the title", () => {
    expect(chartCard(bar({ calls: null }), "replies", t, "UTC").title).toMatch(/^Reply 11 · Oct 29, [^·]+$/);
  });
});
