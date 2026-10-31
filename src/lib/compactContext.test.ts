import { describe, expect, test } from "bun:test";

import type { HostCommand } from "../../shared/host-chats.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { compactCommandText, handoffCommandText, handoffOffer } from "./compactContext.ts";

const command = (name: string, trigger?: "$"): SlashCommand => ({ name, description: "", source: "builtin", ...(trigger ? { trigger } : {}) });

describe("compactCommandText", () => {
  test("names the slash command when the agent lists compact", () => {
    expect(compactCommandText([command("model"), command("compact")])).toBe("/compact");
  });
  test("is null when the agent lists no compact", () => {
    expect(compactCommandText([command("model"), command("compaction")])).toBeNull();
    expect(compactCommandText([])).toBeNull();
  });
  test("ignores a $-skill named compact", () => {
    expect(compactCommandText([command("compact", "$")])).toBeNull();
  });
});

describe("handoffCommandText", () => {
  const skill = (name: string): HostCommand => ({ name, description: "", kind: "skill" });
  test("sends the listed name: plain, or the harness plugin's", () => {
    expect(handoffCommandText([skill("handoff")])).toBe("/handoff");
    expect(handoffCommandText([skill("harness:handoff"), skill("harness:resume")])).toBe("/harness:handoff");
    expect(handoffCommandText([skill("harness:handoff"), skill("handoff")])).toBe("/handoff");
  });
  test("is null for another plugin's handoff", () => {
    expect(handoffCommandText([skill("mattpocock-skills:handoff")])).toBeNull();
  });
});

describe("handoffOffer", () => {
  const skills: HostCommand[] = [{ name: "harness:handoff", description: "", kind: "skill" }];
  const question = { kind: "question" as const, custom_option_index: 2, host: { request_id: "req-1", question_id: "q", option_ids: ["a", "b", ""] } };
  test("idle, or waiting on its own question that takes a typed answer: ready", () => {
    expect(handoffOffer({ busy: false, prompt: null, commands: skills })).toBe("ready");
    expect(handoffOffer({ busy: true, prompt: question, commands: skills })).toBe("ready");
  });
  test("working without asking, or asking for an approval or a closed choice: working", () => {
    expect(handoffOffer({ busy: true, prompt: null, commands: skills })).toBe("working");
    expect(handoffOffer({ busy: true, prompt: { kind: "approval", custom_option_index: null, host: { tool_call_id: "t", turn_id: "u", option_ids: [""], approves: [true] } }, commands: skills })).toBe("working");
    expect(handoffOffer({ busy: true, prompt: { ...question, custom_option_index: null }, commands: skills })).toBe("working");
  });
  test("null without the hand-off skill", () => {
    expect(handoffOffer({ busy: false, prompt: null, commands: [] })).toBeNull();
    expect(handoffOffer({ busy: true, prompt: question, commands: [] })).toBeNull();
  });
});
