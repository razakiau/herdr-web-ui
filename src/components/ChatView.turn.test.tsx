import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const user = (text: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "text", text }] } as ConversationTurn);
const render = (paneId: string, turn: ConversationTurn): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId, turn, live: false, waiting: false, showThinking: false }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a user turn's images", () => {
  it("a host chat's turn (no pane) reads no file for an @image mention", () => {
    const html = render("", user("FICTIONAL look at @shots/x.png please"));
    expect(html).toContain("FICTIONAL look at");
    expect(html).not.toContain("fs/file");
    expect(html).not.toContain("<img");
  });

  it("a pane's turn shows the mentioned image through its pane", () => {
    const html = render("p-1", user("FICTIONAL look at @shots/x.png please"));
    expect(html).toContain("fs/file");
  });
});

describe("a notice in a turn", () => {
  const agent = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: null, parts });

  it("a host chat's error notice inside an assistant turn is an error row beside the answer, not the whole turn", () => {
    const html = render("", agent([{ kind: "text", text: "FICTIONAL answer" }, { kind: "notice", text: "FICTIONAL boom", source: "error" }]));
    expect(html).toContain("FICTIONAL answer");
    expect(html).toContain("chat-notice-error");
    expect(html).toContain("FICTIONAL boom");
    // the answer comes first, the error row after it, where the host put it
    expect(html.indexOf("FICTIONAL answer")).toBeLessThan(html.indexOf("FICTIONAL boom"));
    expect(html).toContain("chat-turn-agent");
  });

  it("a system notification between tool work and the answer keeps the work block and the answer", () => {
    const html = render("", agent([
      { kind: "tool", name: "Run in terminal", summary: "FICTIONAL ls", input: "ls", output: "a.txt" },
      { kind: "notice", text: "FICTIONAL subagent done", source: "system" },
      { kind: "text", text: "FICTIONAL two files" },
    ]));
    expect(html).toContain("work-block");
    expect(html).toContain("FICTIONAL subagent done");
    expect(html).toContain("FICTIONAL two files");
    expect(html).not.toContain("chat-notice-error");
  });

  it("a user-seat turn that is only a notice is still the quiet divider", () => {
    const html = render("p-1", { role: "user", ts: null, parts: [{ kind: "notice", text: "FICTIONAL job finished", source: "async-result" }] });
    expect(html).toContain("chat-notice");
    expect(html).toContain("Background result delivered");
    expect(html).not.toContain("chat-turn-user");
    expect(html).not.toContain("chat-turn-agent");
  });
});
