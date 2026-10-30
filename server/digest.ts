/**
 * The weekly cost digest (ZAC-262, owner's mockup B): on Sunday 19:00 Europe/Paris the server reads
 * every PC's chat cost logs and the keep-warm plugin's days, saves what the week cost as a snapshot
 * (the last 12 weeks, `$STATE/digests.json`), and tells it in two lines on ntfy and web push. The
 * "This week" page shows the snapshot, never a live recompute, so the page and the notification it
 * came from always say the same numbers (the spec's anti-goal).
 *
 * A week is "so far" (owner's pick A): from the previous digest's cut to this one, in UTC days (the
 * bridge's `days` keys). The cut day is partial: what was counted of it is stored in `cutDay`, and
 * next week counts that day's final sums less it, so Sunday evening lands in the next week and
 * nothing is counted twice. The first digest starts on Monday 00:00 UTC.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { addSplit, costSplit, emptySplit } from "../shared/cache-cost.ts";
import type { HostChatRow, HostCostModel, HostCostsAnswer } from "../shared/host-chats.ts";
import { type DigestCounts, type DigestKeepWarm, type DigestSnapshot, digestUsd } from "../shared/digest.ts";
import type { KeepWarmState } from "../shared/keep-warm.ts";
import type { ModelPrice, ModelPrices } from "../shared/protocol.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { writePrivateState } from "./private-state.ts";

type Counts = DigestCounts;
type KeepWarmSums = DigestKeepWarm;
export type { DigestSnapshot };

export interface DigestPc { machineId: string; name: string; costs: HostCostsAnswer | null; rows: HostChatRow[] }

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** a chat of a PC, in `cutDay` */
const chatKey = (machineId: string, session: string): string => `${machineId}\t${session}`;

/** Monday 00:00 UTC of the week holding `ms` */
function mondayOf(ms: number): number {
  const day = Date.parse(utcDay(ms));
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/** `tz`'s wall clock minus UTC at `ms` */
function offsetAt(ms: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(ms).map((part) => [part.type, part.value]));
  return Date.UTC(+parts["year"]!, +parts["month"]! - 1, +parts["day"]!, +parts["hour"]!, +parts["minute"]!, +parts["second"]!) - Math.floor(ms / 1000) * 1000;
}

/** 19:00 in `tz` on the local date `date` (a UTC-midnight ms standing for that date) */
function sevenPm(date: number, tz: string): number {
  const wall = date + 19 * 3_600_000;
  const guess = wall - offsetAt(wall, tz);
  return wall - offsetAt(guess, tz);
}

/**
 * The next digest: the first Sunday 19:00 in `tz` after `now`, computed with Intl so the clock
 * change (2026-10-25 in Paris) moves it by the hour it should.
 */
export function nextRun(now: number, tz = "Europe/Paris"): number {
  const local = Date.parse(utcDay(now + offsetAt(now, tz)));
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = local + ahead * DAY_MS;
    if (new Date(date).getUTCDay() !== 0) continue;
    const at = sevenPm(date, tz);
    if (at > now) return at;
  }
  // eight local dates hold two Sundays, one of them past `now`
  throw new Error("no Sunday in eight days");
}

/** The last scheduled cut at or before `now`. */
export function lastRun(now: number, tz = "Europe/Paris"): number {
  // cuts are 167 to 169 h apart: one is within 8 days back
  let cut = nextRun(now - 8 * DAY_MS, tz);
  for (let next = nextRun(cut, tz); next <= now; next = nextRun(cut, tz)) cut = next;
  return cut;
}

/** The week a digest built at `now` is for: the Monday (UTC) of the scheduled cut's week, also for a run late into Monday. */
export const digestWeek = (now: number): string => utcDay(mondayOf(lastRun(now)));

const TOKEN_FIELDS = ["input", "cacheRead", "cacheWrite", "coldWrite", "firstWrite", "output", "calls"] as const;

/** `models` less what `counted` already held, model by model, never below 0 */
function less(models: readonly HostCostModel[], counted: readonly HostCostModel[] | undefined): HostCostModel[] {
  if (!counted?.length) return [...models];
  return models.map((each) => {
    const before = counted.find((other) => other.model === each.model);
    if (!before) return each;
    const rest: HostCostModel = { ...each };
    for (const field of TOKEN_FIELDS) rest[field] = Math.max(0, (each[field] ?? 0) - (before[field] ?? 0));
    return rest;
  });
}

const lessCounts = (counts: Counts, counted: Counts | undefined): Counts => counted
  ? { restarts: Math.max(0, counts.restarts - counted.restarts), firstWrites: Math.max(0, counts.firstWrites - counted.firstWrites), handoffs: Math.max(0, counts.handoffs - counted.handoffs) }
  : counts;

const spent = (models: readonly HostCostModel[]): boolean => models.some((each) => TOKEN_FIELDS.some((field) => (each[field] ?? 0) > 0));

/**
 * What the week cost, from every PC's cost logs (`costs` null: the PC was not read, named in
 * `offline`), priced with the Costs sheet's own costSplit, and the keep-warm plugin's days.
 */
export function buildDigest(input: {
  now: number; previous: DigestSnapshot | null; pcs: readonly DigestPc[];
  prices: ModelPrices; fallback: Record<string, ModelPrice> | null; keepWarm: KeepWarmState | null;
}): DigestSnapshot {
  const { now, previous, prices, fallback } = input;
  const week = digestWeek(now);
  const from = previous ? previous.cut : Date.parse(week);
  const cutDayKey = utcDay(now);
  const dayKeys: string[] = [];
  for (let day = Date.parse(utcDay(from)); day <= Date.parse(cutDayKey); day += DAY_MS) dayKeys.push(utcDay(day));
  const earlier = previous?.cutDay;

  const days = new Map(dayKeys.map((day) => [day, { day, usd: 0, restartsUsd: 0 }]));
  const total = emptySplit();
  const restarts = { n: 0, usd: 0 };
  const firstWrites = { n: 0, usd: 0 };
  let handoffs = 0;
  const chats: DigestSnapshot["chats"] = [];
  const pcs: DigestSnapshot["pcs"] = [];
  const offline: string[] = [];
  const noCounts: string[] = [];
  const cutDay: DigestSnapshot["cutDay"] = { day: cutDayKey, perChat: {}, counts: {}, keepWarm: null };

  for (const pc of input.pcs) {
    if (!pc.costs) { offline.push(pc.name); continue; }
    const titles = new Map(pc.rows.map((row) => [row.session, row.title]));
    const sum = { machineId: pc.machineId, name: pc.name, usd: 0, chats: 0 };
    let counted = false;
    for (const chat of pc.costs.chats) {
      const key = chatKey(pc.machineId, chat.session);
      if (chat.dayCounts) counted = true;
      const own = { usd: 0, restarts: 0, any: false };
      for (const day of dayKeys) {
        const raw = chat.days[day];
        const rawCounts = chat.dayCounts?.[day];
        if (day === cutDayKey) {
          if (raw?.length) cutDay.perChat[key] = raw;
          if (rawCounts) cutDay.counts[key] = rawCounts;
        }
        if (!raw?.length) continue;
        const models = day === earlier?.day ? less(raw, earlier.perChat[key]) : raw;
        if (!spent(models)) continue;
        const counts = rawCounts ? (day === earlier?.day ? lessCounts(rawCounts, earlier.counts[key]) : rawCounts) : { restarts: 0, firstWrites: 0, handoffs: 0 };
        const split = costSplit(models, prices, fallback);
        split.floor ||= chat.partial || !pc.costs.complete;
        addSplit(total, split);
        const bar = days.get(day)!;
        bar.usd += split.usd;
        bar.restartsUsd += split.restarts;
        restarts.usd += split.restarts;
        restarts.n += counts.restarts;
        firstWrites.usd += split.firstWrite;
        firstWrites.n += counts.firstWrites;
        handoffs += counts.handoffs;
        own.usd += split.usd;
        own.restarts += counts.restarts;
        own.any = true;
      }
      if (!own.any) continue;
      sum.usd += own.usd;
      sum.chats += 1;
      chats.push({ machineId: pc.machineId, session: chat.session, title: titles.get(chat.session) ?? "", usd: own.usd, restarts: own.restarts });
    }
    // a bridge before ZAC-262 answers no dayCounts at all: its money counts, its counts are 0
    if (!counted && sum.chats > 0) noCounts.push(pc.name);
    if (sum.chats > 0) pcs.push(sum);
  }

  // keep-warm: the plugin's finished days, its live today for the cut day, the earlier cut day's live today taken off
  const keepWarm: KeepWarmSums = { pings: 0, usd: 0, avoided: 0, avoidedUsd: 0 };
  const state = input.keepWarm;
  if (state) {
    const byDay = new Map<string, KeepWarmSums>((state.history ?? []).map((each) => [each.day, each]));
    if (state.today?.day) byDay.set(state.today.day, state.today);
    for (const day of dayKeys) {
      const sums = byDay.get(day);
      if (!sums) continue;
      const taken = day === earlier?.day ? earlier.keepWarm : null;
      keepWarm.pings += Math.max(0, sums.pings - (taken?.pings ?? 0));
      keepWarm.usd += Math.max(0, sums.usd - (taken?.usd ?? 0));
      keepWarm.avoided += Math.max(0, sums.avoided - (taken?.avoided ?? 0));
      keepWarm.avoidedUsd += Math.max(0, sums.avoidedUsd - (taken?.avoidedUsd ?? 0));
    }
    if (state.today?.day === cutDayKey) cutDay.keepWarm = { ...state.today };
  }

  chats.sort((a, b) => b.usd - a.usd);
  pcs.sort((a, b) => b.usd - a.usd);
  return {
    week, from, cut: now, built: now, total: { usd: total.usd, floor: total.floor }, days: [...days.values()], chats: chats.slice(0, 5), pcs,
    offline, noCounts, restarts, firstWrites, handoffs, keepWarm, cutDay,
  };
}

const money = digestUsd;
const nothing = (usd: number): boolean => Math.abs(usd) < 0.005;

/**
 * The notification (spec §4, exact): `📊 $184 this week · ▲ $22` (▼ when lower, no arrow the first
 * week, nor when the same), and `Cold restarts $18 · keep-warm saved ~$25 · 4 hand-offs`, a part
 * with 0 left out, then `· <PC> not counted` per offline PC. Keep-warm's net saving is what the
 * restarts it avoided would have cost less its pings; a week where the pings cost more says nothing
 * here (the page shows the rows).
 */
export function digestText(s: DigestSnapshot, previous: DigestSnapshot | null): { title: string; body: string } {
  const delta = previous ? s.total.usd - previous.total.usd : 0;
  const arrow = previous && money(delta) !== money(0) ? ` · ${delta > 0 ? "▲" : "▼"} ${money(delta)}` : "";
  const parts: string[] = [];
  if (!nothing(s.restarts.usd)) parts.push(`Cold restarts ${money(s.restarts.usd)}`);
  const saved = s.keepWarm.avoidedUsd - s.keepWarm.usd;
  if (saved >= 0.005) parts.push(`keep-warm saved ~${money(saved)}`);
  if (s.handoffs > 0) parts.push(`${s.handoffs} ${s.handoffs === 1 ? "hand-off" : "hand-offs"}`);
  for (const name of s.offline) parts.push(`${name} not counted`);
  return { title: `📊 ${money(s.total.usd)} this week${arrow}`, body: parts.join(" · ") || "Tap to see the week" };
}

/** How many weeks are kept (spec §4) */
export const DIGEST_WEEKS = 12;

/** The saved digests, newest first: `$STATE/digests.json` (0600), the last 12 weeks, one per week. */
export class DigestStore {
  private readonly path: string;
  private digests: DigestSnapshot[];
  constructor(stateDir: string) {
    this.path = join(stateDir, "digests.json");
    this.digests = [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (Array.isArray(raw)) this.digests = raw.filter((each): each is DigestSnapshot => !!each && typeof each === "object" && typeof each.week === "string" && typeof each.cut === "number");
    } catch { /* none yet, or unreadable: the next digest starts the file again */ }
    this.digests.sort((a, b) => b.cut - a.cut);
  }
  list(): DigestSnapshot[] { return [...this.digests]; }
  get(week: string): DigestSnapshot | null { return this.digests.find((each) => each.week === week) ?? null; }
  /** a digest for a week already saved replaces it: never two for one week */
  add(snapshot: DigestSnapshot): void {
    this.digests = [snapshot, ...this.digests.filter((each) => each.week !== snapshot.week)].sort((a, b) => b.cut - a.cut).slice(0, DIGEST_WEEKS);
    writePrivateState(this.path, this.digests);
  }
}

/** How late a digest missed while the server was down still runs at start (spec §4) */
export const DIGEST_LATE_MS = 12 * 3_600_000;

/**
 * Runs `run` at each Sunday 19:00 Paris: one timer, armed again from nextRun after each run (a
 * clock change moves the next by its hour, never an interval's drift). At start, a run missed while
 * the server was down is made now if it is less than 12 h late and no saved digest has a cut since
 * (Ovis restarted at 18:59 and back at 20:30: one digest, not two); later than that the week is
 * skipped.
 */
export function createDigestScheduler(deps: {
  store: Pick<DigestStore, "list">;
  run: (now: number) => Promise<void>;
  now?: () => number;
  /** absent: an unref'd setTimeout */
  timer?: (fn: () => void, ms: number) => () => void;
}): { start(): Promise<void>; stop(): void; idle(): Promise<void> } {
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return () => clearTimeout(handle); });
  let cancel: (() => void) | null = null;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;
  const due = (at: number): boolean => {
    const cut = lastRun(at);
    return at - cut < DIGEST_LATE_MS && !deps.store.list().some((each) => each.cut >= cut);
  };
  const once = (at: number): Promise<void> => deps.run(at).catch((error: unknown) => {
    console.error(`weekly digest: ${error instanceof Error ? error.message : String(error)}`);
  });
  function arm(): void {
    cancel?.();
    if (stopped) return;
    const at = now();
    cancel = timer(() => {
      cancel = null;
      running = (async () => {
        const fired = now();
        if (due(fired)) await once(fired);
        arm();
      })();
    }, Math.max(0, nextRun(at) - at));
  }
  return {
    async start() {
      const at = now();
      if (due(at)) { running = once(at); await running; }
      arm();
    },
    stop() { stopped = true; cancel?.(); cancel = null; },
    idle: () => running,
  };
}

/**
 * One digest: read every PC and the plugin, build against last week's saved digest, save it, then
 * tell it. Saved before it is told, so the page a tap opens always has it.
 */
export function digestRunner(deps: {
  store: DigestStore;
  pcs: () => Promise<DigestPc[]>;
  prices: () => Promise<{ prices: ModelPrices | null; fallback: Record<string, ModelPrice> | null }>;
  keepWarm: () => Promise<KeepWarmState | null>;
  send: (week: string, text: { title: string; body: string }) => Promise<void>;
}): (now: number) => Promise<void> {
  return async (now) => {
    const [pcs, prices, keepWarm] = await Promise.all([deps.pcs(), deps.prices(), deps.keepWarm().catch(() => null)]);
    const week = digestWeek(now);
    // the digest this one continues from: the newest of an earlier week (a skipped week's days fall in this one)
    const previous = deps.store.list().find((each) => each.week < week) ?? null;
    const snapshot = buildDigest({ now, previous, pcs, prices: prices.prices ?? {}, fallback: prices.fallback, keepWarm });
    deps.store.add(snapshot);
    await deps.send(week, digestText(snapshot, previous));
  };
}

/** GET /api/costs/digests (the saved weeks, newest first) and GET /api/costs/digest?week= (one), for the "This week" page. */
export function handleDigestRequest(request: Request, url: URL, store: DigestStore): Response | null {
  if (url.pathname !== "/api/costs/digests" && url.pathname !== "/api/costs/digest") return null;
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  if (url.pathname === "/api/costs/digests") return jsonResponse({ digests: store.list() }, 200, { "cache-control": "no-store" });
  const week = url.searchParams.get("week") ?? "";
  const found = /^\d{4}-\d{2}-\d{2}$/.test(week) ? store.get(week) : null;
  return found ? jsonResponse({ digest: found }, 200, { "cache-control": "no-store" })
    : jsonResponse({ error: { code: "not_found", message: "No digest for that week" } }, 404);
}
