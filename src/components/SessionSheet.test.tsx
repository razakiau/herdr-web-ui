import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostChatCost, HostChatRead, HostCostCall } from "../../shared/host-chats.ts";
import { handoffCommandText } from "../lib/compactContext.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SessionSheet, type SessionSheetProps } from "./SessionSheet.tsx";

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

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const MODEL = "claude-fictional-4";
const PRICES = { prices: { gh: { [MODEL]: { input: 5, output: 25, cached: 0.5 } } }, fallback: null };

const read = (over: Partial<HostChatRead> = {}): HostChatRead => ({
  session: "copilotcli:/fictional", title: "FICTIONAL chat", status: "idle", turns: [], cursor: null, prompt: null,
  model: { id: MODEL, effort: null }, agent: null, busy: false, pending: [], commands: [{ name: "handoff", description: "", kind: "skill" }],
  background: { subagents: 0, commands: 0 }, confirmations: 0,
  context: { currentTokens: 210_400, tokenLimit: 400_000 },
  ...over,
} as HostChatRead);

const chat = (over: Partial<HostChatCost> = {}): HostChatCost => ({
  session: "copilotcli:/fictional",
  models: [{ model: MODEL, input: 2_000_000, cacheRead: 1_800_000, cacheWrite: 150_000, output: 40_000, calls: 20 }],
  lastCallAt: ago(48), context: 210_400, peak: 210_400, rewrites: 1, days: {}, partial: false,
  ...over,
});

const CALLS: HostCostCall[] = [
  { at: ago(120), input: 50_000, cacheRead: 0, cacheWrite: 50_000, output: 2000, main: true },
  { at: ago(119), input: 10_000, cacheRead: 0, cacheWrite: 10_000, output: 500, main: false },
  { at: ago(60), input: 150_000, cacheRead: 148_000, cacheWrite: 2000, output: 3000, main: true },
  { at: ago(48), input: 210_400, cacheRead: 209_000, cacheWrite: 1400, output: 2000, main: true },
];

const props = (over: Partial<SessionSheetProps> = {}): SessionSheetProps => ({
  read: read(), estimate: null, cost: { chat: chat(), calls: CALLS }, prices: PRICES,
  settings: { trackCosts: true, costHandoffAt: 150_000, cacheLifetimeMin: 60 },
  now: NOW, onClose: () => {}, onCompact: () => {}, onHandoff: () => {},
  ...over,
});
const sheet = (over: Partial<SessionSheetProps> = {}): string => render(createElement(SessionSheet, props(over)));
const pressed = (html: string): string | undefined => /<button[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "");

let stored = new Map<string, string>();
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
  });
});
afterEach(() => {
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("SessionSheet", () => {
  it("is titled Session with Cache, Cost and Context tabs when costs are tracked", () => {
    const html = sheet();
    expect(html).toContain('<h2 class="modal-title">Session</h2>');
    expect(text(html)).toContain("Cache Cost Context");
    expect(html).toContain('class="segmented session-tabs"');
  });

  it("is today's Context window sheet, without tabs, when costs are not tracked", () => {
    const html = sheet({ settings: { trackCosts: false, costHandoffAt: 150_000, cacheLifetimeMin: 60 } });
    expect(html).toContain('<h2 class="modal-title">Context window</h2>');
    expect(html).not.toContain("segmented");
    expect(text(html)).toContain("210.4K / 400.0K tokens");
    expect(text(html)).toContain("Compact Conversation");
  });

  it("opens on Cache when the advice is a handoff, whatever tab was used last", () => {
    stored.set("ovis:session-tab", "context");
    expect(pressed(sheet())).toBe("Cache");
  });

  it("otherwise opens on the tab used last", () => {
    stored.set("ovis:session-tab", "cost");
    const small = { chat: chat({ context: 40_000 }), calls: CALLS };
    expect(pressed(sheet({ cost: small }))).toBe("Cost");
    stored.set("ovis:session-tab", "context");
    expect(pressed(sheet({ cost: small }))).toBe("Context");
  });

  it("Cache: a cooling chat over the threshold says how long is left and advises a handoff", () => {
    const html = sheet();
    const words = text(html);
    expect(words).toContain("Cooling");
    expect(words).toContain("48 min ago · 12 min left");
    expect(words).toContain("Hand off before it goes cold");
    expect(words).toMatch(/Next call now ~\$\d/);
    expect(words).toMatch(/Next call after expiry ~\$\d/);
    expect(html).toMatch(/class="btn btn-primary"[^>]*>Hand off</);
  });

  it("Cache: a chat working now is warm, never 0 min left", () => {
    const words = text(sheet({ read: read({ busy: true }), cost: { chat: chat({ lastCallAt: ago(90) }), calls: CALLS } }));
    expect(words).toContain("Warm");
    expect(words).not.toContain("0 min left");
    expect(words).not.toContain("Cold");
  });

  it("Cache: a cold chat says it expired", () => {
    const words = text(sheet({ cost: { chat: chat({ lastCallAt: ago(130) }), calls: CALLS } }));
    expect(words).toContain("2 h ago · expired");
    expect(words).toContain("Free moment to hand off");
  });

  it("has no Hand off button when the session does not list /handoff", () => {
    expect(handoffCommandText([{ name: "handoff", description: "", kind: "skill" }])).toBe("/handoff");
    expect(handoffCommandText([{ name: "review", description: "", kind: "skill" }])).toBeNull();
    const html = sheet({ onHandoff: undefined });
    expect(html).not.toMatch(/>Hand off</);
  });

  it("Cost: splits the cost into what the money went on, with a per-message chart", () => {
    stored.set("ovis:session-tab", "cost");
    const html = sheet({ cost: { chat: chat({ context: 40_000 }), calls: CALLS } });
    const words = text(html);
    for (const row of ["Re-reading the context", "Cache rewrites", "Answers", "Your messages, tool results"]) expect(words).toContain(row);
    expect(words).toMatch(/Cost at list price ~\$\d/);
    expect(html.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("var(--status-blocked)");
    expect(html).toContain("stroke-dasharray");
  });

  it("Cost: a model with no price makes the total a floor and is named", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [...chat().models, { model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    const words = text(sheet({ cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toMatch(/Cost at list price ≥ \$\d/);
    expect(words).toContain("No price for fictional-unpriced.");
  });

  it("an old bridge: Cache and Cost say to update it, Context is unchanged", () => {
    stored.set("ovis:session-tab", "cost");
    expect(text(sheet({ cost: null }))).toContain("Update the bridge on this PC to show costs.");
    stored.set("ovis:session-tab", "context");
    expect(text(sheet({ cost: null }))).toContain("210.4K / 400.0K tokens");
  });
});
