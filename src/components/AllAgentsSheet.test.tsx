import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { SETTINGS_STORAGE_KEY } from "../lib/themeBoot.ts";

/**
 * A browser history the sheets' Back entries (lib/sheetHistory.ts) live in: one object for the
 * whole file, as that module wraps its pushState and listens for popstate once, when it is loaded.
 * `backs` counts every history.back(), the user's and a sheet's own step off its entry.
 */
const nav = { entries: [{ state: null as unknown }], index: 0, backs: 0 };
const popListeners: Array<(event: { state: unknown }) => void> = [];
const traverse = (by: number): void => {
  const next = Math.max(0, Math.min(nav.entries.length - 1, nav.index + by));
  if (next === nav.index) return;
  nav.index = next;
  queueMicrotask(() => { for (const listener of popListeners) listener({ state: nav.entries[nav.index]!.state }); });
};
const fakeHistory = {
  get state() { return nav.entries[nav.index]!.state; },
  pushState(state: unknown) { nav.entries.splice(nav.index + 1); nav.entries.push({ state }); nav.index += 1; },
  replaceState(state: unknown) { nav.entries[nav.index] = { state }; },
  back() { nav.backs += 1; traverse(-1); },
  forward() { traverse(1); },
  go(by: number) { traverse(by); },
};
const historyWindow = {
  history: fakeHistory,
  location: { href: "/" },
  addEventListener: (type: string, listener: (event: { state: unknown }) => void) => { if (type === "popstate") popListeners.push(listener); },
  removeEventListener: () => {},
};
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: historyWindow });
/** whether the media queries say phone: the sheet's Back entry and RowMenu's bottom sheet follow it */
let phone = false;
const sheetMarked = (): boolean => typeof (fakeHistory.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string";

// the sheet is portalled to document.body, which neither renderer has: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { AllAgentsSheet } = await import("./AllAgentsSheet.tsx");
const { costsFeed } = await import("../lib/rowCache.ts");
type Sort = import("./AllAgentsSheet.tsx").Sort;
const { SettingsProvider } = await import("../lib/settings.ts");

const NOW = Date.now();
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const MODEL = "claude-fictional-4";
const PRICES = { gh: { [MODEL]: { input: 5, output: 25, cached: 0.5 } } };

const row = (session: string, minutes: number, over: Partial<HostChatRow> = {}): HostChatRow =>
  ({ session, title: `FICTIONAL ${session}`, status: "idle", modified_at: ago(minutes), cwd: "/w/fictional", unread: false, archived: false, ...over });
const cost = (session: string, models: HostChatCost["models"], over: Partial<HostChatCost> = {}): HostChatCost =>
  ({ session, models, lastCallAt: ago(5), context: 120_000, peak: 329_000, rewrites: 3, days: {}, partial: false, ...over });
// the prompt holds the read, not the write: fresh 0.4M × $5 = $2, reads 5M × $0.5 = $2.5, storing 0.45M and
// cold restarts 0.4M × $10 = $4.5 + $4, output 1M × $25 = $25: $38
const BIG = [{ model: MODEL, input: 5_400_000, cacheRead: 5_000_000, cacheWrite: 850_000, coldWrite: 400_000, output: 1_000_000, calls: 200 }];
// reads 1M × $0.5 = $0.5, output 0.1M × $25 = $2.5: $3
const SMALL = [{ model: MODEL, input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000, calls: 20 }];

const CHATS = [
  row("copilotcli:/small", 3),
  row("copilotcli:/none", 10),
  row("copilotcli:/big", 60 * 24 * 3),
];
const ANSWER: HostCostsAnswer = {
  chats: [cost("copilotcli:/big", BIG, { lastCallAt: ago(60 * 24 * 3) }), cost("copilotcli:/small", SMALL, { context: 40_000, peak: 40_000, rewrites: 0 }), cost("copilotcli:/gone", BIG)],
  complete: true,
};

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let records: Map<string, string>;
let urls: string[];
let costsReply: { status: number; body: unknown };
let pricesReply: unknown;
let renderer: ReactTestRenderer | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  records = new Map();
  urls = [];
  costsReply = { status: 200, body: ANSWER };
  // the page's costs feed outlives a sheet: each test starts from no answers
  costsFeed.reset();
  pricesReply = { prices: PRICES, fallback: null };
  const events = new EventTarget();
  phone = false;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
    addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => type === "popstate" ? popListeners.push(listener as never) : events.addEventListener(type, listener, options),
    removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame: () => 0,
    history: fakeHistory,
    location: historyWindow.location,
    matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 390, innerHeight: 844,
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const reply = url.endsWith("/pricing") ? { status: 200, body: pricesReply } : costsReply;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  globalThis.fetch = realFetch;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

/** a DOM node enough for the sheet's refs (the focus trap, the sort menu's popover, the pills' fade) */
const nodeMock = () => ({
  focus() {}, contains: () => false, closest: () => null, isConnected: true, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  offsetWidth: 200, offsetHeight: 80, scrollLeft: 0, scrollWidth: 0, clientWidth: 0, style: {},
});

async function open(track: boolean, props: { initialSort?: Sort; chats?: HostChatRow[] } = {}, settings: Record<string, unknown> = {}): Promise<ReactTestRenderer> {
  records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ trackCosts: track, ...settings }));
  const { chats = CHATS, ...rest } = props;
  const sheet = createElement(AllAgentsSheet, { machineId: "desk", machineName: "Desk", pc: { host: null, chats }, selected: null, onOpen: () => {}, onClose: () => {}, ...rest });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: sheet }), { createNodeMock: nodeMock }); });
  // the costs and the prices answer
  for (let turn = 0; turn < 10; turn++) await act(async () => { await Promise.resolve(); });
  return renderer!;
}

const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const rowOf = (sheet: ReactTestRenderer, session: string): ReactTestInstance =>
  sheet.root.find((each) => each.type === "li" && each.props["data-host-session"] === session);
const rows = (sheet: ReactTestRenderer): string[] =>
  sheet.root.findAll((each) => each.type === "li" && typeof each.props["data-host-session"] === "string").map((each) => each.props["data-host-session"] as string);

describe("All agents with costs tracked", () => {
  it("asks the PC's bridge for its costs and the prices on opening", async () => {
    await open(true);
    expect(urls.sort()).toEqual(["/api/machines/desk/host-chats/costs", "/api/usage/omniroute/pricing"]);
  });

  it("gives a Copilot row its cost and a split bar of the five parts it spent on", async () => {
    const sheet = await open(true);
    const big = rowOf(sheet, "copilotcli:/big");
    expect(textOf(classed(big, "all-agents-usd")[0]!)).toBe("~$38");
    const bar = classed(big, "all-agents-split")[0]!;
    expect(bar.props["aria-hidden"]).toBe("true");
    expect(bar.children.map((part) => (part as ReactTestInstance).props["className"])).toEqual(["cost-part is-reads", "cost-part is-writes", "cost-part is-restarts", "cost-part is-output", "cost-part is-fresh"]);
    expect(textOf(classed(rowOf(sheet, "copilotcli:/small"), "all-agents-usd")[0]!)).toBe("~$3.00");
  });

  it("draws nothing for a row without a cost: no dash, no bar", async () => {
    const none = rowOf(await open(true), "copilotcli:/none");
    expect(classed(none, "all-agents-cost")).toEqual([]);
    expect(classed(none, "all-agents-split")).toEqual([]);
  });

  it("marks a row whose cache is still warm, not one long cold", async () => {
    const sheet = await open(true);
    expect(classed(rowOf(sheet, "copilotcli:/small"), "session-dot").map((dot) => dot.props["className"])).toEqual(["session-dot is-warm"]);
    expect(classed(rowOf(sheet, "copilotcli:/big"), "session-dot")).toEqual([]);
  });

  it("gives each age group its subtotal, and the list a summary line: total, chats, scope and the split", async () => {
    const sheet = await open(true);
    const subtotals = classed(sheet.root, "all-agents-subtotal").map(textOf);
    expect(subtotals).toEqual(["~$3.00", "~$38"]);
    expect(textOf(classed(sheet.root, "all-agents-summary-total")[0]!)).toBe("~$41");
    expect(textOf(classed(sheet.root, "all-agents-summary-scope")[0]!)).toBe("3 chats · all folders");
    expect(classed(classed(sheet.root, "all-agents-summary")[0]!, "cost-part")).toHaveLength(5);
    // the old toggle and its "Copilot chats" total are gone
    for (const gone of ["all-agents-toolbar", "all-agents-total", "segmented"]) expect(classed(sheet.root, gone)).toEqual([]);
  });

  it("totals only what the search keeps", async () => {
    const sheet = await open(true);
    const search = sheet.root.find((each) => each.type === "input");
    await act(async () => { search.props["onChange"]({ target: { value: "small" } }); });
    expect(textOf(classed(sheet.root, "all-agents-summary-total")[0]!)).toBe("~$3.00");
    expect(textOf(classed(sheet.root, "all-agents-summary-scope")[0]!)).toBe("1 chat · all folders");
  });

  it("puts a sort chip first in the pill row; its menu sorts by cost and back, the pick checked", async () => {
    const sheet = await open(true);
    const chip = () => classed(sheet.root, "all-agents-sort")[0]!;
    expect(textOf(chip())).toBe("Recent");
    expect(chip().props["aria-haspopup"]).toBe("menu");
    await act(async () => { chip().props["onClick"]({ currentTarget: nodeMock() }); });
    expect(chip().props["aria-expanded"]).toBe(true);
    const items = () => sheet.root.findAll((each) => each.type === "button" && each.props["role"] === "menuitemcheckbox");
    expect(items().map((item) => [textOf(item), item.props["aria-checked"]])).toEqual([["Recent", true], ["Cost, highest first", false], ["Going cold", false]]);
    await act(async () => { items()[1]!.props["onClick"](); });
    expect(items()).toEqual([]);
    expect(textOf(chip())).toBe("Cost");
    expect(rows(sheet)).toEqual(["copilotcli:/big", "copilotcli:/small"]);
  });

  it("says a row's cold restarts on its second line after the folder and age, in both sorts, and no peak", async () => {
    for (const sort of ["recent", "cost"] as const) {
      const sheet = await open(true, { initialSort: sort });
      expect(textOf(classed(rowOf(sheet, "copilotcli:/big"), "agent-context")[0]!)).toMatch(/^fictional · .+ · 3 cold restarts · 120K · cold$/);
      expect(textOf(classed(rowOf(sheet, "copilotcli:/small"), "agent-context")[0]!)).not.toContain("cold restart");
      expect(classed(sheet.root, "agent-tokens")).toEqual([]);
      expect(textOf(sheet.root)).not.toContain("peak");
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("makes a partly read chat, and every total while the bridge's first scan runs, a floor", async () => {
    costsReply = { status: 200, body: { chats: [cost("copilotcli:/small", SMALL, { partial: true }), cost("copilotcli:/big", BIG)], complete: false } };
    const sheet = await open(true);
    expect(textOf(classed(rowOf(sheet, "copilotcli:/small"), "all-agents-usd")[0]!)).toBe("≥ $3.00");
    expect(textOf(classed(rowOf(sheet, "copilotcli:/big"), "all-agents-usd")[0]!)).toBe("≥ $38");
    expect(classed(sheet.root, "all-agents-subtotal").map(textOf)).toEqual(["≥ $3.00", "≥ $38"]);
    expect(textOf(classed(sheet.root, "all-agents-summary-total")[0]!)).toBe("≥ $41");
  });

  it("sorts by cost: one flat list, biggest first, without the rows that have no cost, the summary kept", async () => {
    const sheet = await open(true, { initialSort: "cost" });
    expect(rows(sheet)).toEqual(["copilotcli:/big", "copilotcli:/small"]);
    expect(classed(sheet.root, "all-agents-age")).toEqual([]);
    expect(textOf(classed(sheet.root, "all-agents-summary-total")[0]!)).toBe("~$41");
    // the count is of the rows the Cost list shows: "none", without a cost, is not among them
    expect(textOf(classed(sheet.root, "all-agents-summary-scope")[0]!)).toBe("2 chats · all folders");
  });

  it("opens sorted by cost when asked to", async () => {
    expect(rows(await open(true, { initialSort: "cost" }))).toEqual(["copilotcli:/big", "copilotcli:/small"]);
  });

  it("says to update the bridge once, in a banner, and no error, for a PC whose bridge predates costs (404)", async () => {
    costsReply = { status: 404, body: { error: { code: "not_found", message: "unknown endpoint /api/host-chats/costs" } } };
    const sheet = await open(true, { initialSort: "cost" });
    expect(rows(sheet)).toEqual(["copilotcli:/small", "copilotcli:/none", "copilotcli:/big"]);
    // the rows carry no cost cell and no text of their own: the banner says it
    expect(classed(sheet.root, "all-agents-cost")).toEqual([]);
    expect(classed(sheet.root, "all-agents-split")).toEqual([]);
    for (const gone of ["all-agents-sort", "all-agents-summary"]) expect(classed(sheet.root, gone)).toEqual([]);
    expect(classed(sheet.root, "all-agents-subtotal")).toEqual([]);
    expect(textOf(sheet.root)).toContain("Update the bridge on this PC to show costs.");
    expect(textOf(sheet.root)).not.toContain("Error");
  });
});

describe("All agents on a phone", () => {
  // a sheet's step off its entry runs after a 0 ms timer, its popstate in a microtask
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

  it("Back with the sort menu open closes the menu only: the sheet stays, and no history entry is stepped off for it", async () => {
    phone = true;
    let closed = 0;
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ trackCosts: true }));
    const sheet = createElement(AllAgentsSheet, { machineId: "desk", machineName: "Desk", pc: { host: null, chats: CHATS }, selected: null, onOpen: () => {}, onClose: () => { closed += 1; } });
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: sheet }), { createNodeMock: nodeMock }); });
    for (let turn = 0; turn < 10; turn++) await act(async () => { await Promise.resolve(); });
    await settle();
    const backs = nav.backs;
    expect(sheetMarked()).toBe(true);
    const chip = () => classed(renderer!.root, "all-agents-sort")[0]!;
    await act(async () => { chip().props["onClick"]({ currentTarget: nodeMock() }); });
    await settle();
    // the menu took the sheet's entry over: nothing stepped back, one entry still marked
    expect(chip().props["aria-expanded"]).toBe(true);
    expect(nav.backs).toBe(backs);
    expect(sheetMarked()).toBe(true);
    // the system Back
    fakeHistory.back();
    await settle();
    expect(chip().props["aria-expanded"]).toBe(false);
    expect(closed).toBe(0);
    expect(nav.backs).toBe(backs + 1);
    // the sheet has its Back entry again, so the next Back closes it
    expect(sheetMarked()).toBe(true);
    // a pick closes the menu without a Back: the entry goes back to the sheet, no step off either way
    await act(async () => { chip().props["onClick"]({ currentTarget: nodeMock() }); });
    await settle();
    const pick = renderer!.root.findAll((each) => each.type === "button" && each.props["role"] === "menuitemcheckbox")[1]!;
    await act(async () => { pick.props["onClick"](); });
    await settle();
    expect(chip().props["aria-expanded"]).toBe(false);
    expect(nav.backs).toBe(backs + 1);
    expect(sheetMarked()).toBe(true);
    expect(closed).toBe(0);
    fakeHistory.back();
    await settle();
    expect(closed).toBe(1);
  });
});

describe("All agents with local models", () => {
  it("prices a local model's chat $0 · local with no bar, and names no missing price", async () => {
    const LOCAL = [{ model: "litellm/desktop-coder-heretic", input: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 50_000, calls: 30 }];
    costsReply = { status: 200, body: { chats: [cost("copilotcli:/big", BIG), cost("copilotcli:/small", LOCAL)], complete: true } };
    const sheet = await open(true);
    const small = rowOf(sheet, "copilotcli:/small");
    expect(classed(small, "all-agents-usd").map(textOf)).toEqual(["$0 · local"]);
    expect(classed(small, "all-agents-split")).toEqual([]);
    expect(classed(sheet.root, "all-agents-missing")).toEqual([]);
  });
});

describe("All agents without prices", () => {
  it("names a model with no price on its row and under the total, the cost a floor", async () => {
    const STRANGE = [{ model: "fictional-unpriced", input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 }];
    costsReply = { status: 200, body: { chats: [cost("copilotcli:/big", [...BIG, ...STRANGE]), cost("copilotcli:/small", SMALL)], complete: true } };
    const sheet = await open(true);
    const big = rowOf(sheet, "copilotcli:/big");
    expect(textOf(classed(big, "all-agents-usd")[0]!)).toBe("≥ $38");
    expect(big.find((each) => each.type === "button" && typeof each.props["title"] === "string" && each.props["className"]?.includes("agent-row")).props["title"]).toContain("No price for fictional-unpriced.");
    expect(classed(sheet.root, "all-agents-missing").map(textOf)).toEqual(["No price for fictional-unpriced."]);
    expect(classed(rowOf(sheet, "copilotcli:/small"), "all-agents-usd").map(textOf)).toEqual(["~$3.00"]);
  });

  it("shows no figure at all, and says why, when the price table could not be had", async () => {
    pricesReply = { prices: null, fallback: null };
    const sheet = await open(true);
    for (const name of ["all-agents-cost", "all-agents-sort", "all-agents-subtotal", "all-agents-summary"]) expect(classed(sheet.root, name)).toEqual([]);
    expect(textOf(sheet.root)).not.toContain("$0");
    expect(textOf(sheet.root)).toContain("Prices are unavailable: costs not shown.");
  });
});

describe("All agents with costs not tracked", () => {
  it("is today's sheet: nothing asked, no cost, no toggle, no total, by age even when asked for cost", async () => {
    const sheet = await open(false, { initialSort: "cost" });
    expect(urls).toEqual([]);
    expect(rows(sheet)).toEqual(["copilotcli:/small", "copilotcli:/none", "copilotcli:/big"]);
    for (const name of ["all-agents-cost", "all-agents-sort", "all-agents-subtotal", "all-agents-summary", "session-dot"]) expect(classed(sheet.root, name)).toEqual([]);
    expect(classed(sheet.root, "all-agents-age").map(textOf)).toEqual(["Today", "Last 7 days"]);
  });
});

describe("All agents: a big chat's cache (ZAC-260 phase 1)", () => {
  // context × $10 written (a $5 Claude model): 300K is $3 (big), 40K $0.40 (small); lifetime 60 min
  const BIG_CHATS = [
    row("copilotcli:/warm", 2), row("copilotcli:/cooling", 1), row("copilotcli:/cold-old", 30), row("copilotcli:/cold-new", 20),
    row("copilotcli:/small", 0), row("copilotcli:/busy", 40, { status: "working" }), row("copilotcli:/asks", 50, { status: "asks" }),
  ];
  const BIG_ANSWER: HostCostsAnswer = { complete: true, chats: [
    cost("copilotcli:/warm", SMALL, { lastCallAt: ago(10), context: 300_000, rewrites: 0 }),
    cost("copilotcli:/cooling", SMALL, { lastCallAt: ago(48), context: 268_000, rewrites: 0 }),
    cost("copilotcli:/cold-old", SMALL, { lastCallAt: ago(300), context: 312_000, rewrites: 0 }),
    cost("copilotcli:/cold-new", SMALL, { lastCallAt: ago(90), context: 1_200_000, rewrites: 0 }),
    cost("copilotcli:/small", SMALL, { lastCallAt: ago(50), context: 40_000, rewrites: 0 }),
    cost("copilotcli:/busy", SMALL, { lastCallAt: ago(55), context: 300_000, rewrites: 0 }),
    cost("copilotcli:/asks", SMALL, { lastCallAt: ago(56), context: 300_000, rewrites: 0 }),
  ] };
  const cacheText = (sheet: ReactTestRenderer, session: string): string | null => {
    const found = classed(rowOf(sheet, session), "all-agents-cache")[0];
    return found ? `${found.props["className"]}: ${textOf(found)}` : null;
  };

  it("says a big chat's size and minutes left, or cold, after its folder, in the cache's colour; nothing for a small or busy one", async () => {
    costsReply = { status: 200, body: BIG_ANSWER };
    const sheet = await open(true, { chats: BIG_CHATS });
    expect(cacheText(sheet, "copilotcli:/warm")).toBe("all-agents-cache is-warm: 300K · 50m left");
    expect(cacheText(sheet, "copilotcli:/cooling")).toBe("all-agents-cache is-cooling: 268K · 12m left");
    expect(cacheText(sheet, "copilotcli:/cold-old")).toBe("all-agents-cache is-cold: 312K · cold");
    expect(cacheText(sheet, "copilotcli:/cold-new")).toBe("all-agents-cache is-cold: 1.2M · cold");
    for (const quiet of ["copilotcli:/small", "copilotcli:/busy", "copilotcli:/asks"]) expect(cacheText(sheet, quiet)).toBeNull();
    expect(textOf(classed(rowOf(sheet, "copilotcli:/cooling"), "agent-context")[0]!)).toMatch(/^fictional · .+ · 268K · 12m left$/);
    // the warm dot is a small chat's only: a big one says it in words
    expect(classed(rowOf(sheet, "copilotcli:/warm"), "session-dot")).toEqual([]);
    expect(classed(rowOf(sheet, "copilotcli:/small"), "session-dot").length).toBe(1);
  });

  it("follows the dollar threshold: at $4 only the 1.2M chat ($12) is big", async () => {
    costsReply = { status: 200, body: BIG_ANSWER };
    const sheet = await open(true, { chats: BIG_CHATS }, { coldRestartAlertUsd: 4 });
    expect(cacheText(sheet, "copilotcli:/warm")).toBeNull();
    expect(cacheText(sheet, "copilotcli:/cold-new")).toBe("all-agents-cache is-cold: 1.2M · cold");
  });

  it("Going cold: big chats by minutes left, then the cold big ones newest call first, then the rest as Recent", async () => {
    costsReply = { status: 200, body: BIG_ANSWER };
    const sheet = await open(true, { chats: BIG_CHATS, initialSort: "cold" });
    expect(textOf(classed(sheet.root, "all-agents-sort")[0]!)).toBe("Going cold");
    expect(rows(sheet)).toEqual(["copilotcli:/cooling", "copilotcli:/warm", "copilotcli:/cold-new", "copilotcli:/cold-old", "copilotcli:/small", "copilotcli:/busy", "copilotcli:/asks"]);
    // the summary line is the same as in Recent
    expect(textOf(classed(sheet.root, "all-agents-summary-scope")[0]!)).toBe("7 chats · all folders");
  });
});
