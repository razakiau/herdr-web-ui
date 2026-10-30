import { describe, expect, test } from "bun:test";

import type { HostCommand } from "../../shared/host-chats.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { compactCommandText, handoffCommandText } from "./compactContext.ts";

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
