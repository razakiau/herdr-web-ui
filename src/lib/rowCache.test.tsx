import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { AgentRowBody, cacheWords } from "../components/AgentSidebar.tsx";
import { translate } from "./i18n.ts";
import { SettingsProvider } from "./settings.ts";
import { minuteClock } from "./hostChats.ts";
import { byGoingCold, createCostsFeed, rowCacheMark, type RowCacheMark } from "./rowCache.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const MODEL = "claude-fictional-4";
// $5 in, written at $10: 300K is a $3 cold restart, 40K $0.40
const PRICES = { prices: { gh: { [MODEL]: { input: 5, output: 25, cached: 0.5 } } }, fallback: null };
const SETTINGS = { coldRestartAlertUsd: 1, cacheLifetimeMin: 60 };
const log = (lastMin: number, context: number, model = MODEL): HostChatCost => ({
  session: "s", models: [{ model, input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1 }], lastCallAt: ago(lastMin), context, peak: context, rewrites: 0, days: {}, partial: false,
});
const idle = { status: "idle" as const };

describe("rowCacheMark", () => {
  it("drains from full after the last call to empty at expiry", () => {
    expect(rowCacheMark(idle, log(0, 300_000), PRICES, SETTINGS, NOW)?.fraction).toBe(1);
    expect(rowCacheMark(idle, log(15, 300_000), PRICES, SETTINGS, NOW)).toMatchObject({ state: "warm", fraction: 0.75, leftMin: 45, context: 300_000 });
    expect(rowCacheMark(idle, log(48, 300_000), PRICES, SETTINGS, NOW)).toMatchObject({ state: "cooling", leftMin: 12 });
    expect(rowCacheMark(idle, log(48, 300_000), PRICES, SETTINGS, NOW)!.fraction).toBeCloseTo(0.2, 9);
    expect(rowCacheMark(idle, log(61, 300_000), PRICES, SETTINGS, NOW)).toMatchObject({ state: "cold", fraction: 0 });
  });
  it("marks a chat waiting on the owner: it calls nothing while it asks, so its cache drains", () => {
    expect(rowCacheMark({ status: "asks" }, log(48, 300_000), PRICES, SETTINGS, NOW)).toMatchObject({ state: "cooling", leftMin: 12 });
    expect(rowCacheMark({ status: "asks" }, log(150, 300_000), PRICES, SETTINGS, NOW)).toMatchObject({ state: "cold", fraction: 0 });
  });
  it("is absent for a working chat, a small one, an unpriced or local one, and without a log or prices", () => {
    expect(rowCacheMark({ status: "working" }, log(10, 300_000), PRICES, SETTINGS, NOW)).toBeNull();
    expect(rowCacheMark(idle, log(10, 40_000), PRICES, SETTINGS, NOW)).toBeNull();
    expect(rowCacheMark(idle, log(10, 900_000, "mystery-1"), PRICES, SETTINGS, NOW)).toBeNull();
    expect(rowCacheMark(idle, log(10, 900_000, "desktop-coder"), PRICES, SETTINGS, NOW)).toBeNull();
    expect(rowCacheMark(idle, undefined, PRICES, SETTINGS, NOW)).toBeNull();
    expect(rowCacheMark(idle, log(10, 300_000), null, SETTINGS, NOW)).toBeNull();
  });
});

describe("the sidebar's ring (AgentRowBody cacheRing)", () => {
  const t = (key: string, values?: Record<string, string | number>) => translate("en", key, values);
  const body = (ring: RowCacheMark | null): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(AgentRowBody, {
        mark: "copilot", markKind: "Copilot", title: "FICTIONAL chat", name: null, context: "zhomelab", tokens: [], status: "idle",
        cacheRing: ring, cacheWords: ring ? cacheWords(ring, t) : null,
      }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const mark = (lastMin: number) => rowCacheMark(idle, log(lastMin, 300_000), PRICES, SETTINGS, NOW)!;

  it("draws a draining stroke in the cache's state while warm or cooling, and says the minutes left", () => {
    const html = body(mark(15));
    expect(html).toContain('class="cache-ring is-warm"');
    expect(html).toContain('stroke-dasharray="75.0 100"');
    expect(html).toContain('pathLength="100"');
    expect(html).toContain("FICTIONAL chat</span><span class=\"visually-hidden\">, cache warm, 45 min left</span>");
    expect(body(mark(48))).toContain('class="cache-ring is-cooling"');
    expect(body(mark(48))).toContain("cache cooling, 12 min left");
  });

  it("is dashed all round once cold, with no track, and says cache cold", () => {
    const html = body(mark(90));
    expect(html).toContain('class="cache-ring is-cold"');
    expect(html).toContain('stroke-dasharray="2 2.6"');
    expect(html).not.toContain("cache-ring-track");
    expect(html).toContain(", cache cold</span>");
  });

  it("is a circle centred on the mark, its arc from 12 o'clock, the mark shrunk inside it (round 6)", () => {
    const html = body(mark(15));
    expect(html).not.toContain("<rect");
    expect(html).toContain('<circle cx="12" cy="12" r="11"');
    expect(html).toContain('transform="rotate(-90 12 12)"');
    // the logo shrinks to fit inside the ring, which sits in the mark's own cell, not over the title
    expect(html).toContain('width="14" height="14"');
    expect(body(null)).toContain('width="18" height="18"');
  });

  it("is absent with no mark (a small or busy chat): the row is today's", () => {
    const html = body(null);
    expect(html).not.toContain("cache-ring");
    expect(html).not.toContain("cache warm");
  });
});

describe("byGoingCold", () => {
  const row = (session: string, modifiedMin: number): HostChatRow => ({ session, title: session, status: "idle", modified_at: ago(modifiedMin), cwd: null, unread: false, archived: false });
  it("puts the big warm chats by minutes left, then the cold ones newest call first, then the rest by Recent", () => {
    const logs = new Map<string, HostChatCost>([
      ["warm", log(10, 300_000)], ["cooling", log(50, 300_000)], ["cold-old", log(400, 300_000)], ["cold-new", log(70, 300_000)],
      ["small-a", log(1, 10_000)], ["small-b", log(2, 10_000)],
    ]);
    const marks = new Map([...logs].flatMap(([session, each]): [string, RowCacheMark][] => { const found = rowCacheMark(idle, each, PRICES, SETTINGS, NOW); return found ? [[session, found]] : []; }));
    const rows = [row("small-b", 2), row("cold-old", 3), row("warm", 4), row("small-a", 1), row("cold-new", 5), row("cooling", 6)];
    expect(byGoingCold(rows, marks, logs).map((each) => each.session)).toEqual(["cooling", "warm", "cold-new", "cold-old", "small-a", "small-b"]);
  });
});

describe("the page's costs feed", () => {
  const answer: HostCostsAnswer = { chats: [], complete: true };
  it("asks a PC once however many lists want it, and lets the timer go when none does", async () => {
    const asked: string[] = [];
    const feed = createCostsFeed({ costs: async (machineId) => { asked.push(machineId); return answer; }, prices: async () => PRICES });
    const releaseSidebar = feed.want(["desk", "laptop"]);
    await Promise.resolve(); await Promise.resolve();
    const releaseSheet = feed.want(["desk"]);
    await Promise.resolve(); await Promise.resolve();
    expect(asked.sort()).toEqual(["desk", "laptop"]);
    expect(feed.read().answers.get("desk")).toEqual(answer);
    expect(feed.read().prices).toEqual(PRICES);
    releaseSidebar();
    releaseSheet();
    feed.reset();
    expect(feed.read().answers.size).toBe(0);
  });
});

describe("the minute clock", () => {
  it("runs one interval for every listener, and none once they all leave", () => {
    const before = minuteClock.running();
    const stops = Array.from({ length: 50 }, () => minuteClock.subscribe(() => {}));
    expect(minuteClock.running()).toBe(true);
    for (const stop of stops) stop();
    expect(minuteClock.running()).toBe(before);
  });
  it("does not tick while the page is hidden", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} } });
    try {
      const stop = minuteClock.subscribe(() => {});
      expect(minuteClock.running()).toBe(false);
      stop();
    } finally {
      if (saved) Object.defineProperty(globalThis, "document", saved);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
