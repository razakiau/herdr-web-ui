import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { HandoffStep } from "./HandoffStep.tsx";

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

describe("HandoffStep (ZAC-267)", () => {
  it("is one named field with ✕ and the send arrow inside it, no second Hand off button", () => {
    const html = render(createElement(HandoffStep, { onSend: () => {}, onCancel: () => {} }));
    expect(html).toContain('class="handoff-step"');
    expect(html).toMatch(/<textarea[^>]*class="handoff-step-input"[^>]*aria-label="Then tell the new chat \(optional\)"/);
    expect(html).toMatch(/<button[^>]*class="composer-action composer-send handoff-step-send"[^>]*aria-label="Hand off"/);
    expect(html).toMatch(/<button[^>]*aria-label="Cancel"/);
    expect(html).not.toContain(">Hand off<");
  });

  it("is quiet while the hand-off starts: the arrow waits", () => {
    const html = render(createElement(HandoffStep, { onSend: () => {}, onCancel: () => {}, busy: true }));
    expect(html).toMatch(/<button[^>]*handoff-step-send[^>]*disabled=""/);
  });
});
