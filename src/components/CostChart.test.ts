import { describe, expect, it } from "bun:test";

import type { HostCostCall } from "../../shared/host-chats.ts";
import { chartTicks, messageCosts } from "./CostChart.tsx";

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
