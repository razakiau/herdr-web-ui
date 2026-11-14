import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { HostTodo } from "../../shared/host-chats.ts";
import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import { nextTurnText } from "../../server/goals/runner.ts";
import { noteHostChatMessage } from "./hostChats.ts";
import { goalCheckOf, goalHead, pauseReasonWords, useHostGoal } from "./hostGoals.ts";

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
  it("heads a running goal Goal with its spend and the todo it is on", () => {
    expect(goalHead(view({ status: "active", spentUsd: 3.1, capUsd: 25 }), [todo("done"), todo("in_progress", "Import August")], NOW))
      .toEqual({ title: "Goal", spent: "$3.10", cap: "$25", current: "1/2 · Import August", tone: "accent", ring: "run" });
  });

  it("heads a running goal with no todos with its checks, else the time it has run", () => {
    const goal = view({ startedAt: new Date(NOW - 61_000).toISOString() });
    expect(goalHead(goal, [], NOW).current).toBe("1 min in");
    expect(goalHead(goal, undefined, NOW).current).toBe("1 min in");
    expect(goalHead(view({ startedAt: new Date(NOW - 65 * 60_000).toISOString() }), undefined, NOW).current).toBe("1h 5m in");
    expect(goalHead(view({ judge: { model: "judge-model", warning: null, checks: [check(), check(), check()] } }), undefined, NOW).current).toBe("3 checks");
  });

  it("turns to notice from 80 % of the cap", () => {
    expect(goalHead(view({ spentUsd: 20, capUsd: 25, tone: "notice" }), undefined, NOW).tone).toBe("notice");
    expect(goalHead(view({ spentUsd: 26, capUsd: 25, tone: "over" }), undefined, NOW).tone).toBe("notice");
  });

  it("heads a paused goal Paused, with why in a word or two", () => {
    expect(goalHead(view({ status: "budget_limited", pauseReason: "cap", spentUsd: 25, capUsd: 25, tone: "over" }), undefined, NOW))
      .toEqual({ title: "Paused", spent: "$25.00", cap: "$25", current: "at cap", tone: "notice", ring: "pause" });
    expect(goalHead(view({ status: "paused", pauseReason: "owner", spentUsd: 4, capUsd: 25.5 }), [todo("in_progress")], NOW))
      .toEqual({ title: "Paused", spent: "$4.00", cap: "$25.50", current: "by you", tone: "notice", ring: "pause" });
    const word = (pauseReason: string, verdict: GoalCheck["verdict"] = "not_met"): string =>
      goalHead(view({ status: "paused", pauseReason, judge: { model: "judge-model", warning: null, checks: [{ ...check(), verdict }] } }), undefined, NOW).current;
    expect(word("judge_error: timeout")).toBe("judge error");
    expect(word("send_failed")).toBe("send failed");
    expect(word("no_log")).toBe("can't read");
    expect(word("FICTIONAL the files are gone", "impossible")).toBe("impossible");
    expect(word("FICTIONAL")).toBe("needs you");
  });

  it("heads a met goal Goal met with its check count, a stopped one Stopped by you", () => {
    const checks = [check(), check(), check(), check(), check()];
    expect(goalHead(view({ status: "met", spentUsd: 27.1, judge: { model: "judge-model", warning: null, checks } }), undefined, NOW))
      .toEqual({ title: "Goal met", spent: "$27.10", cap: "$25", current: "5 checks", tone: "done", ring: "met" });
    expect(goalHead(view({ status: "met", judge: { model: "judge-model", warning: null, checks: [check()] } }), undefined, NOW).current).toBe("1 check");
    expect(goalHead(view({ status: "stopped", spentUsd: 1.234, judge: { model: "judge-model", warning: null, checks: [check()] } }), undefined, NOW))
      .toEqual({ title: "Stopped", spent: "$1.23", cap: "$25", current: "by you", tone: "ended", ring: "stop" });
  });
});

describe("a pause's reason in words", () => {
  it("words each known reason, says nothing more for the owner's, and shows an unknown one as it is", () => {
    expect(pauseReasonWords("owner")).toBeNull();
    expect(pauseReasonWords(null)).toBeNull();
    expect(pauseReasonWords("judge_error: OmniRoute refused the token")).toBe("The judge failed: OmniRoute refused the token.");
    expect(pauseReasonWords("no_chat")).toBe("The chat is gone from its PC.");
    expect(pauseReasonWords("no_cost")).toBe("Its cost can't be read.");
    expect(pauseReasonWords("no_log")).toBe("Its log can't be read.");
    expect(pauseReasonWords("send_failed")).toBe("The next turn couldn't be sent.");
    expect(pauseReasonWords("cap")).toBe("It reached its cap.");
    expect(pauseReasonWords("FICTIONAL the files are not on this PC")).toBe("FICTIONAL the files are not on this PC");
  });
});

describe("useHostGoal", () => {
  const keys = ["fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let reads: number;

  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    reads = 0;
    const define = (key: string, value: unknown): void => { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("fetch", async () => {
      reads++;
      return new Response(JSON.stringify({ goals: [] }), { headers: { "content-type": "application/json" } });
    });
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const mount = async (): Promise<void> => {
    const Probe = () => { useHostGoal("m", "s"); return null; };
    await act(async () => { renderer = create(createElement(Probe)); });
  };
  const push = (machine = "m", session = "s"): void => { noteHostChatMessage(machine, { type: "host-chat-changed", session }); };

  it("a burst of this chat's pushes reads the goal once at once and once when 2 s have passed", async () => {
    await mount();
    expect(reads).toBe(1);
    for (let n = 0; n < 6; n++) { push(); jest.advanceTimersByTime(300); }
    push("m", "other");
    push("other-pc", "s");
    expect(reads).toBe(2);
    jest.advanceTimersByTime(199);
    expect(reads).toBe(2);
    jest.advanceTimersByTime(1);
    expect(reads).toBe(3);
    // the trailing read starts a window of its own; a quiet one owes nothing
    jest.advanceTimersByTime(10_000);
    expect(reads).toBe(3);
    push();
    expect(reads).toBe(4);
  });

  it("a read owed when the chat closes is never made", async () => {
    await mount();
    push();
    push();
    expect(reads).toBe(2);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    jest.advanceTimersByTime(10_000);
    expect(reads).toBe(2);
  });
});
