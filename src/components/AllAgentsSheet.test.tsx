import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { HostChatCost, HostChatRow, HostCostsAnswer } from "../../shared/host-chats.ts";
import { SETTINGS_STORAGE_KEY } from "../lib/themeBoot.ts";

// the sheet is portalled to document.body, which neither renderer has: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { AllAgentsSheet } = await import("./AllAgentsSheet.tsx");
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
  chats: [cost("copilotcli:/big", BIG, { lastCallAt: ago(60 * 24 * 3) }), cost("copilotcli:/small", SMALL, { peak: 40_000, rewrites: 0 }), cost("copilotcli:/gone", BIG)],
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
  pricesReply = { prices: PRICES, fallback: null };
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame: () => 0,
    innerWidth: 390, innerHeight: 844,
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
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

async function open(track: boolean, props: { initialSort?: "recent" | "cost" } = {}): Promise<ReactTestRenderer> {
  records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ trackCosts: track }));
  const sheet = createElement(AllAgentsSheet, { machineId: "desk", machineName: "Desk", pc: { host: null, chats: CHATS }, selected: null, onOpen: () => {}, onClose: () => {}, ...props });
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
    expect(items().map((item) => [textOf(item), item.props["aria-checked"]])).toEqual([["Recent", true], ["Cost, highest first", false]]);
    await act(async () => { items()[1]!.props["onClick"](); });
    expect(items()).toEqual([]);
    expect(textOf(chip())).toBe("Cost");
    expect(rows(sheet)).toEqual(["copilotcli:/big", "copilotcli:/small"]);
  });

  it("says a row's cold restarts on its second line after the folder and age, in both sorts, and no peak", async () => {
    for (const sort of ["recent", "cost"] as const) {
      const sheet = await open(true, { initialSort: sort });
      expect(textOf(classed(rowOf(sheet, "copilotcli:/big"), "agent-context")[0]!)).toMatch(/^fictional · .+ · 3 cold restarts$/);
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
