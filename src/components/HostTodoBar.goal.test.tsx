import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HostTodoBar } from "./HostTodoBar.tsx";

const check = (n: number, verdict: GoalCheck["verdict"] = "not_met"): GoalCheck => ({ at: `2026-11-13T10:0${n}:00.000Z`, callAt: `2026-11-13T10:0${n}:00.000Z`, verdict, reason: `FICTIONAL reason ${n}`, usd: 0.2, sent: true });
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  machineId: "m1", session: "s1", parent: null, objective: "FICTIONAL import Q3", doneWhen: "FICTIONAL 4 files in",
  status: "active", pauseReason: null, away: "assume", capUsd: 25, baselineUsd: 0, chatUsd: 0.4, judgeUsd: 0.08, unpriced: [],
  judge: { model: "FICTIONAL-judge", warning: null, checks: [check(1), check(2), check(3)] }, lastJudgedCallAt: null,
  startedAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T10:00:00.000Z",
  spentUsd: 0.48, tone: "ok", raises: null, ...over,
});

describe("HostTodoBar's goal actions", () => {
  const keys = ["window", "document", "navigator", "fetch", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let posted: { url: string; body: unknown }[];
  let answer: () => Response;
  let changed: number;
  let again: GoalView[];

  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    posted = [];
    changed = 0;
    again = [];
    answer = () => new Response(JSON.stringify({ goal: goal() }), { headers: { "content-type": "application/json" } });
    const define = (key: string, value: unknown): void => { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("navigator", { languages: ["en"] });
    define("window", { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), localStorage: { getItem: () => null, setItem() {} } });
    define("document", { activeElement: null, body: {}, visibilityState: "visible", addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null });
    define("getComputedStyle", () => ({ getPropertyValue: () => "#12100e" }));
    define("fetch", async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return answer();
    });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const show = async (shown: GoalView, defaultOpen = true): Promise<void> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(HostTodoBar, {
        todos: undefined, busy: false, defaultOpen, goal: shown, dismissKey: "m1:s1", machineId: "m1", session: "s1",
        onGoalChanged: () => { changed++; }, onStartAgain: (from: GoalView) => { again.push(from); },
      }) }));
    });
  };
  const button = (label: string): ReactTestInstance => renderer!.root.find((node: ReactTestInstance) => node.type === "button" && (node.props["aria-label"] === label || words(node) === label));
  const press = async (label: string): Promise<void> => { await act(async () => { button(label).props.onClick(); }); };
  const words = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : words(child)).join("");
  const said = (): string => JSON.stringify(renderer!.toJSON());

  it("the head's pause pauses the goal, then says it changed", async () => {
    await show(goal(), false);
    await press("Pause goal");
    expect(posted).toEqual([{ url: "/api/goals/pause", body: { machine: "m1", session: "s1" } }]);
    expect(changed).toBe(1);
  });

  it("a goal paused by its owner resumes from the head and from its card", async () => {
    await show(goal({ status: "paused", pauseReason: "owner" }));
    await press("Resume goal");
    await press("Resume");
    expect(posted.map((each) => each.url)).toEqual(["/api/goals/resume", "/api/goals/resume"]);
    expect(changed).toBe(2);
  });

  it("at its cap, the first raise raises the cap to it, and Stop stops it", async () => {
    await show(goal({ status: "budget_limited", pauseReason: "cap", raises: [35, 50], spentUsd: 25.4 }));
    expect(() => button("Resume goal")).toThrow();
    await press("Raise to $35");
    await press("Stop");
    expect(posted).toEqual([
      { url: "/api/goals/raise", body: { machine: "m1", session: "s1", capUsd: 35 } },
      { url: "/api/goals/stop", body: { machine: "m1", session: "s1" } },
    ]);
  });

  it("a refusal stays on the card with the server's words, and nothing is said to have changed", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "below_spent", message: "FICTIONAL The cap must be above what is spent ($25.40)" } }), { status: 409, headers: { "content-type": "application/json" } });
    await show(goal({ status: "budget_limited", pauseReason: "cap", raises: [35, 50], spentUsd: 25.4 }));
    await press("Raise to $50");
    expect(changed).toBe(0);
    renderer!.root.find((node: ReactTestInstance) => node.props.className === "goal-card-error" && node.props.role === "alert");
    expect(said()).toContain("FICTIONAL The cap must be above what is spent ($25.40)");
  });

  it("stopped: Start again… hands the old goal to the start flow, and posts nothing", async () => {
    const stopped = goal({ status: "stopped" });
    await show(stopped);
    await press("Start again…");
    expect(again).toEqual([stopped]);
    expect(posted).toEqual([]);
  });

  it("shows the latest check alone until the earlier ones are opened, then each on a line, newest first", async () => {
    await show(goal());
    const card = renderer!.root.find((node: ReactTestInstance) => node.props.className === "goal-card");
    expect(words(card)).toContain("Check 3 · not met");
    expect(said()).not.toContain("FICTIONAL reason 2");
    expect(button("2 earlier checks").props["aria-expanded"]).toBe(false);
    await press("2 earlier checks");
    expect(button("2 earlier checks").props["aria-expanded"]).toBe(true);
    const lines = renderer!.root.findAll((node: ReactTestInstance) => node.type === "li").map(words);
    expect(lines).toEqual(["2not met: FICTIONAL reason 2", "1not met: FICTIONAL reason 1"]);
  });

  it("the done-when and the card's reason open whole on a tap", async () => {
    await show(goal());
    const when = (): ReactTestInstance => renderer!.root.find((node: ReactTestInstance) => node.props.className === "goal-when");
    const reason = (): ReactTestInstance => renderer!.root.find((node: ReactTestInstance) => node.props.className === "goal-card-text");
    expect(when().props["aria-expanded"]).toBe(false);
    await act(async () => { when().props.onClick(); });
    expect(when().props["aria-expanded"]).toBe(true);
    await act(async () => { reason().props.onClick(); });
    expect(reason().props["aria-expanded"]).toBe(true);
  });

  it("a running goal that pauses opens its tab to what it asks", async () => {
    await show(goal(), false);
    expect(renderer!.root.findAll((node: ReactTestInstance) => node.props.className === "goal-body")).toHaveLength(0);
    await act(async () => {
      renderer!.update(createElement(SettingsProvider, { children: createElement(HostTodoBar, {
        todos: undefined, busy: false, goal: goal({ status: "budget_limited", pauseReason: "cap", raises: [35, 50] }), machineId: "m1", session: "s1",
      }) }));
    });
    expect(renderer!.root.findAll((node: ReactTestInstance) => node.props.className === "goal-body")).toHaveLength(1);
  });
});
