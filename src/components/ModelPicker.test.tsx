import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { JudgeChoice } from "../../shared/goal-budget.ts";
import type { GoalView } from "../../shared/goals.ts";
import type { HostModel, HostSessionConfig } from "../../shared/host-chats.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SettingsList, type GoalStart } from "./ModelPicker.tsx";

const CONFIG: HostSessionConfig = { mode: "interactive", modes: ["interactive", "plan", "autopilot"], approvals: "default", approvalModes: ["default", "assisted", "autoApprove"] };
const JUDGES: JudgeChoice[] = [
  { id: "FICTIONAL-gpt-judge", why: "default" },
  { id: "FICTIONAL-cheap", why: "cheapest" },
  { id: "FICTIONAL-claude-mini", why: "same_family" },
];
const MODELS: HostModel[] = [{ id: "FICTIONAL-gpt-judge", name: "FICTIONAL GPT Judge", provider: "openai", efforts: null, context: null }];
const DRAFT = "FICTIONAL import the 4 Q3 files";
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  machineId: "m1", session: "s1", parent: null, objective: DRAFT, doneWhen: "FICTIONAL 4 files in",
  status: "active", pauseReason: null, away: "assume", capUsd: 25, baselineUsd: 0, chatUsd: 0.4, judgeUsd: 0.02, unpriced: [],
  judge: { model: "FICTIONAL-gpt-judge", warning: null, checks: [] }, lastJudgedCallAt: null,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  spentUsd: 0.42, tone: "ok", raises: null, ...over,
});

describe("Chat settings: Goal", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {},
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
  const classed = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
    root.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
  const group = (root: ReactTestInstance, label: string): ReactTestInstance =>
    root.find((each) => each.type === "section" && each.props["aria-label"] === label);
  const button = (root: ReactTestInstance, words: string): ReactTestInstance =>
    root.find((each) => each.type === "button" && textOf(each) === words);
  const press = async (node: ReactTestInstance): Promise<void> => { await act(async () => { (node.props["onClick"] as () => void)(); }); };
  const goalRow = (root: ReactTestInstance): ReactTestInstance => root.find((each) => each.type === "button" && each.props["data-mode"] === "goal");

  interface Props { goal?: GoalView | null; goalAgain?: GoalView | null; goalDraft?: string | null; error?: string | null; onStartGoal?: (input: GoalStart) => Promise<string | null>; onStopGoal?: () => Promise<void> }
  const element = (props: Props) => createElement(SettingsProvider, { children: createElement(SettingsList, {
    config: CONFIG, agents: [], agent: null, models: MODELS, error: props.error ?? null, onConfig() {}, onAgent() {}, onClose() {},
    goal: props.goal ?? null, goalAgain: props.goalAgain ?? null, goalDraft: props.goalDraft === undefined ? DRAFT : props.goalDraft, judges: JUDGES,
    onStartGoal: props.onStartGoal ?? (async () => null), onStopGoal: props.onStopGoal ?? (async () => {}),
  }) });
  async function mount(props: Props = {}): Promise<ReactTestInstance> {
    await act(async () => { renderer = create(element(props)); });
    return renderer!.root;
  }

  it("Goal is the Mode group's fourth row", async () => {
    const root = await mount();
    const rows = classed(group(root, "Mode"), "host-picker-option");
    expect(rows.length).toBe(4);
    expect(textOf(rows[3]!)).toBe("GoalWorks until a judge agrees it's done");
    expect(rows[3]!.findAll((each) => typeof each.props["className"] === "string" && (each.props["className"] as string).includes("lucide-target")).length).toBe(1);
    expect(rows[3]!.props["aria-pressed"]).toBe(false);
    // nothing of the form until it is picked
    expect(root.findAll((each) => each.type === "textarea")).toEqual([]);
  });

  it("picking Goal shows its form, filled in from the last message", async () => {
    const root = await mount();
    await press(goalRow(root));
    expect(goalRow(root).props["aria-pressed"]).toBe(true);
    const done = group(root, "Done when");
    expect(done.find((each) => each.type === "textarea").props["value"]).toBe(DRAFT);
    expect(textOf(classed(done, "host-picker-note")[0]!)).toBe("The judge only reads the chat, so name proof it can see: a command and its output.");
    const chips = classed(group(root, "Budget"), "host-picker-chip");
    expect(chips.map(textOf)).toEqual(["$10", "$25", "$50", "$100", "Other…"]);
    expect(chips.map((each) => each.props["aria-pressed"])).toEqual([false, true, false, false, false]);
    const judges = classed(group(root, "Judge"), "host-picker-option");
    expect(judges.map((each) => each.props["aria-pressed"])).toEqual([true, false, false]);
    expect(textOf(judges[0]!)).toContain("FICTIONAL GPT Judge");
    expect(textOf(judges[1]!)).toBe("FICTIONAL-cheapCheapest · another family");
    expect(textOf(judges[2]!)).toBe("FICTIONAL-claude-miniSame family as the worker: it may go easy on it");
    const away = classed(group(root, "While you're away"), "host-picker-option");
    expect(away.map(textOf)).toEqual([
      "Take its recommended answerOnly for questions it marks optional, after 1 min with no Ovis open. Blocking ones wait.",
      "Wait for meEvery question waits until you answer",
    ]);
    expect(away.map((each) => each.props["aria-pressed"])).toEqual([true, false]);
    expect(button(root, "Start goal")).toBeDefined();
    expect(button(root, "Cancel")).toBeDefined();
  });

  it("a stopped goal started again opens the form with its done-when, cap, judge and away rule, and starts with them", async () => {
    const stopped = goal({ status: "stopped", doneWhen: "FICTIONAL verify passes", capUsd: 50, away: "wait", judge: { model: "FICTIONAL-cheap", warning: null, checks: [] } });
    const calls: GoalStart[] = [];
    const root = await mount({ goal: stopped, goalAgain: stopped, onStartGoal: async (input) => { calls.push(input); return null; } });
    expect(goalRow(root).props["aria-pressed"]).toBe(true);
    expect(group(root, "Done when").find((each) => each.type === "textarea").props["value"]).toBe("FICTIONAL verify passes");
    expect(classed(group(root, "Budget"), "host-picker-chip").map((each) => each.props["aria-pressed"])).toEqual([false, false, true, false, false]);
    expect(classed(group(root, "Judge"), "host-picker-option").map((each) => each.props["aria-pressed"])).toEqual([false, true, false]);
    expect(classed(group(root, "While you're away"), "host-picker-option").map((each) => each.props["aria-pressed"])).toEqual([false, true]);
    await press(button(root, "Start goal"));
    expect(calls).toEqual([{ doneWhen: "FICTIONAL verify passes", capUsd: 50, judgeModel: "FICTIONAL-cheap", away: "wait", allowUnpriced: false }]);
  });

  it("started again with a cap not on offer, it is Other…; with a judge no longer on offer, the default", async () => {
    const stopped = goal({ status: "stopped", capUsd: 7.5, judge: { model: "FICTIONAL-gone", warning: null, checks: [] } });
    const root = await mount({ goal: stopped, goalAgain: stopped });
    expect(classed(group(root, "Budget"), "host-picker-chip").map((each) => each.props["aria-pressed"])).toEqual([false, false, false, false, true]);
    expect(root.find((each) => each.type === "input" && each.props["aria-label"] === "Budget in dollars").props["value"]).toBe("7.5");
    expect(classed(group(root, "Judge"), "host-picker-option").map((each) => each.props["aria-pressed"])).toEqual([true, false, false]);
  });

  it("starts with what the form says", async () => {
    const calls: GoalStart[] = [];
    const root = await mount({ onStartGoal: async (input) => { calls.push(input); return null; } });
    await press(goalRow(root));
    await act(async () => { (root.find((each) => each.type === "textarea").props["onChange"] as (event: unknown) => void)({ target: { value: "FICTIONAL verify passes" } }); });
    await press(button(root, "$50"));
    await press(classed(group(root, "Judge"), "host-picker-option")[1]!);
    await press(classed(group(root, "While you're away"), "host-picker-option")[1]!);
    await press(button(root, "Start goal"));
    expect(calls).toEqual([{ doneWhen: "FICTIONAL verify passes", capUsd: 50, judgeModel: "FICTIONAL-cheap", away: "wait", allowUnpriced: false }]);
  });

  it("Other… takes a dollar amount above zero", async () => {
    const calls: GoalStart[] = [];
    const root = await mount({ onStartGoal: async (input) => { calls.push(input); return null; } });
    await press(goalRow(root));
    await press(button(root, "Other…"));
    const input = group(root, "Budget").find((each) => each.type === "input");
    await act(async () => { (input.props["onChange"] as (event: unknown) => void)({ target: { value: "0" } }); });
    expect(button(root, "Start goal").props["disabled"]).toBe(true);
    await act(async () => { (input.props["onChange"] as (event: unknown) => void)({ target: { value: "12.5" } }); });
    expect(button(root, "Start goal").props["disabled"]).toBe(false);
    await press(button(root, "Start goal"));
    expect(calls[0]?.capUsd).toBe(12.5);
  });

  it("with no message yet, Goal cannot be picked", async () => {
    const root = await mount({ goalDraft: null });
    const row = goalRow(root);
    expect(row.props["disabled"]).toBe(true);
    expect(textOf(row)).toBe("GoalSend the first message, then start a goal");
  });

  it("an unpriced judge asks before starting anyway", async () => {
    const calls: GoalStart[] = [];
    const root = await mount({ onStartGoal: async (input) => { calls.push(input); return input.allowUnpriced ? null : "unpriced_model"; } });
    await press(goalRow(root));
    await press(button(root, "Start goal"));
    expect(textOf(root)).toContain("This model has no price, so the cap can't count its spend.");
    await press(button(root, "Start anyway"));
    expect(calls.map((each) => each.allowUnpriced)).toEqual([false, true]);
  });

  for (const status of ["active", "paused", "budget_limited"] as const) {
    it(`a ${status} goal is picked, with Stop goal in place of the form`, async () => {
      let stopped = 0;
      const root = await mount({ goal: goal({ status }), onStopGoal: async () => { stopped++; } });
      expect(goalRow(root).props["aria-pressed"]).toBe(true);
      expect(root.findAll((each) => each.type === "textarea")).toEqual([]);
      expect(root.findAll((each) => each.type === "button" && textOf(each) === "Start goal")).toEqual([]);
      await press(button(root, "Stop goal"));
      expect(stopped).toBe(1);
    });
  }

  it("a refusal shows its words and keeps what was typed", async () => {
    const root = await mount({ onStartGoal: async () => "goal_exists" });
    await press(goalRow(root));
    await act(async () => { (root.find((each) => each.type === "textarea").props["onChange"] as (event: unknown) => void)({ target: { value: "FICTIONAL typed" } }); });
    await press(button(root, "Start goal"));
    // the host gives the server's words as the sheet's error
    await act(async () => { renderer!.update(element({ error: "FICTIONAL this chat already has a goal" })); });
    expect(textOf(classed(root, "host-picker-error")[0]!)).toBe("FICTIONAL this chat already has a goal");
    expect(root.find((each) => each.type === "textarea").props["value"]).toBe("FICTIONAL typed");
  });
});
