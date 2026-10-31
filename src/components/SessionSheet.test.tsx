import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostChatCost, HostChatRead, HostCostCall } from "../../shared/host-chats.ts";
import { handoffCommandText } from "../lib/compactContext.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SessionSheet, type SessionSheetProps } from "./SessionSheet.tsx";
import { keepWarmFeed } from "../lib/keepWarm.ts";
import type { KeepWarmAnswer, KeepWarmKey } from "../../shared/keep-warm.ts";

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

// a context whose cold restart costs under $1 (40K at $10 a million), live and in the log: no handoff, the sheet opens on the tab used last
const quiet = read({ context: { currentTokens: 40_000, tokenLimit: 400_000 } });

const props = (over: Partial<SessionSheetProps> = {}): SessionSheetProps => ({
  read: read(), estimate: null, cost: { chat: chat(), calls: CALLS }, prices: PRICES,
  settings: { trackCosts: true, coldRestartAlertUsd: 1, cacheLifetimeMin: 60 },
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
  it("is titled Session with Context, Cost and Cache tabs when costs are tracked", () => {
    const html = sheet();
    expect(html).toContain('<h2 class="modal-title">Session</h2>');
    expect(text(html)).toContain("Session Context Cost Cache");
    expect(html).toContain('class="segmented session-tabs"');
  });

  it("is today's Context window sheet, without tabs, when costs are not tracked", () => {
    const html = sheet({ settings: { trackCosts: false, coldRestartAlertUsd: 1, cacheLifetimeMin: 60 } });
    expect(html).toContain('<h2 class="modal-title">Context window</h2>');
    expect(html).not.toContain("segmented");
    expect(text(html)).toContain("210.4K / 400.0K tokens");
    expect(text(html)).toContain("Compact Conversation");
  });

  it("opens on Cache when the advice is a handoff, whatever tab was used last", () => {
    stored.set("ovis:session-tab", "context");
    expect(pressed(sheet())).toBe("Cache");
  });

  it("opens on Context with no tab used yet and no handoff advised", () => {
    expect(pressed(sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } }))).toBe("Context");
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
    // warm now, cold past the deadline: the last call (48 min ago) plus the 60 min lifetime, in the user's clock
    const deadline = new Date(NOW + 12 * 60_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(words).toMatch(/Next call now ~\$0\.16 /);
    expect(words).toContain(`If you wait past ${deadline} ~$2.15`);
    expect(words).not.toContain("after expiry");
    // three warm calls ($0.47) and the new chat's first reply storing 70K + a 2K note ($0.77) (shared/cache-cost.ts handoffUsd)
    expect(words).toMatch(/Hand off now ~\$1\.24 /);
    // an archived chat hands off from its record even while warm: the fresh price (ZAC-266)
    expect(text(sheet({ fresh: true }))).toMatch(/Hand off now ~\$0\.83 /);
    expect(html).toMatch(/class="btn btn-primary"[^>]*>Hand off &amp; continue</);
    // the last call's own hit, not its message's sum
    expect(words).toContain("Last call read from cache 50%");
  });

  it("Cache: a chat waiting on the owner counts down: its open turn calls nothing (owner's phone check)", () => {
    const words = text(sheet({ read: read({ busy: true, status: "asks" }), cost: { chat: chat({ lastCallAt: ago(90) }), calls: CALLS } }));
    expect(words).toContain("Cold");
    expect(words).not.toContain("Working now");
    expect(words).not.toContain("Kept warm while working");
  });

  it("Cache: a chat working now is warm, never 0 min left, its expiry with no deadline yet", () => {
    const words = text(sheet({ read: read({ busy: true }), cost: { chat: chat({ lastCallAt: ago(90) }), calls: CALLS } }));
    expect(words).toContain("Warm");
    expect(words).not.toContain("0 min left");
    expect(words).not.toContain("Cold");
    expect(words).toMatch(/Next call now ~\$0\.16 After the cache expires ~\$2\.15/);
    expect(words).not.toContain("If you wait past");
  });

  it("Cache: a cold chat says it expired, prices its next call cold whatever you do, and a fresh chat's", () => {
    const words = text(sheet({ cost: { chat: chat({ lastCallAt: ago(130) }), calls: CALLS } }));
    expect(words).toContain("2 h ago · expired");
    expect(words).toContain("Free moment to hand off");
    expect(words).toContain("The next call stores 210.4K again whatever you do. If work remains, a fresh chat is cheaper from the next reply on.");
    expect(words).not.toContain("costs nothing extra");
    // no warm price to have: the next call stores the whole context again
    expect(words).not.toContain("Next call now");
    expect(words).not.toContain("If you wait past");
    expect(words).toContain("Next call stores 210.4K again ~$2.15");
    // 70K read warm ($0.035) and the average 2,000 output tokens ($0.05)
    expect(words).toMatch(/In a fresh chat ~\$0\.0[89] per call/);
    // the fresh hand-off, the cold alert's price: the old chat is never called, the new one stores 70K + an 8K digest (ZAC-266)
    expect(words).toMatch(/Hand off now ~\$0\.83 /);
  });

  it("says Handing off… on a disabled button while the job runs", () => {
    const html = sheet({ handingOff: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Handing off…</);
    expect(html).not.toMatch(/>Hand off &amp; continue</);
  });

  it("says Working: hand off when it asks or stops on a disabled button while the chat works without asking", () => {
    const html = sheet({ onHandoff: undefined, handoffWaiting: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Working: hand off when it asks or stops</);
    expect(html).not.toMatch(/>Hand off &amp; continue</);
  });

  it("has no Hand off button when the session does not list /handoff", () => {
    expect(handoffCommandText([{ name: "handoff", description: "", kind: "skill" }])).toBe("/handoff");
    expect(handoffCommandText([{ name: "review", description: "", kind: "skill" }])).toBeNull();
    const html = sheet({ onHandoff: undefined });
    expect(html).not.toMatch(/>Hand off( &amp; continue)?</);
  });

  it("Cost: the total card, its rows in plain words, and pills for what happened", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [{ model: MODEL, input: 2_000_000, cacheRead: 1_800_000, cacheWrite: 150_000, coldWrite: 100_000, output: 40_000, calls: 20 }];
    const html = sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models, rewrites: 2 }), calls: CALLS } });
    const words = text(html);
    // fresh 0.2M × $5 = $1, reads 1.8M × $0.5 = $0.90, storing 50K and restarts 100K × $10 = $0.50 + $1, answers 40K × $25 = $1: $4.40
    expect(words).toContain("This chat · at list price $ 4 .40");
    expect(words).toContain("Re-reading $0.90 20% Storing new text $0.50 11% Cold restarts $1.00 23% Answers $1.00 23% New input $1.00 23%");
    expect(words).toContain("2 cold restarts · $1.00");
    expect(words).toContain("20 calls · 3 replies");
    expect(words).toContain("Rates ⓘ");
    expect(words).not.toContain("local models");
    // no paragraph under the card or the chart
    expect(words).not.toContain("Cache writes priced");
    expect(html).toContain('class="cost-stack session-stack"');
  });

  it("Cost: a chat's first call is a first write, not a cold restart (ZAC-262)", () => {
    stored.set("ovis:session-tab", "cost");
    // 59K stored at $10 a million: $0.59, inside Storing new text
    const models = [{ model: MODEL, input: 59_000, cacheRead: 0, cacheWrite: 59_000, firstWrite: 59_000, output: 0, calls: 1 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models, rewrites: 0, firstWrites: 1 }), calls: CALLS } }));
    expect(words).toContain("First write · $0.59");
    expect(words).toContain("Storing new text $0.59");
    expect(words).not.toContain("cold restart");
    expect(words).not.toContain("Cold restarts");
  });

  it("Cost: first writes and cold restarts show side by side; a bridge before ZAC-262 shows no first write", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [{ model: MODEL, input: 0, cacheRead: 0, cacheWrite: 300_000, coldWrite: 100_000, firstWrite: 100_000, output: 0, calls: 3 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models, rewrites: 1, firstWrites: 2 }), calls: CALLS } }));
    expect(words).toContain("1 cold restart · $1.00");
    expect(words).toContain("2 first writes · $1.00");
    const old = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } }));
    expect(old).not.toContain("first write");
  });

  it("Cost: hides a part that cost nothing, except Re-reading and Answers", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [{ model: MODEL, input: 0, cacheRead: 0, cacheWrite: 0, output: 40_000, calls: 2 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models, rewrites: 0 }), calls: CALLS } }));
    expect(words).toContain("Re-reading $0.00 0% Answers $1.00 100%");
    for (const gone of ["Storing new text", "Cold restarts", "New input", "cold restart"]) expect(words).not.toContain(gone);
  });

  it("Cost: a local model costs $0, says so in a pill and in the rates, and is not missing", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [...chat().models, { model: "litellm/desktop-coder-heretic", input: 9_000_000, cacheRead: 0, cacheWrite: 0, output: 90_000, calls: 40 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toContain("local models $0");
    expect(words).not.toContain("No price");
    expect(words).not.toContain("≥");
  });

  it("Cost: a chat on a local model draws no per-reply chart, as every bar would be $0", () => {
    stored.set("ovis:session-tab", "cost");
    const LOCAL = "litellm/desktop-coder-heretic";
    const models = [{ model: LOCAL, input: 9_000_000, cacheRead: 0, cacheWrite: 0, output: 90_000, calls: 40 }];
    const words = text(sheet({ read: read({ model: { id: LOCAL, effort: null }, context: { currentTokens: 40_000, tokenLimit: 400_000 } }), cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toContain("local models $0");
    expect(words).not.toContain("Per reply");
    expect(words).not.toContain("avg");
  });

  it("Cost: the per-reply chart has its legend, average, both axes and time axis, the context a solid line", () => {
    stored.set("ovis:session-tab", "cost");
    const html = sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } });
    const words = text(html);
    expect(words).toMatch(/Per reply avg \$\d/);
    expect(words).toContain("Cost $ · left Cold restart Context K · right");
    // $ ticks on the left, the time axis, context ticks on the right (chart B)
    expect(words).toMatch(/\$0 \$0\.5 \$1 \$1\.5 avg \S+ \S+ now 0K 100K 200K 300K$/);
    expect(html.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('rx="1.5"');
    // the context line is solid; the dotted line is the average
    expect(/<path [^>]*stroke-dasharray/.test(html)).toBe(false);
    expect(html).toMatch(/<line [^>]*stroke-dasharray/);
  });

  it("Cost: the context line is each reply's context on the right axis's scale (0 to its top tick)", () => {
    stored.set("ovis:session-tab", "cost");
    const html = sheet({ read: quiet, cost: { chat: chat({ context: 40_000 }), calls: CALLS } });
    const points = [...(/<path d="([^"]+)"[^>]*stroke="var\(--accent\)"/.exec(html)?.[1] ?? "").matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    // context 50K, 150K, 210.4K on the 0–300K axis of a 128 px plot: summed input would put 150K near the floor
    expect(points.length).toBe(3);
    expect(points[2]).toBeCloseTo(128 - (210_400 / 300_000) * 128, 0);
    expect(points[1]).toBeCloseTo(128 - (150_000 / 300_000) * 128, 0);
  });

  it("Cost: a model with no price makes the total a floor and is named", () => {
    stored.set("ovis:session-tab", "cost");
    const models = [...chat().models, { model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toMatch(/This chat · at list price ≥ \$ \d/);
    expect(words).toContain("No price for fictional-unpriced.");
  });

  it("prices that answered with nothing: a floor with every model named, not Loading", () => {
    const empty = { prices: null, fallback: null };
    stored.set("ovis:session-tab", "cost");
    const small = { chat: chat({ context: 40_000 }), calls: CALLS };
    const cost = text(sheet({ read: quiet, prices: empty, cost: small }));
    expect(cost).not.toContain("Loading");
    expect(cost).toContain("This chat · at list price ≥ $ 0 .00");
    expect(cost).toContain(`No price for ${MODEL}.`);
    // unpriced, no chat is big (ZAC-260): no handoff forces the Cache tab, it is opened by hand
    stored.set("ovis:session-tab", "cache");
    const cache = text(sheet({ prices: empty }));
    expect(cache).not.toContain("Hand off before it goes cold");
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
    // at $10 a million written, live 155K ($1.55) over a $1.50 threshold, the log's last call 145K ($1.45) under it: the meter advises a handoff
    const html = sheet({ read: read({ context: { currentTokens: 155_000, tokenLimit: 400_000 } }), cost: { chat: chat({ context: 145_000, lastCallAt: ago(10) }), calls: CALLS },
      settings: { trackCosts: true, coldRestartAlertUsd: 1.5, cacheLifetimeMin: 60 } });
    expect(pressed(html)).toBe("Cache");
    expect(text(html)).toContain("Hand off if work remains");
    expect(text(html)).toContain("155.0K is re-read on every call.");
    expect(html).toMatch(/class="btn btn-primary"[^>]*>Hand off &amp; continue</);
  });

  it("Cost: a floor's cents are rounded down", () => {
    stored.set("ovis:session-tab", "cost");
    // $149.60 of output at $25 per million (and a crumb below), and a model with no price: a floor
    const models = [{ model: MODEL, input: 0, cacheRead: 0, cacheWrite: 0, output: 5_984_399, calls: 1 }, { model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    const words = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, models }), calls: CALLS } }));
    expect(words).toContain("This chat · at list price ≥ $ 149 .60");
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

  it("Context while the chat works: the last breakdown kept, the log's newer size, and a note", () => {
    stored.set("ovis:session-tab", "context");
    const busy = read({ busy: true, context: null });
    const kept = { usage: { currentTokens: 150_000, tokenLimit: 400_000, parts: [{ category: "user" as const, label: "Messages", share: 60 }] }, at: Date.parse(ago(30)) };
    const words = text(sheet({ read: busy, lastContext: kept, cost: { chat: chat({ context: 30_000, lastCallAt: ago(1) }), calls: CALLS } }));
    // the log's last call (1 min ago) is newer than the kept breakdown (30 min ago): its size
    expect(words).toContain("30.0K / 400.0K tokens");
    expect(words).toContain("Messages");
    expect(words).toContain("Breakdown as of the last finished turn.");
    const older = text(sheet({ read: busy, lastContext: kept, cost: { chat: chat({ context: 30_000, lastCallAt: ago(45) }), calls: CALLS } }));
    expect(older).toContain("150.0K / 400.0K tokens");
  });

  it("Context with nothing known: one line, never an empty tab", () => {
    stored.set("ovis:session-tab", "context");
    const busy = read({ busy: true, context: null });
    expect(text(sheet({ read: busy, cost: { chat: chat({ context: null, lastCallAt: null }), calls: [] } }))).toContain("No context size yet.");
    const sizeOnly = text(sheet({ read: busy, cost: { chat: chat({ context: 40_000 }), calls: CALLS } }));
    expect(sizeOnly).toContain("40.0K tokens; no breakdown reported while this turn runs.");
    // a chat driven by ask_user is one turn for hours: never promise the turn's end
    expect(sizeOnly).not.toContain("when the turn ends");
  });

  it("Context of an ask_user-driven chat: the split from the chat's log, while the host reports none (phase 1b)", () => {
    stored.set("ovis:session-tab", "context");
    const asking = read({ busy: true, status: "asks", context: null });
    const split = { currentTokens: 42_000, tokenLimit: 400_000, systemTokens: 8_000, toolDefinitionsTokens: 20_000, conversationTokens: 14_000 };
    const words = text(sheet({ read: asking, cost: { chat: chat({ context: 42_000, lastCallAt: ago(1), split }), calls: CALLS } }));
    expect(words).toContain("42.0K / 400.0K tokens");
    expect(words).toContain("System prompt");
    expect(words).toContain("Messages");
    expect(words).toContain("Breakdown from this chat&#x27;s log, as of its last call.");
    // a breakdown the host gave after the log's last call stays the one shown
    const kept = { usage: { currentTokens: 150_000, tokenLimit: 400_000, parts: [{ category: "user" as const, label: "Messages", share: 60 }] }, at: Date.parse(ago(0)) };
    expect(text(sheet({ read: asking, lastContext: kept, cost: { chat: chat({ context: 42_000, lastCallAt: ago(1), split }), calls: CALLS } }))).toContain("Breakdown as of the last finished turn.");
  });

  it("Cache after a model switch: the model has no warm cache, the next call stores it all again (phase 1b)", () => {
    stored.set("ovis:session-tab", "cache");
    const switched = read({ context: { currentTokens: 40_000, tokenLimit: 400_000 }, model: { id: "fictional-other", effort: null } });
    const log = chat({ context: 40_000, lastCallAt: ago(5), lastModel: chat().models[0]!.model, models: chat().models.map((each) => ({ ...each, lastCallAt: ago(5) })) });
    const priced = { prices: { gh: { ...PRICES.prices.gh, "fictional-other": { input: 3, output: 15, cached: 0.3 } } }, fallback: null };
    const words = text(sheet({ read: switched, cost: { chat: log, calls: CALLS }, prices: priced }));
    expect(words).toContain("Cold");
    expect(words).toContain("Model changed");
    expect(words).toContain("the next call stores 40.0K again");
    // the chat's last call and its cache hit were the other model's: not shown as this one's (round 8)
    expect(words).toContain("No call on this model yet");
    expect(words).not.toContain("expired");
    expect(words).not.toContain("Last call read from cache");
    // back on the chat's own model, five minutes after its last call: warm
    const back = text(sheet({ read: read({ context: { currentTokens: 40_000, tokenLimit: 400_000 }, model: { id: chat().models[0]!.model, effort: null } }), cost: { chat: log, calls: CALLS } }));
    expect(back).toContain("Warm");
    expect(back).not.toContain("Model changed");
  });

  it("Cache: captions under the countdown, working and idle", () => {
    stored.set("ovis:session-tab", "cache");
    const working = text(sheet({ read: read({ busy: true, context: { currentTokens: 40_000, tokenLimit: 400_000 } }), cost: { chat: chat({ context: 40_000, lastCallAt: ago(1) }), calls: CALLS } }));
    expect(working).toContain("Kept warm while working Expires 60 min after the last call");
    const idle = text(sheet({ read: quiet, cost: { chat: chat({ context: 40_000, lastCallAt: ago(20) }), calls: CALLS } }));
    expect(idle).toContain("40 min left Expires 60 min after the last call");
  });

  describe("keep-warm (phase 2)", () => {
    const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const lastAt = NOW - 48 * 60_000;
    const key = (over: Partial<KeepWarmKey> = {}): KeepWarmKey => ({
      key: "f".repeat(40), model: MODEL, apiKey: "cop", tokens: 210_400, prompt: 210_400, lastRealAt: lastAt + 20_000, lastPingAt: null,
      nextPingAt: lastAt + 55 * 60_000, until: lastAt + 8 * 3_600_000, pings: 3, usd: 0.18, restartUsd: 2.1,
      missed: false, disabled: false, kept: true, ...over,
    });
    const answer = (over: Partial<KeepWarmKey> = {}, enabled = true): KeepWarmAnswer => ({
      ok: true, writable: true, problem: null, settings: {},
      state: { v: 1, at: NOW, enabled, windowHours: 8, fusePerDay: 200, idleMin: 55, thresholdUsd: 1, available: true, problem: null,
        today: { day: "2026-10-29", pings: 3, usd: 0.18, avoided: 0, avoidedUsd: 0, fuseHit: false }, keys: [key(over)] },
    });
    afterEach(() => keepWarmFeed.set({ ok: false, state: null, settings: {}, writable: false, problem: null }));

    it("a kept chat is warm with its next ping, the switch with until when and today's pings, and the price without it", () => {
      keepWarmFeed.set(answer());
      const html = sheet();
      const words = text(html);
      expect(words).toContain(`Warm kept warm · next ping ${clock(lastAt + 55 * 60_000)}`);
      expect(words).toContain(`Keep warm until ${clock(lastAt + 8 * 3_600_000)} (8 h after the last call) · 3 pings today, ~$0.18`);
      expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Keep warm"/);
      expect(words).toContain(`Without keep-warm, after ${clock(lastAt + 60 * 60_000)} ~$2.15`);
      // kept warm: no "before it goes cold" advice
      expect(words).not.toContain("Hand off before it goes cold");
      expect(words).not.toContain("12 min left");
    });

    it("a kept chat's bar drains from its last ping (ZAC-266): pinged 30 min ago, half its lifetime left", () => {
      keepWarmFeed.set(answer({ lastPingAt: NOW - 30 * 60_000 }));
      const html = sheet();
      const width = Number(/session-cache-bar[^>]*><span[^>]*style="width:([0-9.]+)%"/.exec(html)?.[1] ?? NaN);
      expect(width).toBeCloseTo(50, 0);
      expect(html).toMatch(/aria-valuenow="50"/);
      expect(text(html)).toContain(`Warm kept warm · next ping ${clock(lastAt + 55 * 60_000)}`);
      // no ping yet: it drains from the log's last call (48 min ago: 12 of 60 left)
      keepWarmFeed.set(answer());
      expect(Number(/session-cache-bar[^>]*><span[^>]*style="width:([0-9.]+)%"/.exec(sheet())?.[1] ?? NaN)).toBeCloseTo(20, 0);
    });

    it("a ping that found the cache gone: the cache counts down from the log again, and says why keep-warm stopped", () => {
      keepWarmFeed.set(answer({ missed: true, kept: false }));
      const words = text(sheet());
      expect(words).toContain("48 min ago · 12 min left");
      expect(words).toContain("Stopped: a ping found the cache gone");
      expect(words).toContain("Hand off before it goes cold");
    });

    it("turned off for this chat, or no plugin: phase 1's tab", () => {
      keepWarmFeed.set(answer({ disabled: true, kept: false }));
      expect(sheet()).toMatch(/role="switch" aria-checked="false" aria-label="Keep warm"/);
      keepWarmFeed.set({ ok: false, state: null, settings: {}, writable: false, problem: "Keep-warm is not installed" });
      const words = text(sheet());
      expect(words).not.toContain("Keep warm");
      expect(words).toContain("48 min ago · 12 min left");
    });
  });
});
