import { describe, expect, it } from "bun:test";

import { handoffCommand } from "./handoff-command.ts";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("handoffCommand", () => {
  it("takes the plain skill", () => {
    expect(handoffCommand(named("review", "handoff", "resume"))).toEqual({ handoff: "/handoff", resume: "/resume" });
  });

  it("takes the harness plugin's skill, as the host's completions name it", () => {
    expect(handoffCommand(named("harness:handoff", "harness:resume"))).toEqual({ handoff: "/harness:handoff", resume: "/harness:resume" });
  });

  it("prefers the plain names when both are listed", () => {
    expect(handoffCommand(named("harness:handoff", "handoff", "harness:resume", "resume"))).toEqual({ handoff: "/handoff", resume: "/resume" });
  });

  it("without a listed resume, mirrors the hand-off's form", () => {
    expect(handoffCommand(named("handoff"))).toEqual({ handoff: "/handoff", resume: "/resume" });
    expect(handoffCommand(named("harness:handoff"))).toEqual({ handoff: "/harness:handoff", resume: "/harness:resume" });
  });

  it("sends the resume that is listed", () => {
    expect(handoffCommand(named("handoff", "harness:resume"))).toEqual({ handoff: "/handoff", resume: "/harness:resume" });
    expect(handoffCommand(named("harness:handoff", "resume"))).toEqual({ handoff: "/harness:handoff", resume: "/resume" });
  });

  it("refuses another plugin's handoff", () => {
    expect(handoffCommand(named("mattpocock-skills:handoff", "mattpocock-skills:resume"))).toBeNull();
    expect(handoffCommand(named("handoffs", "review"))).toBeNull();
    expect(handoffCommand([])).toBeNull();
  });
});
