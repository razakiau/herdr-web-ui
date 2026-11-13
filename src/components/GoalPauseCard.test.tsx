import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { GoalCheck, GoalView } from "../../shared/goals.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { GoalPauseCard, goalPausePrompt } from "./GoalPauseCard.tsx";

const t = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);
const check = (): GoalCheck => ({ at: "2026-11-13T10:00:00.000Z", callAt: "2026-11-13T10:00:00.000Z", verdict: "not_met", reason: "FICTIONAL", usd: 0.2, sent: true });
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  machineId: "m1", session: "s1", parent: null, objective: "FICTIONAL import Q3", doneWhen: "FICTIONAL 4 files in",
  status: "budget_limited", pauseReason: "cap", away: "assume", capUsd: 25, baselineUsd: 0, chatUsd: 24.4, judgeUsd: 1, unpriced: [],
  judge: { model: "FICTIONAL-judge", warning: null, checks: [check(), check(), check(), check(), check()] }, lastJudgedCallAt: null,
  startedAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T10:00:00.000Z",
  spentUsd: 25.4, tone: "over", raises: [35, 50], ...over,
});
const labels = (value: GoalView): string[] => goalPausePrompt(value, t).options.map((each) => each.label);

describe("goalPausePrompt", () => {
  it("at its cap, offers the two raises, the first recommended, and a stop", () => {
    const prompt = goalPausePrompt(goal(), t);
    expect(prompt.title).toBe("Goal paused at its $25 budget");
    expect(prompt.body).toBe("Spent $25.40: chat $24.40, judge $1.00, over 5 checks.");
    expect(labels(goal())).toEqual(["Raise to $35 and continue", "Raise to $50 and continue", "Stop here"]);
    expect(prompt.options[0]?.recommended).toBe(true);
    expect(prompt.options.slice(1).some((each) => each.recommended)).toBe(false);
    expect(prompt.custom_option_index).toBeNull();
    expect(prompt.kind).toBe("menu");
    expect(prompt.agent).toBe("copilot");
    expect(prompt.id).toBe("goal:s1:budget_limited:25");
  });

  it("counts one check as one", () => {
    expect(goalPausePrompt(goal({ judge: { model: "FICTIONAL-judge", warning: null, checks: [check()] } }), t).body).toBe("Spent $25.40: chat $24.40, judge $1.00, over 1 check.");
  });

  it("paused by the judge's failure, says it and offers resume or stop", () => {
    const paused = goal({ status: "paused", pauseReason: "judge_error: OmniRoute refused the token", raises: null });
    const prompt = goalPausePrompt(paused, t);
    expect(prompt.title).toBe("Goal paused");
    expect(prompt.body).toBe("The judge failed: OmniRoute refused the token.");
    expect(labels(paused)).toEqual(["Resume", "Stop here"]);
    expect(prompt.id).toBe("goal:s1:paused:25");
  });

  it("words each known reason, and shows an unknown one as it is", () => {
    const body = (pauseReason: string): string | null => goalPausePrompt(goal({ status: "paused", pauseReason, raises: null }), t).body;
    expect(body("no_chat")).toBe("The chat is gone from its PC.");
    expect(body("no_cost")).toBe("Its cost can't be read.");
    expect(body("no_log")).toBe("Its log can't be read.");
    expect(body("send_failed")).toBe("The next turn couldn't be sent.");
    expect(body("cap")).toBe("It reached its cap.");
    expect(body("FICTIONAL the files are not on this PC")).toBe("FICTIONAL the files are not on this PC");
  });
});

describe("GoalPauseCard", () => {
  const keys = ["window", "document", "navigator", "fetch", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let posted: { url: string; body: unknown }[];
  let answer: () => Response;

  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    posted = [];
    answer = () => new Response(JSON.stringify({ goal: goal({ status: "active", capUsd: 35 }) }), { headers: { "content-type": "application/json" } });
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

  /** the card for `shown`, and a press on its option `index` (0-based); resolves to how many times it said it was done */
  const choose = async (shown: GoalView, index: number): Promise<number> => {
    let done = 0;
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(GoalPauseCard, { machineId: "m1", session: "s1", goal: shown, onDone: () => { done++; } }) })); });
    const options = renderer!.root.findAll((node: ReactTestInstance) => node.type === "button" && String(node.props.className).includes("prompt-card-option"));
    expect(options.length).toBe(shown.status === "budget_limited" ? 3 : 2);
    await act(async () => { options[index]!.props.onClick({ nativeEvent: {}, currentTarget: {} }); });
    return done;
  };

  it("choosing the first raise raises the cap to it, then says it is done", async () => {
    const done = await choose(goal(), 0);
    expect(posted).toEqual([{ url: "/api/goals/raise", body: { machine: "m1", session: "s1", capUsd: 35 } }]);
    expect(done).toBe(1);
  });

  it("resumes a paused goal, and stops one", async () => {
    expect(await choose(goal({ status: "paused", pauseReason: "send_failed", raises: null }), 0)).toBe(1);
    await act(async () => { renderer?.unmount(); });
    expect(await choose(goal({ status: "paused", pauseReason: "send_failed", raises: null }), 1)).toBe(1);
    expect(posted.map((each) => each.url)).toEqual(["/api/goals/resume", "/api/goals/stop"]);
  });

  it("a refusal stays on the card with the server's words, and it is not done", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "below_spent", message: "FICTIONAL The cap must be above what is spent ($25.40)" } }), { status: 409, headers: { "content-type": "application/json" } });
    expect(await choose(goal(), 1)).toBe(0);
    renderer!.root.find((node: ReactTestInstance) => node.props.className === "prompt-card-error");
    expect(JSON.stringify(renderer!.toJSON())).toContain("FICTIONAL The cap must be above what is spent ($25.40)");
  });
});
