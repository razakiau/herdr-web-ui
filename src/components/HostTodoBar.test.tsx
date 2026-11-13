import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import type { HostTodo } from "../../shared/host-chats.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { currentTodo, HostTodoBar } from "./HostTodoBar.tsx";

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

  it("with a goal, the head is the goal's spend against its cap and how long it has run", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: true, goal: goal() }));
    expect(text(html)).toContain("Goal $0.42 / $25");
    expect(text(html)).toContain("1 min in");
    expect(html).toContain('data-tone="accent"');
    expect(html).toContain("width:1.7%");
    expect(html).not.toContain("todo-bar-list");
  });

  it("opened, lists the todos first, then the goal's terms and its checks", () => {
    const html = render(createElement(HostTodoBar, { todos: SIX, busy: true, defaultOpen: true, goal: goal({
      judge: { model: "FICTIONAL-judge", warning: "same_family", checks: [check("not_met", "FICTIONAL two left"), check("error", "FICTIONAL timeout")] },
    }) }));
    const sections = [...html.matchAll(/<p class="goal-bar-section">(.*?)<\/p>/g)].map((match) => text(match[1]!));
    expect(sections).toEqual(["Todos 2/6", "Goal"]);
    const words = said(html);
    expect(words.indexOf("Todos 2/6")).toBeLessThan(words.lastIndexOf("FICTIONAL c"));
    expect(words.indexOf("FICTIONAL f")).toBeLessThan(words.indexOf("Done when: FICTIONAL 4 files in"));
    expect(words).toContain("Judge FICTIONAL-judge · same family");
    expect(words).toContain("While you're away: takes its recommended answer");
    expect(words).toContain("Check 1 · not met: FICTIONAL two left");
    expect(words).toContain("Check 2 · error: FICTIONAL timeout");
    expect(html.match(/class="todo-bar-row"/g)?.length).toBe(6 + 3 + 2 + 1);
    expect(words).toContain("2/6 · FICTIONAL c");
  });

  it("names the judge plainly when it is not the worker's family, and says when it waits", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, defaultOpen: true, goal: goal({ away: "wait" }) }));
    const words = said(html);
    expect(words).toContain("Judge FICTIONAL-judge");
    expect(words).not.toContain("same family");
    expect(words).toContain("While you're away: waits for you");
    expect(html).not.toContain("goal-bar-section");
  });

  it("met, turns green, opens by default and says what it spent", () => {
    const html = render(createElement(HostTodoBar, { todos: undefined, busy: false, goal: goal({
      status: "met", chatUsd: 24.8, judgeUsd: 1, spentUsd: 25.8, capUsd: 35,
      judge: { model: "FICTIONAL-judge", warning: null, checks: [check("met", "FICTIONAL all in")] },
    }) }));
    expect(html).toContain('data-tone="done"');
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain("Goal met · $25.80");
    expect(text(html)).toContain("Check 1 · met: FICTIONAL all in");
    expect(text(html)).toContain("Chat $24.80 · judge $1.00 · cap $35");
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
