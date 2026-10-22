import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationPart } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { formatElapsedTime, SubagentRow } from "./SubagentRow.tsx";

type Subagent = Extract<ConversationPart, { kind: "subagent" }>;
const AT = "2026-01-01T00:00:00.000Z";
const part = (extra: Partial<Subagent> = {}): Subagent => ({
  kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: null,
  started: AT, ended: "2026-01-01T00:05:43.000Z", status: "done", chat: "ahp-chat://default/fictional-sub", ...extra,
});
const render = (element: ReactElement): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("SubagentRow", () => {
  it("formats elapsed time as VS Code's formatElapsedTime", () => {
    expect(formatElapsedTime(0)).toBe("0s");
    expect(formatElapsedTime(45_900)).toBe("45s");
    expect(formatElapsedTime(83_000)).toBe("1m 23s");
    expect(formatElapsedTime(343_000)).toBe("5m 43s");
  });

  it("subagent_row_shows_name_task_time", () => {
    const done = render(createElement(SubagentRow, { part: part(), live: false }));
    expect(text(done)).toContain("explore");
    expect(text(done)).toContain("FICTIONAL find the config");
    expect(text(done)).toContain("Worked for 5m 43s");
    // comment-discussion, no spinner
    expect(done).toContain("lucide-messages-square");
    expect(done).not.toContain("lucide-loader-circle");
    const running = render(createElement(SubagentRow, { part: part({ status: "running", ended: null }), live: true, now: Date.parse(AT) + 3_400 }));
    expect(text(running)).toContain("Working for 3s");
    expect(running).toContain("lucide-loader-circle");
    expect(running).not.toContain("lucide-messages-square");
  });

  it("subagent_model_only_when_different", () => {
    // the bridge leaves `model` null when it is the chat's own: the row shows what it is given
    expect(render(createElement(SubagentRow, { part: part(), live: false }))).not.toContain("subagent-row-model");
    const other = render(createElement(SubagentRow, { part: part({ model: "FICTIONAL Model B" }), live: false }));
    expect(other).toContain("subagent-row-model");
    expect(text(other)).toContain("FICTIONAL Model B");
  });

  it("a failed subagent wears the error icon, and one with no times shows none", () => {
    const failed = render(createElement(SubagentRow, { part: part({ status: "failed" }), live: false }));
    expect(failed).toContain("lucide-circle-x");
    const untimed = render(createElement(SubagentRow, { part: part({ started: null, ended: null }), live: false }));
    expect(text(untimed)).not.toContain("Worked for");
  });

  it("is folded until opened: it reads nothing on its own", () => {
    let reads = 0;
    const html = render(createElement(SubagentRow, { part: part(), live: false, readChat: async () => { reads += 1; return []; } }));
    expect(reads).toBe(0);
    expect(html).toContain('aria-expanded="false"');
  });
});
