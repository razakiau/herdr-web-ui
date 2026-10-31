import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostChatCost, HostChatRead } from "../../shared/host-chats.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HostContextMeter } from "./HostChatStatus.tsx";
import { dismissHandoff, HandoffBanner } from "./HandoffBanner.tsx";

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
const label = (html: string): string => text(/<span class="host-chat-meter-label"[^>]*>(.*?)<\/span><\/button>/.exec(html)?.[1] ?? "");
const buttonClass = (html: string): string => /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const SETTINGS = { trackCosts: true, coldRestartAlertUsd: 1, cacheLifetimeMin: 60 };
// $4 in: a Claude model writes at $8, so a cold restart of 210K costs $1.68 (big), of 40K $0.32
const PRICES = { prices: { gh: { "claude-fictional-4": { input: 4, output: 20, cached: 0.4 } } }, fallback: null };

const read = (tokens: number, over: Partial<HostChatRead> = {}): HostChatRead => ({
  session: "copilotcli:/fictional", title: "FICTIONAL chat", status: "idle", turns: [], cursor: null, prompt: null,
  model: { id: "claude-fictional-4", effort: null }, agent: null, busy: false, pending: [], commands: [],
  background: { subagents: 0, commands: 0 }, confirmations: 0,
  context: { currentTokens: tokens, tokenLimit: 400_000 },
  ...over,
} as HostChatRead);

const log = (lastMin: number, over: Partial<HostChatCost> = {}): HostChatCost => ({
  session: "copilotcli:/fictional", models: [], lastCallAt: ago(lastMin), context: 999_000, peak: 999_000, rewrites: 0, days: {}, partial: false,
  ...over,
});

const meter = (chat: HostChatRead, cost: HostChatCost | null | undefined, settings = SETTINGS, prices: typeof PRICES | null = PRICES): string =>
  render(createElement(HostContextMeter, { read: chat, open: false, onOpen: () => {}, onClose: () => {}, costs: { log: cost, settings, prices, now: NOW } }));

describe("HostContextMeter with costs tracked", () => {
  it("shows the tokens and the minutes left while cooling, tinted as a handoff", () => {
    const html = meter(read(210_000), log(48));
    expect(label(html)).toBe("210K · 12m");
    expect(buttonClass(html)).toContain("is-cooling");
    expect(buttonClass(html)).toContain("is-advised");
    expect(buttonClass(html)).toContain("is-tracked");
  });

  it("says cold once the lifetime is over", () => {
    const html = meter(read(210_000), log(120));
    expect(label(html)).toBe("210K · cold");
    expect(buttonClass(html)).toContain("is-cold");
    expect(buttonClass(html)).toContain("is-advised");
  });

  it("shows the tokens alone while warm, untinted under the threshold", () => {
    const html = meter(read(40_000), log(4));
    expect(label(html)).toBe("40K");
    expect(buttonClass(html)).not.toContain("is-advised");
  });

  it("tints but adds nothing while warm above the threshold", () => {
    const html = meter(read(210_000), log(4));
    expect(label(html)).toBe("210K");
    expect(buttonClass(html)).toContain("is-advised");
    expect(buttonClass(html)).toContain("is-warm");
  });

  it("leaves a small cold context untinted: keep going", () => {
    const html = meter(read(40_000), log(120));
    expect(label(html)).toBe("40K · cold");
    expect(buttonClass(html)).not.toContain("is-advised");
  });

  it("weighs a big chat in dollars: the same 210K is small under a $2 threshold, and nothing is big unpriced", () => {
    expect(buttonClass(meter(read(210_000), log(120), { ...SETTINGS, coldRestartAlertUsd: 2 }))).not.toContain("is-advised");
    expect(buttonClass(meter(read(210_000), log(120), SETTINGS, null))).not.toContain("is-advised");
    expect(buttonClass(meter(read(210_000, { model: { id: "mystery-1", effort: null } }), log(120)))).not.toContain("is-advised");
    expect(buttonClass(meter(read(210_000, { model: { id: "desktop-coder", effort: null } }), log(120)))).not.toContain("is-advised");
  });

  it("counts down for a chat waiting on the owner: its turn is open but calls nothing", () => {
    expect(label(meter(read(210_000, { busy: true, status: "asks" }), log(50)))).toBe("210K · 10m");
    expect(label(meter(read(210_000, { busy: true, status: "asks" }), log(70)))).toBe("210K · cold");
  });

  it("never prints 0m for a chat working now", () => {
    const html = meter(read(210_000, { busy: true }), log(70));
    expect(label(html)).toBe("210K");
  });

  it("shows tokens only, no state and no tint, from a bridge before costs or before the log answers", () => {
    for (const cost of [null, undefined]) {
      const html = meter(read(210_000), cost);
      expect(label(html)).toBe("210K");
      expect(buttonClass(html)).not.toContain("is-advised");
      expect(buttonClass(html)).not.toMatch(/is-(warm|cooling|cold)/);
    }
  });

  it("reads the log's context when the read has none", () => {
    const html = meter(read(0, { context: null } as Partial<HostChatRead>), log(48, { context: 210_000 }));
    expect(label(html)).toBe("210K · 12m");
  });

  it("is today's ring and percent with tracking off", () => {
    const html = meter(read(210_000), log(48), { ...SETTINGS, trackCosts: false });
    expect(label(html)).toBe("53%");
    expect(buttonClass(html)).toBe("host-chat-meter");
    expect(html).toContain("host-chat-meter-ring");
  });
});

describe("HandoffBanner", () => {
  // advice by the cache's age: 4 min warm, 48 min cooling, 120 min cold; 210K is over the threshold
  const AGE = { "handoff-warm": 4, "handoff-cooling": 48, "handoff-cold": 120, keep: 120 } as const;
  const banner = (key: string, advised: keyof typeof AGE, onHandoff?: () => void, over: { handingOff?: boolean; handoffWaiting?: boolean; note?: string | null } = {}): string =>
    render(createElement(HandoffBanner, { dismissKey: key, read: read(advised === "keep" ? 40_000 : 210_000), log: log(AGE[advised]), settings: SETTINGS, prices: PRICES, now: NOW, onHandoff, ...over }));

  it("says the cache is cold and offers Hand off & continue", () => {
    const html = banner("pc\nchat-a", "handoff-cold", () => {});
    expect(text(html)).toBe("Cache cold · free moment to hand off Hand off &amp; continue");
    expect(html).toContain("is-cold");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("names the warm and cooling advice", () => {
    expect(text(banner("pc\nchat-b", "handoff-warm", () => {}))).toContain("Cache warm · hand off if work remains");
    expect(text(banner("pc\nchat-b", "handoff-cooling", () => {}))).toContain("Cache cooling · hand off before it goes cold");
  });

  it("is absent when the advice is to keep going", () => {
    expect(banner("pc\nchat-c", "keep", () => {})).toBe("");
  });

  it("is absent with tracking off or without the log", () => {
    expect(render(createElement(HandoffBanner, { dismissKey: "pc\nchat-g", read: read(210_000), log: log(120), settings: { ...SETTINGS, trackCosts: false }, prices: PRICES, now: NOW }))).toBe("");
    expect(render(createElement(HandoffBanner, { dismissKey: "pc\nchat-g", read: read(210_000), log: null, settings: SETTINGS, prices: PRICES, now: NOW }))).toBe("");
  });

  it("has no Hand off button without a handoff command, but still shows", () => {
    const html = banner("pc\nchat-d", "handoff-cold");
    expect(text(html)).toBe("Cache cold · free moment to hand off");
  });

  it("says Handing off… on a disabled button while the job runs", () => {
    const html = banner("pc\nchat-h", "handoff-cold", () => {}, { handingOff: true });
    expect(text(html)).toBe("Cache cold · free moment to hand off Handing off…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Handing off…</);
  });

  it("says Working: hand off when it asks or stops on a disabled button while the chat works without asking", () => {
    const html = banner("pc\nchat-k", "handoff-cold", undefined, { handoffWaiting: true });
    expect(text(html)).toBe("Cache cold · free moment to hand off Working: hand off when it asks or stops");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Working: hand off when it asks or stops</);
  });

  it("says why a hand-off did not go, even when the advice is to keep going or it was dismissed", () => {
    const words = "Update the bridge on Desk to hand off from here";
    expect(text(banner("pc\nchat-i", "handoff-cold", () => {}, { note: words }))).toContain(words);
    expect(text(banner("pc\nchat-i", "keep", () => {}, { note: words }))).toBe(words);
    dismissHandoff("pc\nchat-j", "cold");
    expect(text(banner("pc\nchat-j", "handoff-cold", () => {}, { note: "It's working: try again when it's done" }))).toBe("It&#x27;s working: try again when it&#x27;s done");
  });

  it("stays hidden after ✕ until the cache's state changes", () => {
    dismissHandoff("pc\nchat-e", "cold");
    expect(banner("pc\nchat-e", "handoff-cold", () => {})).toBe("");
    expect(text(banner("pc\nchat-f", "handoff-cold", () => {}))).toContain("Cache cold");
    expect(text(banner("pc\nchat-e", "handoff-cooling", () => {}))).toContain("Cache cooling");
    // a new state forgets the dismissal: cold again later shows it again
    expect(text(banner("pc\nchat-e", "handoff-cold", () => {}))).toContain("Cache cold");
  });
});
