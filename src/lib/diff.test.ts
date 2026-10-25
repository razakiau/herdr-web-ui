import { describe, expect, it } from "bun:test";

import { foldContext, lineDiff, type DiffLine } from "./diff.ts";

describe("lineDiff", () => {
  it("keeps unchanged lines once and puts each change where it happened", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x" }]);
    expect(lineDiff("gone", "")).toEqual([{ kind: "del", text: "gone" }]);
    expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  it("gives up on a table too large, as removed then added", () => {
    const big = Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n");
    const lines = lineDiff(big, big + "\nmore");
    expect(lines.filter((line) => line.kind === "del")).toHaveLength(600);
    expect(lines.at(-1)).toEqual({ kind: "add", text: "more" });
  });
});

describe("foldContext", () => {
  const lines = (spec: string): DiffLine[] => spec.split("").map((kind, at) => ({ kind: kind === "+" ? "add" : kind === "-" ? "del" : "same", text: `l${at}` }));

  it("keeps the changes and three lines each side, folding longer runs of unchanged lines", () => {
    const folded = foldContext(lines("..........-+.........."), 3);
    expect(folded.map((item) => item.kind === "fold" ? `fold${item.count}` : item.text)).toEqual(["fold7", "l7", "l8", "l9", "l10", "l11", "l12", "l13", "l14", "fold7"]);
  });

  it("does not fold a gap no longer than the lines a fold would hide it behind", () => {
    const folded = foldContext(lines("-.......+"), 3);
    expect(folded.some((item) => item.kind === "fold")).toBe(false);
    expect(foldContext(lines("-........+"), 3).map((item) => item.kind === "fold" ? `fold${item.count}` : item.kind)).toEqual(["del", "same", "same", "same", "fold2", "same", "same", "same", "add"]);
  });

  it("an all-new file keeps every line, and no change keeps nothing but one fold", () => {
    expect(foldContext(lines("+++"), 3).map((item) => item.kind)).toEqual(["add", "add", "add"]);
    expect(foldContext(lines("....."), 3)).toEqual([{ kind: "fold", count: 5 }]);
    expect(foldContext([], 3)).toEqual([]);
  });
});
