import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { AgentRowBody, cacheWords } from "../components/AgentSidebar.tsx";
import { translate } from "./i18n.ts";
import { SettingsProvider } from "./settings.ts";
import { minuteClock } from "./hostChats.ts";
import { byGoingCold, createCostsFeed, newerLog, rowCacheMark, type RowCacheMark } from "./rowCache.ts";

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

  it("kept warm by OmniRoute (phase 2): a full warm ring with a flame, whatever the log's age, and says so", () => {
    const kept = rowCacheMark(idle, log(90, 300_000), PRICES, SETTINGS, NOW, true)!;
    expect(kept).toMatchObject({ state: "warm", fraction: 1, leftMin: 60, kept: true });
    const html = body(kept);
    expect(html).toContain('class="cache-ring is-warm is-kept"');
    expect(html).toContain('stroke-dasharray="100.0 100"');
    expect(html).toContain('data-testid="kept-warm"');
    expect(html).toContain(", cache kept warm</span>");
    expect(body(mark(15))).not.toContain("kept-warm");
    // a small chat is not marked even if kept
    expect(rowCacheMark(idle, log(10, 40_000), PRICES, SETTINGS, NOW, true)).toBeNull();
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

  it("sizes the mark's own svg to its 14px box, so the glyph is centred in the ring (phase 1b)", () => {
    // `.sidebar-mark svg` sets --icon-size (18px): only the box shrank, and the glyph hung 2px below
    // the ring's centre (measured at 390px, DPR 3: glyph centre y+2 before, 0 after)
    const css = readFileSync(join(import.meta.dir, "../components/AgentSidebar.css"), "utf8");
    const rule = css.split("}").find((block) => block.includes(".sidebar-mark.has-cache-ring > :not(.cache-ring, .cache-ring-flame) svg"));
    expect(rule).toBeDefined();
    expect(rule).toContain("width: 14px; height: 14px;");
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

describe("the costs feed keeps in step without a reload (phase 1b)", () => {
  const answer: HostCostsAnswer = { chats: [], complete: true };
  const row = (modified: string, status: HostChatRow["status"] = "idle"): HostChatRow => ({ session: "copilotcli:/a", title: "FICTIONAL", status, modified_at: modified, cwd: null, unread: false, archived: false });
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function rig() {
    const asked: string[] = [];
    let resume = () => {};
    let rows: (machineId: string, rows: readonly HostChatRow[]) => void = () => {};
    const feed = createCostsFeed(
      { costs: async (machineId) => { asked.push(machineId); return answer; }, prices: async () => PRICES },
      { resume: (listener) => { resume = listener; return () => { resume = () => {}; }; }, rows: (listener) => { rows = listener; return () => { rows = () => {}; }; } },
      5,
    );
    return { asked, feed, resume: () => resume(), rows: (machineId: string, each: readonly HostChatRow[]) => rows(machineId, each) };
  }
  function withVisibility(state: "visible" | "hidden", run: () => Promise<void>): Promise<void> {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: state, addEventListener() {}, removeEventListener() {} } });
    return run().finally(() => { if (saved) Object.defineProperty(globalThis, "document", saved); else delete (globalThis as { document?: unknown }).document; });
  }

  it("asks a PC once when its list pushes a new modified_at, a burst of pushes debounced into one", async () => {
    const { asked, feed, rows } = rig();
    const release = feed.want(["desk"]);
    await tick(0);
    expect(asked).toEqual(["desk"]);
    rows("desk", [row("2026-10-30T10:00:00.000Z")]);
    // the same rows again: nothing moved
    rows("desk", [row("2026-10-30T10:00:00.000Z")]);
    await tick(15); // fixed wait: proving nothing is asked, three debounces long
    expect(asked).toEqual(["desk"]);
    rows("desk", [row("2026-10-30T10:01:00.000Z")]);
    rows("desk", [row("2026-10-30T10:01:02.000Z")]);
    rows("desk", [row("2026-10-30T10:01:02.000Z", "asks")]);
    const deadline = Date.now() + 2_000;
    while (asked.length < 2) { if (Date.now() > deadline) throw new Error("the change was never asked"); await tick(1); }
    await tick(15); // fixed wait: proving the burst asks once, not three times
    expect(asked).toEqual(["desk", "desk"]);
    // a PC no list wants is never asked
    rows("laptop", [row("2026-10-30T10:00:00.000Z")]);
    rows("laptop", [row("2026-10-30T10:02:00.000Z")]);
    await tick(15); // fixed wait: proving nothing is asked
    expect(asked).toEqual(["desk", "desk"]);
    release();
  });

  it("asks every wanted PC at once when the page is shown again or the stream reopens", async () => {
    const { asked, feed, resume } = rig();
    const release = feed.want(["desk", "laptop"]);
    await tick(0);
    asked.length = 0;
    await withVisibility("visible", async () => { resume(); await tick(0); });
    expect(asked.sort()).toEqual(["desk", "laptop"]);
    release();
  });

  it("asks nothing while the page is hidden", async () => {
    const { asked, feed, resume, rows } = rig();
    const release = feed.want(["desk"]);
    await tick(0);
    asked.length = 0;
    await withVisibility("hidden", async () => {
      rows("desk", [row("2026-10-30T10:00:00.000Z")]);
      rows("desk", [row("2026-10-30T10:05:00.000Z")]);
      resume();
      await tick(15); // fixed wait: proving nothing is asked while hidden
    });
    expect(asked).toEqual([]);
    release();
  });

  it("forgets a request still in flight on reset: the next want asks the PC again", async () => {
    const asked: string[] = [];
    let hang = true;
    const feed = createCostsFeed({ costs: (machineId) => { asked.push(machineId); return hang ? new Promise(() => {}) : Promise.resolve(answer); }, prices: async () => PRICES }, { resume: () => () => {}, rows: () => () => {} });
    const first = feed.want(["desk"]);
    await tick(0);
    first();
    feed.reset();
    hang = false;
    const second = feed.want(["desk"]);
    await tick(0);
    expect(asked).toEqual(["desk", "desk"]);
    expect(feed.read().answers.get("desk")).toEqual(answer);
    second();
  });

  it("keeps the newer of the open chat's own log and the PC's answer", async () => {
    const older = { ...log(30, 300_000), session: "copilotcli:/a" };
    const newer = { ...log(2, 300_000), session: "copilotcli:/a" };
    const feed = createCostsFeed({ costs: async () => ({ chats: [older], complete: true }), prices: async () => PRICES }, { resume: () => () => {}, rows: () => () => {} });
    const release = feed.want(["desk"]);
    await tick(0);
    feed.note("desk", newer);
    expect(feed.read().answers.get("desk")!.chats[0]!.lastCallAt).toBe(newer.lastCallAt);
    // an older one noted changes nothing
    feed.note("desk", older);
    expect(feed.read().answers.get("desk")!.chats[0]!.lastCallAt).toBe(newer.lastCallAt);
    // the PC answering an older log again keeps the newer one noted
    feed.ask();
    await tick(0);
    expect(feed.read().answers.get("desk")!.chats[0]!.lastCallAt).toBe(newer.lastCallAt);
    expect(newerLog(older, newer)).toBe(newer);
    expect(newerLog(undefined, older)).toBe(older);
    release();
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
