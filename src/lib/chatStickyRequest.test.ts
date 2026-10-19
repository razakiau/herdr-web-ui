import { describe, expect, it } from "bun:test";
import { stickyRequestIndex } from "./chatStickyRequest.ts";

const roles = ["user", "assistant", "user", "assistant", "assistant"] as const;

describe("the message a host chat keeps at its top (VS Code's sticky request)", () => {
  it("is the user's message of the turn being read once it has scrolled past the top", () => {
    expect(stickyRequestIndex(roles, 3, -40)).toBe(2);
    expect(stickyRequestIndex(roles, 4, 0)).toBe(2);
  });

  it("is the message itself while its top has gone past and the rest of it still shows", () => {
    expect(stickyRequestIndex(roles, 2, -12)).toBe(2);
  });

  it("is none while that message starts in the view: it is already there to read", () => {
    expect(stickyRequestIndex(roles, 2, 0)).toBeNull();
    expect(stickyRequestIndex(roles, 2, 8)).toBeNull();
  });

  it("is none above the first message, and none with nothing on screen", () => {
    expect(stickyRequestIndex(["assistant", "user"], 0, -50)).toBeNull();
    expect(stickyRequestIndex(roles, -1, 0)).toBeNull();
  });
});
