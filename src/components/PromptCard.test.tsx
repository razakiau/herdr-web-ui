import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { JA } from "../lib/i18n.ja.ts";
import { KO } from "../lib/i18n.ko.ts";
import { ZH } from "../lib/i18n.zh.ts";
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

describe("a Copilot card's extras", () => {
  const renderWith = (extra: Record<string, unknown>, value = prompt()): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const props = { prompt: value, submit: async () => {}, onPromptChanged: () => {}, onAnswered: () => {}, ...extra };
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCardView, props) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it("non_copilot_card_has_no_expand, and no attach: every other agent's card is byte for byte as before", () => {
    const other = prompt({ agent: "claude" });
    const plain = renderWith({}, other);
    expect(plain).not.toContain("prompt-card-expand");
    expect(plain).not.toContain("prompt-card-attach");
    expect(plain).not.toContain('type="file"');
  });

  it("a Copilot card has Open full screen in its header, and attach beside its typed answer", () => {
    const html = renderWith({ markdown: true, expandable: true, onUploadFile: async () => "/w/a.png" });
    expect(html).toMatch(/<button[^>]*class="icon-button prompt-card-expand"[^>]*aria-label="Open full screen"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<button[^>]*class="icon-button prompt-card-attach"[^>]*aria-label="Attach files"/);
    // a question with no typed answer has nothing to attach to
    expect(renderWith({ markdown: true, onUploadFile: async () => "" }, prompt({ options: [{ label: "Red", description: null }], custom_option_index: null }))).not.toContain("prompt-card-attach");
  });
});

describe("the typed-answer slot", () => {
  const renderIn = (language: "en" | "ko" | "ja" | "zh", markdown: boolean | undefined, value: InteractivePrompt): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
    try {
      const props = { prompt: value, submit: async () => {}, onPromptChanged: () => {}, onAnswered: () => {}, ...(markdown === undefined ? {} : { markdown }) };
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCardView, props) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const placeholder = (html: string): string | undefined => /placeholder="([^"]*)"/.exec(html)?.[1];

  it("a Copilot card says Other… in the user's language", () => {
    expect(placeholder(renderIn("en", true, prompt()))).toBe("Other…");
    expect(placeholder(renderIn("ko", true, prompt()))).toBe(KO["Other…"]);
    expect(placeholder(renderIn("ja", true, prompt()))).toBe(JA["Other…"]);
    expect(placeholder(renderIn("zh", true, prompt()))).toBe(ZH["Other…"]);
    expect(KO["Other…"]).not.toBe("Other…");
    // a text question's one slot, "Answer", too
    const text = prompt({ options: [{ label: "Answer", description: null }], custom_option_index: 0 });
    expect(placeholder(renderIn("ko", true, text))).toBe(KO["Answer"]);
  });

  it("another agent's card keeps its own slot label, untranslated, byte for byte", () => {
    const other = prompt({ agent: "claude", options: [{ label: "Red", description: null }, { label: "Other…", description: null }] });
    const html = renderIn("ko", undefined, other);
    expect(placeholder(html)).toBe("Other…");
    expect(renderIn("ko", false, other)).toBe(html);
  });
});
