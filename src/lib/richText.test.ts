import { describe, expect, it } from "bun:test";

import { richLines, richTokens } from "./richText.ts";

describe("richTokens", () => {
  it("marks ticket keys, PR refs and bold, and leaves the rest as text", () => {
    expect(richTokens("ZAC-265 ships, see razakiau/herdr-web-ui#12 and #30; **blocked** on SPK-1616.")).toEqual([
      { kind: "ref", text: "ZAC-265" },
      { kind: "text", text: " ships, see " },
      { kind: "ref", text: "razakiau/herdr-web-ui#12" },
      { kind: "text", text: " and " },
      { kind: "ref", text: "#30" },
      { kind: "text", text: "; " },
      { kind: "bold", text: "blocked" },
      { kind: "text", text: " on " },
      { kind: "ref", text: "SPK-1616" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves look-alikes alone: lower case, a word inside, an HTML entity, lone asterisks", () => {
    for (const text of ["zac-265", "MAZAC-265x", "a&#39;b", "2 * 3 * 4", "UTF-8", "GPT-5", "<b>x</b>"]) {
      expect(richTokens(text).every((token) => token.kind === "text")).toBe(true);
      expect(richTokens(text).map((token) => token.text).join("")).toBe(text);
    }
  });

  it("returns nothing for empty text", () => {
    expect(richTokens("")).toEqual([]);
  });
});

describe("richLines", () => {
  it("splits on newlines and drops blank lines", () => {
    expect(richLines("One.\n\n  Two.  \nThree.\n")).toEqual(["One.", "Two.", "Three."]);
  });
});
