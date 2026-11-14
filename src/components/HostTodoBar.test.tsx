import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import type { HostTodo } from "../../shared/host-chats.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { currentTodo } from "../lib/todos.ts";
import { HostTodoBar } from "./HostTodoBar.tsx";

const render = (element: ReactElement): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
/** the words of the goal card's buttons */
const buttonsIn = (html: string): string[] => [...html.matchAll(/<button type="button" class="btn goal-card-btn[^"]*">([^<]*)<\/button>/g)].map((match) => match[1]!);
/** the goal card's live region: what a screen reader announces when it changes */
const live = (html: string): string => said(/<div class="goal-card-live" role="status">(.*?)<\/div>/.exec(html)![1]!);
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** the text with React's escaped apostrophe read back */
const said = (html: string): string => text(html).replaceAll("&#x27;", "'");
const todo = (id: string, status: HostTodo["status"]): HostTodo => ({ id, title: `FICTIONAL ${id}`, status });
const check = (verdict: GoalCheck["verdict"], reason: string): GoalCheck => ({ at: "2026-11-13T10:00:00.000Z", callAt: "2026-11-13T10:00:00.000Z", verdict, reason, usd: 0.02, sent: true });
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  machineId: "m1", session: "s1", parent: null, objective: "FICTIONAL import Q3", doneWhen: "FICTIONAL 4 files in",
  status: "active", pauseReason: null, away: "assume", capUsd: 25, baselineUsd: 0, chatUsd: 0.4, judgeUsd: 0.02, unpriced: [],
  judge: { model: "FICTIONAL-judge", warning: null, checks: [] }, lastJudgedCallAt: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(), updatedAt: new Date().toISOString(),
  spentUsd: 0.42, tone: "ok", raises: null, ...over,
});
/** a localStorage of its own for the length of `run` */
const withStorage = <T,>(records: Map<string, string>, run: () => T): T => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } });
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
};
const SIX = [todo("a", "done"), todo("b", "done"), todo("c", "in_progress"), todo("d", "pending"), todo("e", "pending"), todo("f", "pending")];
const SEVEN = [todo("a", "done"), todo("b", "done"), todo("c", "done"), todo("d", "pending"), todo("e", "in_progress"), todo("f", "blocked"), todo("g", "pending")];

describe("HostTodoBar", () => {
  it("names the task in progress before an earlier pending one", () => {
    expect(currentTodo(SEVEN)?.id).toBe("e");
    expect(currentTodo([todo("a", "done"), todo("b", "pending")])?.id).toBe("b");
    expect(currentTodo([todo("a", "done")])).toBeNull();
  });

  it("closed, says how many are done, the current task and how far along it is", () => {
    const html = render(createElement(HostTodoBar, { todos: SEVEN, busy: true }));
    expect(text(html)).toContain("Todos 3/7");
    expect(text(html)).toContain("FICTIONAL e");
    expect(html).toContain("width:42.9%");
    expect(html).not.toContain("todo-bar-list");
  });

  it("is hidden with nothing to do, and once all is done in an idle chat", () => {
    expect(render(createElement(HostTodoBar, { todos: undefined, busy: true }))).toBe("");
    expect(render(createElement(HostTodoBar, { todos: [], busy: true }))).toBe("");
    const done = [todo("a", "done"), todo("b", "done")];
    expect(render(createElement(HostTodoBar, { todos: done, busy: false }))).toBe("");
    expect(text(render(createElement(HostTodoBar, { todos: done, busy: true })))).toContain("Todos 2/2");
  });

  it("open, lists every todo with its state", () => {
    const html = render(createElement(HostTodoBar, { todos: SEVEN, busy: true, defaultOpen: true }));
    expect(html.match(/class="todo-bar-row"/g)?.length).toBe(7);
    for (const status of ["done", "in_progress", "pending", "blocked"]) expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('aria-expanded="true"');
  });

  it("with a goal, the head is its ring, Goal, the spend against the cap and how long it has run, and a pause", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: true, goal: goal(), machineId: "m1", session: "s1" }));
    expect(text(html)).toContain("Goal $0.42 / $25");
    expect(text(html)).toContain("1 min in");
    expect(html).toContain('data-tone="accent"');
    expect(html).toContain("width:1.7%");
    expect(html).toContain('aria-label="Pause goal"');
    expect(html).not.toContain("goal-body");
  });

  it("a goal with no cap fills its bar when it has spent, and leaves it empty when not, never NaN", () => {
    const fill = (over: Partial<GoalView>): string => /todo-bar-fill" data-tone="\w+" style="width:([^"]*)"/.exec(render(createElement(HostTodoBar, { todos: undefined, busy: true, goal: goal(over) })))![1]!;
    expect(fill({ capUsd: 0, spentUsd: 0.42 })).toBe("100%");
    expect(fill({ capUsd: 0, spentUsd: 0 })).toBe("0%");
    expect(fill({ capUsd: Number.NaN, spentUsd: 0.42 })).toBe("100%");
    expect(fill({ capUsd: -5, spentUsd: 0 })).toBe("0%");
  });

  it("opened, lists the todos first, then the objective as a title, done-when, and only the latest check in its card", () => {
    const html = render(createElement(HostTodoBar, { todos: SIX, busy: true, defaultOpen: true, goal: goal({
      judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL first"), check("error", "FICTIONAL timeout"), check("not_met", "FICTIONAL two left")] },
    }) }));
    const sections = [...html.matchAll(/<p class="goal-bar-section">(.*?)<\/p>/g)].map((match) => text(match[1]!));
    expect(sections).toEqual(["Todos 2/6"]);
    const words = said(html);
    expect(words.indexOf("FICTIONAL f")).toBeLessThan(words.indexOf("FICTIONAL import Q3"));
    expect(html).toContain('<h3 class="goal-obj">FICTIONAL import Q3</h3>');
    expect(words).not.toContain("Goal:");
    expect(words.indexOf("FICTIONAL import Q3")).toBeLessThan(words.indexOf("Done when FICTIONAL 4 files in"));
    expect(/<div class="goal-card" data-tone="(\w+)">/.exec(html)![1]).toBe("notice");
    expect(live(html)).toBe("Check 3 · not met FICTIONAL two left");
    // the older ones fold behind one button until it is opened
    expect(words).toContain("2 earlier checks");
    expect(html).toContain('class="goal-earlier" aria-expanded="false"');
    expect(words).not.toContain("FICTIONAL first");
    expect(words).not.toContain("FICTIONAL timeout");
    // no checkbox-like rows for the goal: only the todos are rows
    expect(html.match(/class="todo-bar-row"/g)?.length).toBe(6);
    expect(words).toContain("2/6 · FICTIONAL c");
  });

  it("an error check's card is blocked, a met one done", () => {
    const tone = (verdict: GoalCheck["verdict"], status: GoalView["status"] = "active"): string =>
      /class="goal-card" data-tone="(\w+)"/.exec(render(createElement(HostTodoBar, { todos: undefined, busy: true, defaultOpen: true, goal: goal({ status, judge: { model: "FICTIONAL-judge", warning: null, checks: [check(verdict, "FICTIONAL")] } }) })))![1]!;
    expect(tone("error")).toBe("blocked");
    expect(tone("impossible")).toBe("notice");
    expect(tone("met", "met")).toBe("done");
  });

  it("one meta line: the judge's friendly name with a same-family chip, the away rule in words, and the spend", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, defaultOpen: true, goal: goal({ judge: { model: "cc/claude-sonnet-5-5", warning: "same_family", checks: [] } }) }));
    const meta = said(/<p class="goal-meta">(.*?)<\/p>/.exec(html)![1]!);
    expect(meta).toBe("Judge Sonnet 5.5 same family · away: takes its pick · chat $0.40 · judge $0.02");
    expect(html).toContain('<span class="goal-chip">same family</span>');
    const plain = said(render(createElement(HostTodoBar, { todos: undefined, busy: false, defaultOpen: true, goal: goal({ away: "wait" }) })));
    expect(plain).toContain("Judge FICTIONAL-judge");
    expect(plain).not.toContain("same family");
    expect(plain).toContain("away: waits for you");
    expect(plain).not.toContain("goal-bar-section");
  });

  it("paused by its owner: pause ring, Paused · by you, a resume in the head and in the card with the last check", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, machineId: "m1", session: "s1", goal: goal({
      status: "paused", pauseReason: "owner", judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL two left")] },
    }) }));
    // a paused goal opens to what it asks
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain("Paused $0.42 / $25");
    expect(text(html)).toContain("by you");
    expect(html).toContain("lucide-circle-pause");
    expect(html).toContain('aria-label="Resume goal"');
    expect(html).not.toContain('aria-label="Pause goal"');
    // the live region is the state and the last check: no buttons, and no time that moves with each write
    expect(live(html)).toBe("Paused by you Last check: FICTIONAL two left");
    expect(html).toMatch(/<\/div><time class="goal-card-time" dateTime="[^"]+">\d\d:\d\d<\/time>/);
    expect(buttonsIn(html)).toEqual(["Resume"]);
  });

  it("the card's live text stays the same when only the goal's update time moves", () => {
    const at = (updatedAt: string): string => live(render(createElement(HostTodoBar, { todos: undefined, busy: false, machineId: "m1", session: "s1", goal: goal({
      status: "paused", pauseReason: "send_failed", updatedAt, judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL two left")] },
    }) })));
    expect(at("2026-11-13T10:00:00.000Z")).toBe(at("2026-11-13T11:37:00.000Z"));
  });

  it("paused for a reason of the runner's: the reason in words, resume or stop", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, machineId: "m1", session: "s1", goal: goal({ status: "paused", pauseReason: "judge_error: OmniRoute refused the token" }) }));
    expect(text(html)).toContain("judge error");
    expect(said(html)).toContain("The judge failed: OmniRoute refused the token.");
    expect(buttonsIn(html)).toEqual(["Resume", "Stop"]);
  });

  it("paused by the runner: its whole reason on a line of its own, then the last check, clamped and tappable", () => {
    const long = `judge_error: ${"FICTIONAL OmniRoute answered 502 for claude-sonnet-5-5 ".repeat(4).trim()}`;
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, machineId: "m1", session: "s1", goal: goal({
      status: "paused", pauseReason: long, judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL two left")] },
    }) }));
    const region = /<div class="goal-card-live" role="status">(.*?)<\/div>/.exec(html)![1]!;
    expect(said(/<p class="goal-card-reason">(.*?)<\/p>/.exec(region)![1]!)).toBe(`The judge failed: ${long.slice("judge_error: ".length)}.`);
    expect(said(/<button type="button" class="goal-card-text" aria-expanded="false">(.*?)<\/button>/.exec(region)![1]!)).toBe("Last check: FICTIONAL two left");
    expect(live(html)).toMatch(/^Paused The judge failed: .+\. Last check: FICTIONAL two left$/);
  });

  it("at its cap: Paused · at cap, the card says the cap and offers the two raises and a stop", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, machineId: "m1", session: "s1", goal: goal({
      status: "budget_limited", pauseReason: "cap", spentUsd: 25.4, tone: "over", raises: [35, 50],
      judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL two left")] },
    }) }));
    expect(text(html)).toContain("Paused $25.40 / $25");
    expect(text(html)).toContain("at cap");
    expect(said(html)).toContain("Hit the $25 cap");
    expect(said(html)).toContain("Last check: FICTIONAL two left");
    expect(buttonsIn(html)).toEqual(["Raise to $35", "Raise to $50", "Stop"]);
    expect(html).toContain('class="btn goal-card-btn btn-primary"');
  });

  it("stopped: a cross in the ring, Stopped · by you, the last check and Start again…", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, defaultOpen: true, machineId: "m1", session: "s1", onStartAgain() {}, dismissKey: "m1:s1", goal: goal({
      status: "stopped", judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL two left")] },
    }) }));
    expect(html).toContain("lucide-circle-x");
    expect(text(html)).toContain("Stopped $0.42 / $25");
    expect(text(html)).toContain("by you");
    expect(said(html)).toContain("Last check: FICTIONAL two left");
    expect(buttonsIn(html)).toEqual(["Start again…"]);
    expect(html).toContain('aria-label="Dismiss goal"');
  });

  it("met: green with a check in its ring, closed by default, its checks counted", () => {
    const met = goal({ status: "met", chatUsd: 24.8, judgeUsd: 1, spentUsd: 25.8, capUsd: 35,
      judge: { model: "FICTIONAL-judge", warning: null, checks: [check("not_met", "FICTIONAL first"), check("met", "FICTIONAL all in")] } });
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, goal: met }));
    expect(html).toContain('data-tone="done"');
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toContain("Goal met $25.80 / $35");
    expect(text(html)).toContain("2 checks");
    expect(html).not.toContain("goal-body");
    const opened = said(render(createElement(HostTodoBar, { todos: undefined, busy: false, defaultOpen: true, goal: met })));
    expect(opened).toContain("Check 2 · met FICTIONAL all in");
    expect(opened).toContain("1 earlier check");
  });

  it("an ended goal can be dismissed; once it is, only the todos are left", () => {
    const stopped = goal({ status: "stopped" });
    const records = new Map<string, string>();
    const shown = withStorage(records, () => render(createElement(HostTodoBar, { todos: undefined, busy: false, goal: stopped, dismissKey: "m1:s1" })));
    expect(shown).toContain('aria-label="Dismiss goal"');
    expect(withStorage(records, () => render(createElement(HostTodoBar, { todos: undefined, busy: false, goal: goal(), dismissKey: "m1:s1" })))).not.toContain("Dismiss goal");
    records.set(`ovis.goal-dismissed:m1:s1:${stopped.startedAt}`, "1");
    expect(withStorage(records, () => render(createElement(HostTodoBar, { todos: undefined, busy: false, goal: stopped, dismissKey: "m1:s1" })))).toBe("");
    const plain = render(createElement(HostTodoBar, { todos: SEVEN, busy: true }));
    expect(withStorage(records, () => render(createElement(HostTodoBar, { todos: SEVEN, busy: true, goal: stopped, dismissKey: "m1:s1" })))).toBe(plain);
  });

  it("with no goal, draws the todo bar exactly as before", () => {
    const plain = render(createElement(HostTodoBar, { todos: SEVEN, busy: true, defaultOpen: true }));
    expect(render(createElement(HostTodoBar, { todos: SEVEN, busy: true, defaultOpen: true, goal: null }))).toBe(plain);
    expect(plain).not.toContain("goal-bar");
  });
});
