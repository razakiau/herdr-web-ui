import { describe, expect, it } from "bun:test";

import type { HostTodo } from "../../shared/host-chats.ts";
import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import { nextTurnText } from "../../server/goals/runner.ts";
import { goalCheckOf, goalHead } from "./hostGoals.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

const check = (): GoalCheck => ({ at: "2026-11-13T11:00:00.000Z", callAt: "2026-11-13T11:00:00.000Z", verdict: "not_met", reason: "FICTIONAL", usd: 0.01, sent: true });

const view = (over: Partial<GoalView>): GoalView => ({
  machineId: "local",
  session: "s-1",
  parent: null,
  objective: "FICTIONAL import the year",
  doneWhen: "FICTIONAL every month imported",
  status: "active",
  pauseReason: null,
  away: "assume",
  capUsd: 25,
  baselineUsd: 0,
  chatUsd: 0,
  judgeUsd: 0,
  unpriced: [],
  judge: { model: "judge-model", warning: null, checks: [] },
  lastJudgedCallAt: null,
  startedAt: new Date(NOW - 5 * 60_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  spentUsd: 0,
  tone: "ok",
  raises: null,
  ...over,
});

let ids = 0;
const todo = (status: HostTodo["status"], title = "FICTIONAL step"): HostTodo => ({ id: String(++ids), title, status });

describe("a check message", () => {
  it("reads the runner's check message", () => {
    const text = nextTurnText({ check: 2, reason: "verify was not run", doneWhen: "verify passes", spentUsd: 1.5, capUsd: 10 });
    expect(goalCheckOf(text)).toEqual({ check: 2, reason: "verify was not run", rest: expect.stringContaining("Keep working toward the whole goal:") });
  });

  it("leaves a look-alike typed by a person as their words", () => {
    expect(goalCheckOf("[Goal, check 2] Not done yet: x")).toBeNull();
  });

  it("is only a check from the message's start", () => {
    const text = nextTurnText({ check: 1, reason: "FICTIONAL", doneWhen: "FICTIONAL", spentUsd: 0, capUsd: 10 });
    expect(goalCheckOf(`hello ${text}`)).toBeNull();
  });
});

describe("a goal's head", () => {
  it("heads a running goal with its spend and the todo it is on", () => {
    expect(goalHead(view({ status: "active", spentUsd: 3.1, capUsd: 25 }), [todo("done"), todo("in_progress", "Import August")], NOW))
      .toEqual({ title: "Goal $3.10 / $25", current: "1/2 · Import August", tone: "accent" });
  });

  it("heads a running goal with no todos with the time it has run", () => {
    const goal = view({ startedAt: new Date(NOW - 61_000).toISOString() });
    expect(goalHead(goal, [], NOW).current).toBe("1 min in");
    expect(goalHead(goal, undefined, NOW).current).toBe("1 min in");
    expect(goalHead(view({ startedAt: new Date(NOW - 65 * 60_000).toISOString() }), undefined, NOW).current).toBe("1h 5m in");
  });

  it("turns to notice from 80 % of the cap", () => {
    expect(goalHead(view({ spentUsd: 20, capUsd: 25, tone: "notice" }), undefined, NOW).tone).toBe("notice");
    expect(goalHead(view({ spentUsd: 26, capUsd: 25, tone: "over" }), undefined, NOW).tone).toBe("notice");
  });

  it("heads a paused goal Paused · $25.00 / $25, a met one Goal met · $27.10 with its check count", () => {
    expect(goalHead(view({ status: "budget_limited", spentUsd: 25, capUsd: 25, tone: "over" }), undefined, NOW))
      .toEqual({ title: "Paused · $25.00 / $25", current: "0 checks", tone: "notice" });
    expect(goalHead(view({ status: "paused", spentUsd: 4, capUsd: 25.5 }), undefined, NOW).title).toBe("Paused · $4.00 / $25.50");
    const checks = [check(), check(), check(), check(), check()];
    expect(goalHead(view({ status: "met", spentUsd: 27.1, judge: { model: "judge-model", warning: null, checks } }), undefined, NOW))
      .toEqual({ title: "Goal met · $27.10", current: "5 checks", tone: "done" });
    expect(goalHead(view({ status: "met", spentUsd: 27 }), undefined, NOW).title).toBe("Goal met · $27.00");
  });

  it("heads a stopped goal as ended, with one check said once", () => {
    expect(goalHead(view({ status: "stopped", spentUsd: 1.234, judge: { model: "judge-model", warning: null, checks: [check()] } }), undefined, NOW))
      .toEqual({ title: "Goal stopped · $1.23", current: "1 check", tone: "ended" });
  });
});
