import { expect, it } from "bun:test";
import { renderMermaid } from "./mermaid.ts";

it("draws a flowchart as SVG, each diagram with its own ids", async () => {
  const first = await renderMermaid("flowchart LR\n  A[FICTIONAL start] --> B[FICTIONAL end]", true);
  const second = await renderMermaid("flowchart LR\n  A[FICTIONAL start] --> B[FICTIONAL end]", true);
  expect(first).toStartWith("<svg");
  expect(first).toContain("FICTIONAL start");
  // two diagrams on one page never share an id (a marker or gradient one of them points at)
  const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
});

it("rejects a diagram that does not parse, so the chat keeps the code block", async () => {
  await expect(renderMermaid("flowchart LR\n  A[FICTIONAL start --> ", true)).rejects.toThrow();
});

it("escapes what a diagram says and drops its scripts and remote images", async () => {
  const svg = await renderMermaid('flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n  click A call alert(1)\n  C@{ img: "https://example.invalid/x.png" }', true);
  expect(svg).not.toContain("<img");
  expect(svg).not.toMatch(/\son\w+=/i);
  expect(svg).not.toContain("example.invalid");
  expect(svg).not.toContain("<script");
});

it("draws the six kinds seen in chats", async () => {
  for (const source of [
    "flowchart TD\n  A --> B",
    "sequenceDiagram\n  Alice->>Bob: FICTIONAL hi",
    "classDiagram\n  class FICTIONAL",
    "stateDiagram-v2\n  [*] --> Idle",
    "erDiagram\n  USER ||--o{ ORDER : places",
    "gantt\n  title FICTIONAL\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 3d",
  ]) expect(await renderMermaid(source, false)).toStartWith("<svg");
});
