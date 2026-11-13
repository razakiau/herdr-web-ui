import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_CHECKS, GoalStore, spent, type GoalCheck } from "./store.ts";

const START = {
  machineId: "pc-fictional",
  session: "session-fictional",
  parent: null,
  objective: "FICTIONAL: make the tests pass",
  doneWhen: "FICTIONAL: bun test exits 0",
  capUsd: 10,
  baselineUsd: 2,
  judge: { model: "fictional/gpt-5", warning: null },
} as const;

describe("GoalStore", () => {
  let stateDir: string;
  let clock: number;
  const now = (): number => clock;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "ovis-goals-")); clock = Date.UTC(2026, 10, 13, 18); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it("starts a goal with nothing spent, and it survives a new store on the same dir", () => {
    const started = new GoalStore(stateDir, now).start({ ...START, judge: { ...START.judge } });
    expect(started).toMatchObject({ status: "active", pauseReason: null, chatUsd: 0, judgeUsd: 0, unpriced: [], lastJudgedCallAt: null, judge: { model: "fictional/gpt-5", warning: null, checks: [] } });
    expect(started.startedAt).toBe(new Date(clock).toISOString());
    expect(started.updatedAt).toBe(started.startedAt);
    const again = new GoalStore(stateDir, now);
    expect(again.get(START.machineId, START.session)).toEqual(started);
    expect(again.list()).toEqual([started]);
    if (process.platform !== "win32") expect(statSync(join(stateDir, "goals.json")).mode & 0o777).toBe(0o600);
  });

  it("raise to a value at or below what is spent throws below_spent and changes nothing", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    store.update(START.machineId, START.session, (goal) => { goal.chatUsd = 6; goal.judgeUsd = 1; });
    const before = readFileSync(join(stateDir, "goals.json"), "utf8");
    clock += 1000;
    expect(() => store.raise(START.machineId, START.session, 7)).toThrow("below_spent");
    expect(() => store.raise(START.machineId, START.session, 3)).toThrow("below_spent");
    expect(store.get(START.machineId, START.session)?.capUsd).toBe(10);
    expect(readFileSync(join(stateDir, "goals.json"), "utf8")).toBe(before);
    expect(spent(store.get(START.machineId, START.session)!)).toBe(7);
  });

  it("raise on budget_limited sets active and clears pauseReason", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    store.update(START.machineId, START.session, (goal) => { goal.chatUsd = 10; goal.status = "budget_limited"; goal.pauseReason = "FICTIONAL: cap reached"; });
    clock += 5000;
    const raised = store.raise(START.machineId, START.session, 20);
    expect(raised).toMatchObject({ capUsd: 20, status: "active", pauseReason: null, updatedAt: new Date(clock).toISOString() });
    expect(new GoalStore(stateDir, now).get(START.machineId, START.session)).toEqual(raised);
  });

  it("raise on paused keeps it paused, with its reason", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    store.update(START.machineId, START.session, (goal) => { goal.status = "paused"; goal.pauseReason = "FICTIONAL: judge error"; });
    expect(store.raise(START.machineId, START.session, 30)).toMatchObject({ capUsd: 30, status: "paused", pauseReason: "FICTIONAL: judge error" });
  });

  it("a second start while running throws goal_running; a met or stopped goal is replaced", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    for (const status of ["active", "paused", "budget_limited"] as const) {
      store.update(START.machineId, START.session, (goal) => { goal.status = status; });
      expect(() => store.start({ ...START, objective: "FICTIONAL: another", judge: { ...START.judge } })).toThrow("goal_running");
    }
    store.update(START.machineId, START.session, (goal) => { goal.status = "met"; goal.chatUsd = 4; });
    const replaced = store.start({ ...START, objective: "FICTIONAL: another", judge: { ...START.judge } });
    expect(replaced).toMatchObject({ objective: "FICTIONAL: another", status: "active", chatUsd: 0 });
    expect(store.list()).toHaveLength(1);
    // another chat on the same PC is its own goal
    store.start({ ...START, session: "session-fictional-2", judge: { ...START.judge } });
    expect(store.list()).toHaveLength(2);
  });

  it("stop sets stopped; an unknown goal gives null to stop and update", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    expect(store.stop(START.machineId, START.session)?.status).toBe("stopped");
    expect(new GoalStore(stateDir, now).get(START.machineId, START.session)?.status).toBe("stopped");
    expect(store.stop(START.machineId, "session-unknown")).toBeNull();
    expect(store.update(START.machineId, "session-unknown", () => {})).toBeNull();
    expect(() => store.raise(START.machineId, "session-unknown", 50)).toThrow("not_found");
  });

  it("a check saved before `sent` existed loads as sent", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    const file = join(stateDir, "goals.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { judge: { checks: unknown[] } }[];
    raw[0]!.judge.checks.push({ at: "t", callAt: "c", verdict: "not_met", reason: "FICTIONAL", usd: 0 });
    writeFileSync(file, JSON.stringify(raw));
    expect(new GoalStore(stateDir, now).get(START.machineId, START.session)!.judge.checks).toEqual([{ at: "t", callAt: "c", verdict: "not_met", reason: "FICTIONAL", usd: 0, sent: true }]);
  });

  it("a goal waits for the owner only when started so; one saved before `away` existed loads as assume", () => {
    const store = new GoalStore(stateDir, now);
    expect(store.start({ ...START, away: "wait", judge: { ...START.judge } }).away).toBe("wait");
    expect(store.start({ ...START, session: "session-fictional-2", judge: { ...START.judge } }).away).toBe("assume");
    const file = join(stateDir, "goals.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { away?: string }[];
    for (const goal of raw) delete goal.away;
    writeFileSync(file, JSON.stringify(raw));
    expect(new GoalStore(stateDir, now).list().map((goal) => goal.away)).toEqual(["assume", "assume"]);
  });

  it("update keeps the newest checks only", () => {
    const store = new GoalStore(stateDir, now);
    store.start({ ...START, judge: { ...START.judge } });
    const check = (n: number): GoalCheck => ({ at: `t${n}`, callAt: `c${n}`, verdict: "not_met", reason: `FICTIONAL ${n}`, usd: 0.01, sent: true });
    store.update(START.machineId, START.session, (goal) => { for (let n = 0; n < GOAL_CHECKS + 5; n++) goal.judge.checks.push(check(n)); });
    const checks = new GoalStore(stateDir, now).get(START.machineId, START.session)!.judge.checks;
    expect(checks).toHaveLength(GOAL_CHECKS);
    expect(checks[0]).toEqual(check(5));
    expect(checks.at(-1)).toEqual(check(GOAL_CHECKS + 4));
  });

  it("an unreadable goals.json starts empty", () => {
    writeFileSync(join(stateDir, "goals.json"), "{not json");
    expect(new GoalStore(stateDir, now).list()).toEqual([]);
    writeFileSync(join(stateDir, "goals.json"), JSON.stringify({ goals: "nope" }));
    expect(new GoalStore(stateDir, now).list()).toEqual([]);
  });

  it("returns copies: changing one does not change the store", () => {
    const store = new GoalStore(stateDir, now);
    const started = store.start({ ...START, judge: { ...START.judge } });
    started.capUsd = 999;
    store.get(START.machineId, START.session)!.judge.checks.push({ at: "x", callAt: "x", verdict: "met", reason: "x", usd: 0, sent: true });
    expect(store.get(START.machineId, START.session)).toMatchObject({ capUsd: 10, judge: { checks: [] } });
  });
});
