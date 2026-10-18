import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCardView } from "./PromptCard.tsx";

const prompt = (extra: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
  id: "p-1", agent: "copilot", kind: "question", title: "FICTIONAL **title**", question: "Pick **one**", body: "FICTIONAL `body`",
  options: [{ label: "Red", description: "a **warm** one" }, { label: "Other…", description: null }], multi_select: false, custom_option_index: 1, ...extra,
} as InteractivePrompt);
const render = (markdown: boolean | undefined, value = prompt()): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    const props = { prompt: value, submit: async () => {}, onPromptChanged: () => {}, onAnswered: () => {}, ...(markdown === undefined ? {} : { markdown }) };
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCardView, props) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("PromptCardView", () => {
  it("card_renders_markdown", () => {
    // the app's Markdown wraps each text run in a span: <strong><span>one</span></strong>
    const html = render(true).replace(/<\/?span>/g, "");
    expect(html).toContain("<strong>one</strong>");
    expect(html).toContain("<strong>title</strong>");
    expect(html).toMatch(/<code[^>]*>body<\/code>/);
    // option descriptions stay plain
    expect(html).toContain("a **warm** one");
  });

  it("another agent's card is plain text, exactly as before", () => {
    const plain = render(undefined, prompt({ agent: "claude" }));
    expect(plain).toContain("Pick **one**");
    expect(plain).not.toContain("<strong>");
    expect(plain).toContain('<p class="prompt-card-question">Pick **one**</p>');
    expect(plain).toContain('<pre class="prompt-card-body is-line">FICTIONAL `body`</pre>');
    expect(plain).toContain("<h2>FICTIONAL **title**</h2>");
    expect(render(false, prompt({ agent: "claude" }))).toBe(plain);
  });
});
