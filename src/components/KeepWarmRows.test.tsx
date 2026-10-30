import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { KeepWarmAnswer } from "../../shared/keep-warm.ts";
import { keepWarmFeed } from "../lib/keepWarm.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { KeepWarmRows } from "./SettingsDialog.tsx";

const render = (): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(KeepWarmRows) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const answer = (over: Partial<KeepWarmAnswer> = {}): KeepWarmAnswer => ({
  ok: true, writable: true, problem: null, settings: {},
  state: { v: 1, at: 0, enabled: true, windowHours: 8, fusePerDay: 200, idleMin: 55, thresholdUsd: 1, available: true, problem: null,
    today: { day: "2026-10-31", pings: 31, usd: 1.9, avoided: 4, avoidedUsd: 9.8, fuseHit: false }, keys: [] },
  ...over,
});

afterEach(() => keepWarmFeed.reset());

describe("Settings → Costs keep-warm (ZAC-260 phase 2)", () => {
  it("shows the switch, the window, the cap and today's tally", () => {
    keepWarmFeed.set(answer());
    const html = render();
    const words = text(html);
    expect(words).toContain("Keep big chats warm Automatic for every chat over the mark ($1.00). Turn off per chat in its Cache tab.");
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Keep big chats warm"/);
    expect(html).toMatch(/aria-label="For how long after the last call"[^>]*value="8"/);
    expect(html).toMatch(/aria-label="Pings per day at most"[^>]*value="200"/);
    expect(words).toContain("Today 31 pings · ~$1.90 · 4 restarts avoided (~$9.80)");
  });

  it("is read only without a write token, and says the day's cap is reached", () => {
    keepWarmFeed.set(answer({ writable: false, state: { ...answer().state!, today: { ...answer().state!.today, fuseHit: true } } }));
    const html = render();
    expect(text(html)).toContain("Read only: the server has no OmniRoute write token.");
    expect(text(html)).toContain("Daily cap reached: no more pings today");
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Keep big chats warm" disabled=""/);
  });

  it("says only Keep-warm unavailable without the plugin, and nothing before the server answers", () => {
    keepWarmFeed.set({ ok: false, state: null, settings: {}, writable: false, problem: "Could not reach OmniRoute" });
    const words = text(render());
    expect(words).toContain("Keep-warm unavailable");
    expect(words).not.toContain("Could not reach OmniRoute");
    keepWarmFeed.reset();
    expect(render()).toBe("");
  });
});
