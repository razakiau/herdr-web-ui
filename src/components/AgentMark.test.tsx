import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark, hasAgentMark, hasBrandColors } from "./AgentMark.tsx";
import { AGENT_SVG_MARKS } from "./agentSvgMarks.ts";

describe("agent marks", () => {
  it("tells the marks with brand colors from those riding currentColor, for Mono to grey only the former", () => {
    expect(["claude", "omp", "opencode", "gjc", "omo", "amp", "gemini"].every(hasBrandColors)).toBe(true);
    expect(["codex", "cursor", "cline", "pi", "unknown-agent"].some(hasBrandColors)).toBe(false);
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "claude" }))).toContain('class="agent-mark claude is-brand"');
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "codex" }))).toContain('class="agent-mark codex"');
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "zed" }))).toContain('class="agent-mark zed"');
  });

  it("AgentMark draws the vscode mark", () => {
    const mark = AGENT_SVG_MARKS["vscode"];
    expect(mark?.viewBox).toBe("0 0 16 16");
    const firstPath = /<path[^>]*\bd="([^"]+)"/.exec(mark?.body ?? "")?.[1];
    expect(firstPath).toBeDefined();
    const html = renderToStaticMarkup(createElement(AgentMark, { agent: "vscode" }));
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain(firstPath!);
    expect(hasAgentMark("vscode")).toBe(true);
    // one currentColor path: Mono has nothing to grey
    expect(hasBrandColors("vscode")).toBe(false);
  });
});
