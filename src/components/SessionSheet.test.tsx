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

// each message sums its tool loop's calls (the bridge's HostCostCall): the last one is 8 calls of about 210K,
// its last call reading 105K from the cache. Summed, it would plot 1.68M and read 99%.
const CALLS: HostCostCall[] = [
  { at: ago(120), input: 50_000, cacheRead: 0, cacheWrite: 50_000, output: 2000, main: true, context: 50_000, lastCacheRead: 0 },
  { at: ago(119), input: 10_000, cacheRead: 0, cacheWrite: 10_000, output: 500, main: false, context: 10_000, lastCacheRead: 0 },
  { at: ago(60), input: 450_000, cacheRead: 444_000, cacheWrite: 6000, output: 3000, main: true, context: 150_000, lastCacheRead: 148_000 },
  { at: ago(55), input: 1_680_000, cacheRead: 1_660_000, cacheWrite: 20_000, output: 2000, main: true, context: 210_400, lastCacheRead: 105_200 },
];

// a context under the 150K threshold, live and in the log: no handoff, the sheet opens on the tab used last
const quiet = read({ context: { currentTokens: 40_000, tokenLimit: 400_000 } });

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
    expect(pressed(sheet({ read: quiet, cost: small }))).toBe("Cost");
    stored.set("ovis:session-tab", "context");
    expect(pressed(sheet({ read: quiet, cost: small }))).toBe("Context");
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
    // the last call's own hit, not its message's sum
    expect(words).toContain("Last call read from cache 50%");
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
    const html = sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } });
    const words = text(html);
    for (const row of ["Re-reading the context", "Cache rewrites", "Answers", "Your messages, tool results"]) expect(words).toContain(row);
    expect(words).toMatch(/Cost at list price ~\$\d/);
    expect(html.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("var(--status-blocked)");
    expect(html).toContain("stroke-dasharray");
  });

  it("Cost: the dashed line is each message's context, its largest message at the top", () => {
    stored.set("ovis:session-tab", "cost");
    const html = sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } });
    const points = [...(/<path d="([^"]+)"[^>]*stroke-dasharray/.exec(html)?.[1] ?? "").matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    // context 50K, 150K, 210.4K against the 210.4K peak (106 px tall, from y=110): summed input would put 150K near the floor
    expect(points.length).toBe(3);
    expect(points[2]).toBeCloseTo(4, 0);
    expect(points[1]).toBeCloseTo(110 - (150_000 / 210_400) * 106, 0);
  });

  it("Cost: a model with no price makes the total a floor and is named", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [...chat().models, { model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toMatch(/Cost at list price ≥ \$\d/);
    expect(words).toContain("No price for fictional-unpriced.");
  });

  it("prices that answered with nothing: a floor with every model named, not Loading", () => {
    const empty = { prices: null, fallback: null };
    stored.set("ovis:session-tab", "cost");
    const small = { chat: chat({ context: 40_000 }), calls: CALLS };
    const cost = text(sheet({ read: quiet, prices: empty, cost: small }));
    expect(cost).not.toContain("Loading");
    expect(cost).toContain("Cost at list price ≥ $0.00");
    expect(cost).toContain(`No price for ${MODEL}.`);
    const cache = text(sheet({ prices: empty }));
    expect(cache).toContain("Cooling");
    expect(cache).toContain(`No price for ${MODEL}.`);
    expect(cache).not.toContain("Next call now");
  });

  it("prices not answered yet: the Cost tab waits", () => {
    stored.set("ovis:session-tab", "cost");
    expect(text(sheet({ read: quiet, prices: null, cost: { chat: chat({ context: 40_000 }), calls: CALLS } }))).toContain("Loading…");
  });

  it("takes the context, cache and advice from the meter's rule: the live read before the log's", () => {
    stored.set("ovis:session-tab", "context");
    // live 155K over the 150K threshold, the log's last call 145K under it: the meter advises a handoff
    const html = sheet({ read: read({ context: { currentTokens: 155_000, tokenLimit: 400_000 } }), cost: { chat: chat({ context: 145_000, lastCallAt: ago(10) }), calls: CALLS } });
    expect(pressed(html)).toBe("Cache");
    expect(text(html)).toContain("Hand off if work remains");
    expect(text(html)).toContain("155.0K is re-read on every call.");
    expect(html).toMatch(/class="btn btn-primary"[^>]*>Hand off</);
  });

  it("Cost: a floor is rounded down like All agents and Costs print it", () => {
    stored.set("ovis:session-tab", "cost");
    // $149.60 of output at $25 per million, and a model with no price: a floor
    const models = [{ model: MODEL, input: 0, cacheRead: 0, cacheWrite: 0, output: 5_984_000, calls: 1 }, { model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toContain("Cost at list price ≥ $149");
  });

  it("names its actions apart from the history list's session-actions", () => {
    const html = sheet();
    expect(html).toContain('class="session-sheet-actions"');
    expect(html).not.toContain('class="session-actions"');
  });

  it("an old bridge: Cache and Cost say to update it, Context is unchanged", () => {
    stored.set("ovis:session-tab", "cost");
    expect(text(sheet({ cost: null }))).toContain("Update the bridge on this PC to show costs.");
    stored.set("ovis:session-tab", "context");
    expect(text(sheet({ cost: null }))).toContain("210.4K / 400.0K tokens");
  });
});
