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
  it("a VS Code chat's turn (no pane) reads no file for an @image mention", () => {
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
