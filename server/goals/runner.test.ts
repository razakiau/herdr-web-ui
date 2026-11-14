import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostChatCost, HostChatRow } from "../../shared/host-chats.ts";
import type { ModelPrices } from "../../shared/usage.ts";
import type { JudgeComplete } from "./judge.ts";
import { createGoalRunner, type GoalPc } from "./runner.ts";
import { GoalStore } from "./store.ts";

const MACHINE = "pc-fictional";
const SESSION = "session-fictional";
const T1 = "2026-11-13T18:00:00.000Z";
const T2 = "2026-11-13T18:05:00.000Z";
// work-x: 100k input tokens = $1; judge-x: 1000 in + 100 out = $0.0011
const PRICES: ModelPrices = { fictional: { "work-x": { input: 10, output: 10 }, "judge-x": { input: 1, output: 1 } } };
const START = {
  machineId: MACHINE, session: SESSION, parent: null,
  objective: "FICTIONAL: make the tests pass", doneWhen: "FICTIONAL: bun test exits 0",
  capUsd: 10, baselineUsd: 0.2,
  judge: { model: "fictional/judge-x", warning: null },
} as const;

class FakePc implements GoalPc {
  status: HostChatRow["status"] = "idle";
  archived = false;
  /** the chat's unanswered async questions; undefined leaves `waiting` off the row */
  waiting: number | undefined = undefined;
  lastCallAt: string | null = T1;
  input = 100_000;
  digestText: string | null | "offline" = "USER: FICTIONAL\nAGENT: done";
  offline = false;
  /** the PC answers but lists no such chat, or has no cost for it */
  chatMissing = false;
  costMissing = false;
  sendOk = true;
  sent: { session: string; text: string; callAt?: string }[] = [];
  async row(session: string): Promise<HostChatRow | null | "offline"> {
    if (this.offline) return "offline";
    if (this.chatMissing) return null;
    return { session, title: "FICTIONAL", status: this.status, modified_at: T1, cwd: null, unread: false, archived: this.archived, ...(this.waiting === undefined ? {} : { waiting: this.waiting }) };
  }
  async cost(session: string): Promise<HostChatCost | null | "offline"> {
    if (this.offline) return "offline";
    if (this.costMissing) return null;
    return { session, models: [{ model: "fictional/work-x", input: this.input, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1 }], lastCallAt: this.lastCallAt, context: null } as HostChatCost;
  }
  async digest(): Promise<string | null | "offline"> { return this.offline ? "offline" : this.digestText; }
  async send(session: string, text: string, callAt: string): Promise<boolean> { this.sent.push({ session, text, callAt }); return this.sendOk; }
}

describe("goal runner", () => {
  let stateDir: string;
  let pc: FakePc;
  let answers: (() => Promise<{ text: string; usage: { input: number; cached: number; output: number } }>)[];
  let calls: number;
  let pricesCalls: number;
  let lines: string[];
  const clock = Date.UTC(2026, 10, 13, 18, 10);
  const verdict = (v: string, reason: string) => async () => ({ text: JSON.stringify({ verdict: v, reason }), usage: { input: 1000, cached: 0, output: 100 } });
  const complete: JudgeComplete = async () => {
    calls += 1;
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    return next();
  };
  const runner = (store: GoalStore, prices: () => Promise<{ prices: ModelPrices | null; fallback: null }> = async () => { pricesCalls += 1; return { prices: PRICES, fallback: null }; }) =>
    createGoalRunner({ store, pcs: (id) => id === MACHINE ? pc : null, prices, complete, now: () => clock, log: (line) => { lines.push(line); } });
  const started = (overrides: Partial<{ capUsd: number; baselineUsd: number }> = {}): GoalStore => {
    const store = new GoalStore(stateDir, () => clock);
    store.start({ ...START, ...overrides, judge: { ...START.judge } });
    return store;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-goal-runner-"));
    pc = new FakePc();
    answers = [];
    calls = 0;
    pricesCalls = 0;
    lines = [];
  });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it("not_met queues one next turn with the reason, the check number, the rules and the spend", async () => {
    const store = started();
    answers.push(verdict("not_met", "FICTIONAL: no test output shown"));
    await runner(store).tick();
    expect(pc.sent).toHaveLength(1);
    expect(pc.sent[0]!.session).toBe(SESSION);
    // the judged call names the message, so a re-send of it is the same message
    expect(pc.sent[0]!.callAt).toBe(T1);
    expect(pc.sent[0]!.text).toBe(`[Goal, check 1] Not done yet: FICTIONAL: no test output shown

Keep working toward the whole goal:
- keep the whole objective; never shrink it to what fits in one turn;
- work from the repo as it is now, not from memory;
- don't swap in a smaller, safer or easier-to-test solution;
- before saying done, list each part of "done when" with the evidence that proves it;
- call it blocked only after the same blocker shows up 3 turns running.

Done when: FICTIONAL: bun test exits 0
Spent $0.80 of $10.00.`);
    const goal = store.get(MACHINE, SESSION)!;
    expect(goal.status).toBe("active");
    expect(goal.lastJudgedCallAt).toBe(T1);
    expect(goal.chatUsd).toBeCloseTo(0.8, 10);
    expect(goal.judgeUsd).toBeCloseTo(0.0011, 10);
    expect(goal.judge.checks).toEqual([{ at: new Date(clock).toISOString(), callAt: T1, verdict: "not_met", reason: "FICTIONAL: no test output shown", usd: expect.closeTo(0.0011, 10), sent: true }]);
  });

  it("a second tick on the same lastCallAt sends nothing and judges nothing", async () => {
    const store = started();
    answers.push(verdict("not_met", "FICTIONAL: more"), verdict("not_met", "FICTIONAL: again"));
    const run = runner(store);
    await run.tick();
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(1);
    pc.lastCallAt = T2;
    await run.tick();
    expect(calls).toBe(2);
    expect(pc.sent[1]!.text).toStartWith("[Goal, check 2] Not done yet: FICTIONAL: again");
  });

  it("asks prices once per tick for every goal", async () => {
    const store = started();
    store.start({ ...START, session: "session-fictional-2", judge: { ...START.judge } });
    answers.push(verdict("not_met", "a"), verdict("not_met", "b"));
    await runner(store).tick();
    expect(pricesCalls).toBe(1);
    expect(calls).toBe(2);
  });

  for (const status of ["working", "asks"] as const) {
    it(`a ${status} row waits`, async () => {
      const store = started();
      pc.status = status;
      const before = store.get(MACHINE, SESSION);
      await runner(store).tick();
      expect(calls).toBe(0);
      expect(pc.sent).toHaveLength(0);
      expect(store.get(MACHINE, SESSION)).toEqual(before);
    });
  }

  it("an idle row waiting on an async answer holds on a new call; without waiting it is judged as before", async () => {
    const store = started();
    answers.push(verdict("not_met", "FICTIONAL: first"), verdict("not_met", "FICTIONAL: second"));
    const run = runner(store);
    await run.tick();
    expect(calls).toBe(1);
    pc.lastCallAt = T2;
    pc.waiting = 1;
    const before = store.get(MACHINE, SESSION);
    await run.tick();
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(1);
    expect(store.get(MACHINE, SESSION)).toEqual(before);
    pc.waiting = undefined;
    await run.tick();
    expect(calls).toBe(2);
    expect(pc.sent[1]!.text).toStartWith("[Goal, check 2] Not done yet: FICTIONAL: second");
  });

  it("an archived row, or no call yet, waits", async () => {
    const store = started();
    pc.archived = true;
    await runner(store).tick();
    pc.archived = false;
    pc.lastCallAt = null;
    await runner(store).tick();
    expect(calls).toBe(0);
    expect(pc.sent).toHaveLength(0);
  });

  it("an error row is a finished turn", async () => {
    const store = started();
    pc.status = "error";
    answers.push(verdict("not_met", "FICTIONAL"));
    await runner(store).tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(1);
  });

  it("met marks the goal met and sends nothing", async () => {
    const store = started();
    answers.push(verdict("met", "FICTIONAL: test output shows 0 failures"));
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)!.status).toBe("met");
    expect(pc.sent).toHaveLength(0);
  });

  it("impossible pauses with the judge's reason", async () => {
    const store = started();
    answers.push(verdict("impossible", "FICTIONAL: the condition contradicts itself"));
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "paused", pauseReason: "FICTIONAL: the condition contradicts itself" });
    expect(pc.sent).toHaveLength(0);
  });

  it("a throwing judge pauses with judge_error and sends nothing", async () => {
    const store = started();
    answers.push(async () => { throw new Error("FICTIONAL: upstream down"); });
    await runner(store).tick();
    const goal = store.get(MACHINE, SESSION)!;
    expect(goal).toMatchObject({ status: "paused", pauseReason: "judge_error: FICTIONAL: upstream down", lastJudgedCallAt: T1 });
    expect(goal.judge.checks[0]).toMatchObject({ verdict: "error", usd: 0 });
    expect(pc.sent).toHaveLength(0);
  });

  it("a judge answer that is no verdict still adds its cost", async () => {
    const store = started();
    answers.push(async () => ({ text: "FICTIONAL: not json", usage: { input: 1000, cached: 0, output: 100 } }));
    await runner(store).tick();
    const goal = store.get(MACHINE, SESSION)!;
    expect(goal.status).toBe("paused");
    expect(goal.pauseReason).toStartWith("judge_error: ");
    expect(goal.judgeUsd).toBeCloseTo(0.0011, 10);
  });

  it("a spend at the cap is budget_limited and the judge is not called", async () => {
    const store = started({ capUsd: 1, baselineUsd: 0 });
    answers.push(verdict("met", "FICTIONAL"));
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "budget_limited", pauseReason: "cap", chatUsd: 1 });
    expect(calls).toBe(0);
    expect(pc.sent).toHaveLength(0);
  });

  it("a judge cost that reaches the cap is budget_limited and sends nothing; a raise then sends that check's turn once, judging nothing again", async () => {
    // the chat spent $0.80, under the cap; the judge's $0.0011 takes it to the cap
    const store = started({ capUsd: 0.8005 });
    answers.push(verdict("not_met", "FICTIONAL: still missing"), verdict("not_met", "FICTIONAL: never asked"));
    const run = runner(store);
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(0);
    const capped = store.get(MACHINE, SESSION)!;
    expect(capped).toMatchObject({ status: "budget_limited", pauseReason: "cap", lastJudgedCallAt: T1 });
    expect(capped.judge.checks.at(-1)).toMatchObject({ verdict: "not_met", callAt: T1, sent: false });
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(0);
    store.raise(MACHINE, SESSION, 5);
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(1);
    expect(pc.sent[0]!.text).toStartWith("[Goal, check 1] Not done yet: FICTIONAL: still missing");
    expect(pc.sent[0]!.callAt).toBe(T1);
    expect(store.get(MACHINE, SESSION)!.judge.checks.at(-1)!.sent).toBe(true);
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(1);
  });

  it("a met verdict whose judge cost reaches the cap is still met", async () => {
    const store = started({ capUsd: 0.8005 });
    answers.push(verdict("met", "FICTIONAL: shown"));
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)!.status).toBe("met");
  });

  it("a spend that is no number fails closed: budget_limited and no judge", async () => {
    const store = started();
    const run = runner(store, async () => ({ prices: { fictional: { "work-x": { input: Number.POSITIVE_INFINITY, output: 1 } } }, fallback: null }));
    await run.tick();
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "budget_limited", pauseReason: "cap" });
    expect(calls).toBe(0);
  });

  it("null prices price everything at $0", async () => {
    const store = started();
    answers.push(verdict("not_met", "FICTIONAL"));
    await runner(store, async () => ({ prices: null, fallback: null })).tick();
    const goal = store.get(MACHINE, SESSION)!;
    expect(goal).toMatchObject({ chatUsd: 0, judgeUsd: 0, unpriced: ["fictional/work-x"] });
    expect(pc.sent[0]!.text).toEndWith("Spent $0.00 of $10.00.");
  });

  it("an offline PC changes nothing and logs nothing: the next tick tries again", async () => {
    const store = started();
    const before = store.get(MACHINE, SESSION);
    pc.offline = true;
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toEqual(before);
    expect(lines).toEqual([]);
    expect(calls).toBe(0);
  });

  for (const [what, reason, set] of [
    ["no chat", "no_chat", () => { pc.chatMissing = true; }],
    ["no cost", "no_cost", () => { pc.costMissing = true; }],
    ["no log", "no_log", () => { pc.digestText = null; }],
  ] as const) {
    it(`a PC that answers with ${what} pauses the goal ${reason}, logs it and judges nothing`, async () => {
      const store = started();
      set();
      await runner(store).tick();
      const after = store.get(MACHINE, SESSION)!;
      expect(after).toMatchObject({ status: "paused", pauseReason: reason, lastJudgedCallAt: null });
      expect(after.judge.checks).toHaveLength(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${MACHINE}/${SESSION}`);
      expect(lines[0]).toContain(reason);
      expect(calls).toBe(0);
      expect(pc.sent).toHaveLength(0);
    });
  }

  it("prices that throw make the tick do nothing; a throwing step leaves the goal as it was", async () => {
    const store = started();
    const before = store.get(MACHINE, SESSION);
    await runner(store, async () => { throw new Error("FICTIONAL"); }).tick();
    expect(store.get(MACHINE, SESSION)).toEqual(before);
    pc.row = async () => { throw new Error("FICTIONAL: boom"); };
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toEqual(before);
    expect(calls).toBe(0);
  });

  it("restart: a turn finished while central was down is judged exactly once by a new store and runner", async () => {
    answers.push(verdict("not_met", "FICTIONAL: first"));
    await runner(started()).tick();
    expect(calls).toBe(1);
    // central is down; the chat finishes another turn
    pc.lastCallAt = T2;
    const store = new GoalStore(stateDir, () => clock);
    const run = runner(store);
    answers.push(verdict("not_met", "FICTIONAL: second"), verdict("not_met", "FICTIONAL: third"));
    await run.tick();
    await run.tick();
    await runner(new GoalStore(stateDir, () => clock)).tick();
    expect(calls).toBe(2);
    expect(pc.sent.map((each) => each.text.split("\n")[0])).toEqual(["[Goal, check 1] Not done yet: FICTIONAL: first", "[Goal, check 2] Not done yet: FICTIONAL: second"]);
    expect(new GoalStore(stateDir).get(MACHINE, SESSION)!.lastJudgedCallAt).toBe(T2);
  });

  it("a failed send pauses with send_failed", async () => {
    const store = started();
    pc.sendOk = false;
    answers.push(verdict("not_met", "FICTIONAL"));
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "paused", pauseReason: "send_failed", lastJudgedCallAt: T1 });
    expect(store.get(MACHINE, SESSION)!.judge.checks.at(-1)!.sent).toBe(false);
    expect(pc.sent).toHaveLength(1);
  });

  it("restart between saving the check and the send: a new store and runner re-send it once, with no judge call", async () => {
    answers.push(verdict("not_met", "FICTIONAL: still missing"));
    // central dies inside the first send: the call never returns, so `sent` is never saved
    const send = pc.send.bind(pc);
    const reached = Promise.withResolvers<void>();
    pc.send = (session, text) => { pc.sent.push({ session, text }); reached.resolve(); return new Promise<boolean>(() => {}); };
    void runner(started()).tick();
    await reached.promise;
    expect(pc.sent).toHaveLength(1);
    expect(new GoalStore(stateDir).get(MACHINE, SESSION)!.judge.checks.at(-1)).toMatchObject({ verdict: "not_met", sent: false, callAt: T1 });
    pc.send = send;
    const first = pc.sent[0]!.text;
    const store = new GoalStore(stateDir, () => clock);
    const run = runner(store);
    await run.tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(2);
    expect(pc.sent[1]!.text).toBe(first);
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "active", lastJudgedCallAt: T1 });
    expect(store.get(MACHINE, SESSION)!.judge.checks.at(-1)!.sent).toBe(true);
    await run.tick();
    await runner(new GoalStore(stateDir, () => clock)).tick();
    expect(pc.sent).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("a re-send that fails pauses with send_failed and judges nothing", async () => {
    answers.push(verdict("not_met", "FICTIONAL"));
    const reached = Promise.withResolvers<void>();
    pc.send = (session, text) => { pc.sent.push({ session, text }); reached.resolve(); return new Promise<boolean>(() => {}); };
    void runner(started()).tick();
    await reached.promise;
    pc.send = async () => { throw new Error("FICTIONAL: unreachable"); };
    const store = new GoalStore(stateDir, () => clock);
    await runner(store).tick();
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "paused", pauseReason: "send_failed" });
    expect(calls).toBe(1);
  });

  it("step acts only on a goal still active in the store", async () => {
    const store = started();
    const goal = store.get(MACHINE, SESSION)!;
    store.stop(MACHINE, SESSION);
    await runner(store).step(goal);
    expect(calls).toBe(0);
    expect(pc.sent).toHaveLength(0);
  });

  it("a goal its owner paused is not judged, sent for or re-paused, and keeps pauseReason owner", async () => {
    const store = started();
    store.update(MACHINE, SESSION, (goal) => { goal.status = "paused"; goal.pauseReason = "owner"; });
    answers.push(verdict("not_met", "FICTIONAL: never asked"));
    // a PC that would pause it for another reason changes nothing either
    pc.chatMissing = true;
    await runner(store).tick();
    await runner(store).step(store.get(MACHINE, SESSION)!);
    expect(calls).toBe(0);
    expect(pc.sent).toHaveLength(0);
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "paused", pauseReason: "owner", lastJudgedCallAt: null });
    expect(store.get(MACHINE, SESSION)!.judge.checks).toHaveLength(0);
  });

  it("paused by its owner while the judge runs: the check is kept, nothing is sent, the pause stays the owner's", async () => {
    const store = started();
    answers.push(async () => {
      store.update(MACHINE, SESSION, (goal) => { goal.status = "paused"; goal.pauseReason = "owner"; });
      return { text: JSON.stringify({ verdict: "not_met", reason: "FICTIONAL: half done" }), usage: { input: 1000, cached: 0, output: 100 } };
    });
    await runner(store).tick();
    expect(calls).toBe(1);
    expect(pc.sent).toHaveLength(0);
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "paused", pauseReason: "owner", lastJudgedCallAt: T1 });
    expect(store.get(MACHINE, SESSION)!.judge.checks.map((check) => check.verdict)).toEqual(["not_met"]);
  });
});
