import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostChatCost, HostCostModel, HostCostsAnswer } from "../shared/host-chats.ts";
import type { KeepWarmState } from "../shared/keep-warm.ts";
import { buildDigest, createDigestScheduler, type DigestSnapshot, DigestStore, digestText, nextRun } from "./digest.ts";

/**
 * The weekly digest (ZAC-262): what a week cost, built on Sunday 19:00 Europe/Paris from every
 * PC's cost logs and the keep-warm plugin's days, stored, and told in two lines.
 */

const at = (iso: string): number => Date.parse(iso);
// $1 per million tokens of each kind, a cache read half that: tokens read as dollars × 1e6
const PRICES = { p: { m: { input: 1, output: 1, cached: 0.5 } } };
const M = 1_000_000;

const day = (input: number, over: Partial<HostCostModel> = {}): HostCostModel[] => [{ model: "p/m", input: input * M, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1, ...over }];

function chat(session: string, days: Record<string, HostCostModel[]>, counts?: HostChatCost["dayCounts"]): HostChatCost {
  return { session, models: Object.values(days).flat(), lastCallAt: null, context: null, peak: 0, rewrites: 0, days, ...(counts ? { dayCounts: counts } : {}), partial: false };
}
const answer = (chats: HostChatCost[]): HostCostsAnswer => ({ chats, complete: true });

function keepWarm(today: KeepWarmState["today"], history: KeepWarmState["history"]): KeepWarmState {
  return { v: 1, at: 0, enabled: true, windowHours: 8, fusePerDay: 50, idleMin: 5, thresholdUsd: 1, available: true, problem: null, today, keys: [], history };
}

// Sunday 2026-11-01 19:00 in Paris (CET, UTC+1)
const CUT1 = at("2026-11-01T18:00:00Z");
// the Sunday after
const CUT2 = at("2026-11-08T18:00:00Z");

describe("nextRun", () => {
  it("is the next Sunday 19:00 in Paris, summer time and winter time alike", () => {
    // Saturday noon in CEST (UTC+2): Sunday 19:00 CEST
    expect(nextRun(at("2026-10-17T10:00:00Z"))).toBe(at("2026-10-18T17:00:00Z"));
    // the week the clocks go back (Sunday 2026-10-25, 03:00 CEST → 02:00 CET): Saturday is CEST, Sunday 19:00 is CET
    expect(nextRun(at("2026-10-24T10:00:00Z"))).toBe(at("2026-10-25T18:00:00Z"));
    // Saturday noon in CET (UTC+1)
    expect(nextRun(at("2026-10-31T11:00:00Z"))).toBe(CUT1);
  });

  it("on Sunday is today's 19:00 before it, next week's from it on", () => {
    expect(nextRun(CUT1 - 60_000)).toBe(CUT1);
    expect(nextRun(CUT1)).toBe(CUT2);
    expect(nextRun(CUT1 + 90 * 60_000)).toBe(CUT2);
  });
});

describe("buildDigest", () => {
  it("sums the first week from Monday 00:00 UTC to the cut, by UTC day", () => {
    const s = buildDigest({
      now: CUT1, previous: null, prices: PRICES, fallback: null, keepWarm: null,
      pcs: [{ machineId: "local", name: "Mac", rows: [{ session: "a", title: "Alpha", status: "idle", modified_at: "", cwd: null, unread: false, archived: false }],
        costs: answer([chat("a", { "2026-10-25": day(100), "2026-10-27": day(2), "2026-11-01": day(3) })]) }],
    });
    expect(s.week).toBe("2026-10-26");
    expect(s.from).toBe(at("2026-10-26T00:00:00Z"));
    expect(s.cut).toBe(CUT1);
    // the Sunday before the week (2026-10-25) is not in it
    expect(s.total.usd).toBeCloseTo(5);
    expect(s.days.map((each) => each.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(s.days[1]!.usd).toBeCloseTo(2);
    expect(s.chats).toEqual([{ machineId: "local", session: "a", title: "Alpha", usd: expect.closeTo(5) as never, restarts: 0 }]);
    expect(s.pcs).toEqual([{ machineId: "local", name: "Mac", usd: expect.closeTo(5) as never, chats: 1 }]);
    expect(s.cutDay.day).toBe("2026-11-01");
  });

  it("counts the cut day's rest in the next week, never twice", () => {
    const first = buildDigest({ now: CUT1, previous: null, prices: PRICES, fallback: null, keepWarm: null,
      pcs: [{ machineId: "local", name: "Mac", rows: [], costs: answer([chat("a", { "2026-11-01": day(3) })]) }] });
    // Sunday ended at $5 for the chat: $2 came after the cut
    const second = buildDigest({ now: CUT2, previous: first, prices: PRICES, fallback: null, keepWarm: null,
      pcs: [{ machineId: "local", name: "Mac", rows: [], costs: answer([chat("a", { "2026-11-01": day(5), "2026-11-03": day(1) })]) }] });
    expect(second.week).toBe("2026-11-02");
    expect(second.from).toBe(CUT1);
    expect(second.total.usd).toBeCloseTo(3);
    expect(second.days[0]).toEqual({ day: "2026-11-01", usd: expect.closeTo(2) as never, restartsUsd: 0 });
  });

  it("prices cold restarts, first writes, and counts the bridge's per-day restarts and hand-offs", () => {
    const s = buildDigest({ now: CUT1, previous: null, prices: PRICES, fallback: null, keepWarm: null,
      pcs: [{ machineId: "local", name: "Mac", rows: [], costs: answer([chat("a",
        { "2026-10-28": day(0, { cacheWrite: 3 * M, coldWrite: 2 * M, firstWrite: 1 * M }) },
        { "2026-10-28": { restarts: 2, firstWrites: 1, handoffs: 3 } })]) }] });
    expect(s.restarts).toEqual({ n: 2, usd: expect.closeTo(2) as never });
    expect(s.firstWrites).toEqual({ n: 1, usd: expect.closeTo(1) as never });
    expect(s.handoffs).toBe(3);
    expect(s.days[2]!.restartsUsd).toBeCloseTo(2);
    expect(s.chats[0]!.restarts).toBe(2);
  });

  it("counts an old bridge's money with no counts, and names an offline PC without counting it", () => {
    const s = buildDigest({ now: CUT1, previous: null, prices: PRICES, fallback: null, keepWarm: null, pcs: [
      { machineId: "old", name: "Old", rows: [], costs: answer([chat("a", { "2026-10-28": day(4, { cacheWrite: M, coldWrite: M }) })]) },
      { machineId: "cde", name: "CDE", rows: [], costs: null },
    ] });
    expect(s.offline).toEqual(["CDE"]);
    expect(s.pcs.map((each) => each.machineId)).toEqual(["old"]);
    expect(s.total.usd).toBeCloseTo(5);
    expect(s.restarts.n).toBe(0);
  });

  it("takes keep-warm from the plugin's days, the cut day's live today subtracted next week", () => {
    const first = buildDigest({ now: CUT1, previous: null, prices: PRICES, fallback: null, pcs: [],
      keepWarm: keepWarm({ day: "2026-11-01", pings: 6, usd: 0.6, avoided: 1, avoidedUsd: 2, fuseHit: false },
        [{ day: "2026-10-25", pings: 99, usd: 9, avoided: 9, avoidedUsd: 9 }, { day: "2026-10-27", pings: 4, usd: 0.4, avoided: 1, avoidedUsd: 3 }]) });
    expect(first.keepWarm).toEqual({ pings: 10, usd: expect.closeTo(1) as never, avoided: 2, avoidedUsd: expect.closeTo(5) as never });
    expect(first.cutDay.keepWarm?.pings).toBe(6);
    const second = buildDigest({ now: CUT2, previous: first, prices: PRICES, fallback: null, pcs: [],
      keepWarm: keepWarm({ day: "2026-11-08", pings: 0, usd: 0, avoided: 0, avoidedUsd: 0, fuseHit: false },
        [{ day: "2026-11-01", pings: 10, usd: 1, avoided: 2, avoidedUsd: 4 }]) });
    expect(second.keepWarm).toEqual({ pings: 4, usd: expect.closeTo(0.4) as never, avoided: 1, avoidedUsd: expect.closeTo(2) as never });
  });
});

describe("digestText", () => {
  const snapshot = (over: Partial<DigestSnapshot> = {}): DigestSnapshot => ({
    week: "2026-10-26", from: 0, cut: CUT1, built: CUT1, total: { usd: 184.2, floor: false }, days: [], chats: [], pcs: [], offline: [], noCounts: [],
    restarts: { n: 3, usd: 18.1 }, firstWrites: { n: 0, usd: 0 }, handoffs: 4,
    keepWarm: { pings: 40, usd: 4, avoided: 5, avoidedUsd: 29 },
    cutDay: { day: "2026-11-01", perChat: {}, counts: {}, keepWarm: null }, ...over,
  });

  it("names the total, no arrow the first week, and the week's parts", () => {
    expect(digestText(snapshot(), null)).toEqual({ title: "📊 $184 this week", body: "Cold restarts $18 · keep-warm saved ~$25 · 4 hand-offs" });
  });

  it("says how far from last week, up or down", () => {
    expect(digestText(snapshot(), snapshot({ total: { usd: 162, floor: false } })).title).toBe("📊 $184 this week · ▲ $22");
    expect(digestText(snapshot(), snapshot({ total: { usd: 206, floor: false } })).title).toBe("📊 $184 this week · ▼ $22");
  });

  it("leaves out a part with 0, and names each PC not counted", () => {
    const quiet = snapshot({ restarts: { n: 0, usd: 0 }, handoffs: 0, offline: ["CDE"] });
    expect(digestText(quiet, null).body).toBe("keep-warm saved ~$25 · CDE not counted");
    expect(digestText(snapshot({ keepWarm: { pings: 0, usd: 0, avoided: 0, avoidedUsd: 0 } }), null).body).toBe("Cold restarts $18 · 4 hand-offs");
  });
});

describe("DigestStore", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "ovis-digest-")); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  const snap = (week: string, cut: number): DigestSnapshot => ({ ...buildDigest({ now: cut, previous: null, pcs: [], prices: PRICES, fallback: null, keepWarm: null }), week });

  it("keeps the last 12 weeks in a private file, one per week, across a restart", () => {
    const store = new DigestStore(stateDir);
    for (let n = 0; n < 14; n++) store.add(snap(`2026-${String(n + 1).padStart(2, "0")}-01`, CUT1 + n * 7 * 86_400_000));
    store.add({ ...snap("2026-14-01", CUT1 + 13 * 7 * 86_400_000), total: { usd: 9, floor: false } });
    const again = new DigestStore(stateDir);
    expect(again.list()).toHaveLength(12);
    expect(again.list()[0]!.week).toBe("2026-14-01");
    expect(again.get("2026-14-01")?.total.usd).toBe(9);
    expect(again.get("2026-01-01")).toBeNull();
    expect(statSync(join(stateDir, "digests.json")).mode & 0o777).toBe(0o600);
  });
});

describe("createDigestScheduler", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "ovis-digest-run-")); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  function rig(now: number, stored: DigestSnapshot[] = []) {
    const store = new DigestStore(stateDir);
    for (const each of stored) store.add(each);
    const runs: number[] = [];
    const timers: { ms: number; fn: () => void }[] = [];
    let clock = now;
    const scheduler = createDigestScheduler({
      now: () => clock, store,
      run: async (at) => { runs.push(at); store.add({ ...buildDigest({ now: at, previous: null, pcs: [], prices: PRICES, fallback: null, keepWarm: null }) }); },
      timer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; },
    });
    return { scheduler, runs, timers, set: (ms: number) => { clock = ms; } };
  }
  const lastWeek = (): DigestSnapshot => buildDigest({ now: CUT1 - 7 * 86_400_000, previous: null, pcs: [], prices: PRICES, fallback: null, keepWarm: null });

  it("missed run: back at 20:30 on Sunday with the last digest older than the cut, runs once at start", async () => {
    const r = rig(CUT1 + 90 * 60_000, [lastWeek()]);
    await r.scheduler.start();
    expect(r.runs).toEqual([CUT1 + 90 * 60_000]);
    // the next is next week's, not this evening's again
    expect(r.timers.at(-1)!.ms).toBe(CUT2 - (CUT1 + 90 * 60_000));
    // a second start (Ovis restarted again) finds this week's digest: no second one
    const again = rig(CUT1 + 100 * 60_000);
    await again.scheduler.start();
    expect(again.runs).toEqual([]);
  });

  it("more than 12 h late (Monday 08:00) skips the week and waits for the next", async () => {
    const r = rig(at("2026-11-02T07:00:00Z"), [lastWeek()]);
    await r.scheduler.start();
    expect(r.runs).toEqual([]);
    expect(r.timers.at(-1)!.ms).toBe(CUT2 - at("2026-11-02T07:00:00Z"));
  });

  it("runs when its timer fires and arms the week after", async () => {
    const r = rig(CUT1 - 3_600_000, [lastWeek()]);
    await r.scheduler.start();
    expect(r.runs).toEqual([]);
    expect(r.timers.at(-1)!.ms).toBe(3_600_000);
    r.set(CUT1);
    r.timers.at(-1)!.fn();
    await r.scheduler.idle();
    expect(r.runs).toEqual([CUT1]);
    expect(r.timers.at(-1)!.ms).toBe(CUT2 - CUT1);
  });
});
