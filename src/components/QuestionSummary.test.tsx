import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationPart } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";
import { answerText, QuestionSummary } from "./QuestionSummary.tsx";

type Question = Extract<ConversationPart, { kind: "question" }>;
const part = (extra: Partial<Question> = {}): Question => ({
  kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: ["Blue"], custom: null, skipped: false, ...extra,
});
const render = (element: ReactElement, open = false): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  // an opened row, as the chat's row memory keeps it
  const memory = { toggles: new Map<string, boolean | null>(open ? [["question", true]] : []), outputs: new Map<string, string>() };
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatRowMemoryContext.Provider, { value: memory, children: element }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("QuestionSummary", () => {
  it("question_summary_reads_like_vscode", () => {
    const html = render(createElement(QuestionSummary, { part: part() }));
    expect(text(html)).toContain("Question: FICTIONAL which color?");
    expect(text(html)).toContain("Answered: Blue");
    expect(html).toContain("question-summary-prefix");
    // the L connector, and folded
    expect(html).toContain("question-summary-decision");
    expect(html).not.toContain("question-summary-options");
    // opened: the options, a check by the chosen one
    const open = render(createElement(QuestionSummary, { part: part() }), true);
    expect(text(open)).toContain("Options");
    const items = [...open.matchAll(/<li class="([^"]*)"[^>]*>(.*?)<\/li>/g)].map((m) => ({ cls: m[1], body: m[2] }));
    expect(items.map((item) => text(item.body!))).toEqual(["Red", "Blue"]);
    expect(items[1]!.cls).toContain("is-selected");
    expect(items[1]!.body).toContain("lucide-check");
    expect(items[0]!.body).not.toContain("lucide-check");
  });

  it("a skipped question shows Skipped question, no Answered prefix", () => {
    const html = render(createElement(QuestionSummary, { part: part({ chosen: [], skipped: true }) }));
    expect(text(html)).toContain("Skipped question");
    expect(text(html)).not.toContain("Answered:");
  });

  it("a typed answer reads as itself, and opened as Custom answer", () => {
    const html = render(createElement(QuestionSummary, { part: part({ chosen: [], custom: "FICTIONAL teal" }) }), true);
    expect(text(html)).toContain("Answered: FICTIONAL teal");
    expect(text(html)).toContain("Custom answer: FICTIONAL teal");
  });

  it("answers as VS Code formats them: single takes the typed text first, multi joins all", () => {
    expect(answerText(part({ chosen: ["Blue"], custom: "navy" }), false)).toBe("navy");
    expect(answerText(part({ chosen: ["Red", "Blue"], custom: "navy" }), true)).toBe("Red, Blue, navy");
    // a text question has no options: its answer is the text
    expect(answerText(part({ options: [], chosen: [], custom: "FICTIONAL large" }), false)).toBe("FICTIONAL large");
  });

  it("a question with no options does not expand", () => {
    const html = render(createElement(QuestionSummary, { part: part({ options: [], chosen: [], custom: "FICTIONAL large" }) }), true);
    expect(html).not.toContain("question-summary-options");
    expect(html).not.toContain("aria-expanded");
  });
});
