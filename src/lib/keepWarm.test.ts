import { describe, expect, it } from "bun:test";

import { withChat } from "./keepWarm.ts";

describe("withChat (ZAC-267)", () => {
  it("a small chat turned on goes in `forced`, turned off leaves it", () => {
    const on = withChat({ disabled: ["b"] }, "k", true, false);
    expect(on.forced).toEqual(["k"]);
    expect(on.disabled).toEqual(["b"]);
    expect(withChat(on, "k", false, false).forced).toEqual([]);
  });
  it("a big chat turned off goes in `disabled` and out of `forced`; on leaves both", () => {
    const off = withChat({ forced: ["k"] }, "k", false, true);
    expect(off.disabled).toEqual(["k"]);
    expect(off.forced).toEqual([]);
    const on = withChat(off, "k", true, true);
    expect(on.disabled).toEqual([]);
    expect(on.forced).toEqual([]);
  });
  it("a small chat turned on is taken out of `disabled` too: a key is never in both", () => {
    const on = withChat({ disabled: ["k"] }, "k", true, false);
    expect(on.disabled).toEqual([]);
    expect(on.forced).toEqual(["k"]);
  });
});
