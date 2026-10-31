import { describe, expect, it } from "bun:test";

import { nextHandoffTitle } from "./handoff-title.ts";

describe("nextHandoffTitle (ZAC-267)", () => {
  it("numbers the chat that continues another: → 2, then → 3", () => {
    expect(nextHandoffTitle("Fix the keep-warm row")).toBe("Fix the keep-warm row → 2");
    expect(nextHandoffTitle("Fix the keep-warm row → 2")).toBe("Fix the keep-warm row → 3");
    expect(nextHandoffTitle("Fix it → 9")).toBe("Fix it → 10");
    expect(nextHandoffTitle("  spaced   ")).toBe("spaced → 2");
  });
  it("names nothing for a chat without a real title (empty, VS Code's draft \"Session\")", () => {
    expect(nextHandoffTitle("")).toBeNull();
    expect(nextHandoffTitle("   ")).toBeNull();
    expect(nextHandoffTitle("Session")).toBeNull();
  });
  it("an arrow inside the title is not a number", () => {
    expect(nextHandoffTitle("a → b")).toBe("a → b → 2");
  });
});
