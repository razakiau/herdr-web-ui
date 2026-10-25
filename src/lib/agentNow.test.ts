import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { agentNow, attentionRank } from "./agentNow.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const pane = (over: Partial<HerdrPane>): HerdrPane => ({ pane_id: "p", agent_status: "working", ...over }) as HerdrPane;

describe("agentNow", () => {
  it("a blocked pane waits for you, in the ask tone", () => {
    expect(agentNow(pane({}), "blocked", t)).toEqual({ text: "Waiting for you", tone: "ask" });
  });
  it("a working pane says its plan's current step and how far", () => {
    expect(agentNow(pane({ plan: { done: 2, total: 5, current: "Run tests" } }), "working", t)).toEqual({ text: "Run tests · 2/5", tone: "plain" });
  });
  it("a plan without a current step says how far only", () => {
    expect(agentNow(pane({ plan: { done: 2, total: 5, current: null } }), "working", t)).toEqual({ text: "2/5", tone: "plain" });
  });
  it("nothing to say without a wait or a plan", () => {
    expect(agentNow(pane({}), "working", t)).toBeNull();
    expect(agentNow(pane({}), undefined, t)).toBeNull();
  });
});

describe("attentionRank", () => {
  it("needs you, then working, then an unread finish, then the rest", () => {
    expect(["idle", "done", "working", "blocked", undefined].map((status) => attentionRank(status))).toEqual([3, 2, 1, 0, 3]);
  });
});
