import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { HostChatCost, HostChatRow, HostCostModel, HostCostsAnswer } from "../../shared/host-chats.ts";
import { SETTINGS_STORAGE_KEY } from "../lib/themeBoot.ts";

// the sheet is portalled to document.body, which the test renderer has not: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { CostsChip } = await import("./CostsChip.tsx");
const { SettingsProvider } = await import("../lib/settings.ts");

const MODEL = "claude-fictional-4";
// $25 per million output tokens: the sums below are whole dollars
const PRICES = { gh: { [MODEL]: { input: 5, output: 25, cached: 0.5 } } };
const day = (back: number): string => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const out = (millions: number): HostCostModel[] => [{ model: MODEL, input: 0, cacheRead: 0, cacheWrite: 0, output: millions * 1_000_000, calls: 1 }];
const cost = (session: string, days: Record<string, HostCostModel[]>, over: Partial<HostChatCost> = {}): HostChatCost =>
  ({ session, models: Object.values(days).flat(), lastCallAt: null, context: null, peak: 0, rewrites: 0, days, partial: false, ...over });
const row = (session: string, title: string): HostChatRow =>
  ({ session, title, status: "idle", modified_at: new Date().toISOString(), cwd: "/w/fictional", unread: false, archived: false });

// Desk: $100 today and $50 two days ago; CDE: $62 yesterday and $40 twenty days ago. 7 days: $212
const ANSWERS: Record<string, HostCostsAnswer> = {
  desk: { complete: true, chats: [cost("s:/a", { [day(0)]: out(4) }), cost("s:/b", { [day(2)]: out(2) })] },
  cde: { complete: true, chats: [cost("s:/c", { [day(1)]: out(2.48) }), cost("s:/d", { [day(20)]: out(1.6) })] },
};
const PCS = [
  { id: "desk", name: "Desk", chats: [row("s:/a", "FICTIONAL cost line"), row("s:/b", "FICTIONAL other")] },
  { id: "cde", name: "CDE fictional", chats: [row("s:/c", "FICTIONAL thresholds")] },
  { id: "old", name: "Old PC", chats: [] },
];

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let records: Map<string, string>;
let urls: string[];
let pricesReply: unknown;
let hang: boolean;
let picked: unknown[];
let renderer: ReactTestRenderer | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  records = new Map();
  urls = [];
  picked = [];
  hang = false;
  pricesReply = { prices: PRICES, fallback: null };
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/pricing")) return json(200, pricesReply);
    if (hang) return new Promise<Response>(() => {});
    const machine = /\/api\/machines\/([^/]+)\//.exec(url)?.[1] ?? "";
    const answer = ANSWERS[machine];
    return answer ? json(200, answer) : json(404, { error: { code: "not_found", message: "unknown endpoint /api/host-chats/costs" } });
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

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await act(async () => { await Promise.resolve(); }); };

async function mount(track: boolean): Promise<ReactTestRenderer> {
  records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ trackCosts: track }));
  const chip = createElement(CostsChip, { pcs: PCS, onAllAgents: (on: unknown) => { picked.push(on); } });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: chip })); });
  await flush();
  return renderer!;
}

const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const chipOf = (root: ReactTestRenderer): ReactTestInstance[] => classed(root.root, "costs-chip");
async function openSheet(root: ReactTestRenderer): Promise<ReactTestInstance> {
  await act(async () => { (chipOf(root)[0]!.props["onClick"] as () => void)(); });
  await flush();
  return classed(root.root, "costs-sheet")[0]!;
}
const button = (node: ReactTestInstance, text: string): ReactTestInstance =>
  node.find((each) => each.type === "button" && textOf(each) === text);

describe("the costs chip", () => {
  it("sums every PC's last 7 days in whole dollars, no ~, the period in small caps over a split bar, beside the plan chips", async () => {
    const root = await mount(true);
    expect(urls.filter((url) => url.endsWith("/host-chats/costs")).sort()).toEqual(["/api/machines/cde/host-chats/costs", "/api/machines/desk/host-chats/costs", "/api/machines/old/host-chats/costs"]);
    const chip = chipOf(root);
    expect(chip).toHaveLength(1);
    expect(chip[0]!.type).toBe("button");
    expect(chip[0]!.props["className"]).toContain("usage-strip");
    expect(textOf(classed(chip[0]!, "costs-chip-usd")[0]!)).toBe("$212");
    expect(textOf(classed(chip[0]!, "costs-chip-period")[0]!)).toBe("7d");
    expect(classed(chip[0]!, "costs-chip-bar")[0]!.children.map((part) => (part as ReactTestInstance).props["className"])).toEqual(["cost-part is-output"]);
    // the sans amount, not the plan chips' mono value
    expect(classed(chip[0]!, "usage-chip-value")).toEqual([]);
  });

  it("a floor only dims the chip's amount: no ≥ on the chip, the sheet says it", async () => {
    const saved = ANSWERS["desk"]!;
    ANSWERS["desk"] = { ...saved, complete: false };
    try {
      const root = await mount(true);
      const chip = chipOf(root)[0]!;
      expect(textOf(classed(chip, "costs-chip-usd")[0]!)).toBe("$212");
      expect(classed(chip, "costs-chip-body")[0]!.props["className"]).toContain("is-floor");
      // a screen reader hears the floor in words, never the "≥" the chip does not show
      expect(chip.props["aria-label"]).toBe("Chat costs: at least $212 7d");
      expect(chip.props["aria-label"]).not.toContain("≥");
      await act(async () => { chip.props["onClick"](); });
      await flush();
      expect(textOf(classed(root.root, "costs-total")[0]!)).toContain("≥ $212");
    } finally { ANSWERS["desk"] = saved; }
  });

  it("is absent while costs are not tracked, and asks nothing", async () => {
    const root = await mount(false);
    expect(chipOf(root)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("is absent while no PC has answered", async () => {
    hang = true;
    const root = await mount(true);
    expect(chipOf(root)).toEqual([]);
  });
});

describe("the Costs sheet", () => {
  it("asks again on opening, and lists By PC with the chats and the biggest", async () => {
    const root = await mount(true);
    const before = urls.length;
    const sheet = await openSheet(root);
    expect(urls.slice(before).filter((url) => url.endsWith("/host-chats/costs"))).toHaveLength(3);
    expect(textOf(classed(sheet, "costs-total")[0]!)).toContain("~$212");
    expect(textOf(sheet)).toContain("Copilot chats");
    const rows = classed(sheet, "costs-pc");
    expect(rows.map((each) => textOf(classed(each, "costs-pc-name")[0]!))).toEqual(["Desk", "CDE fictional"]);
    expect(rows.map((each) => textOf(classed(each, "costs-pc-usd")[0]!))).toEqual(["~$150", "~$62"]);
    expect(textOf(classed(rows[0]!, "costs-pc-meta")[0]!)).toBe("2 chats · biggest: FICTIONAL cost line ~$100");
    expect(textOf(classed(rows[1]!, "costs-pc-meta")[0]!)).toBe("1 chat · biggest: FICTIONAL thresholds ~$62");
    expect(classed(sheet, "costs-stack")[0]!.children.map((part) => (part as ReactTestInstance).props["className"])).toEqual(["cost-part is-output"]);
    // each PC's row has its amount and its 56×4 split
    expect(classed(sheet, "costs-pc").map((each) => classed(each, "cost-mini").length)).toEqual([1, 1]);
  });

  it("names a PC whose bridge predates costs under the total, and leaves it out of the sums", async () => {
    const sheet = await openSheet(await mount(true));
    expect(textOf(sheet)).toContain("Old PC: update the bridge to count it");
    expect(classed(sheet, "costs-pc").map((each) => textOf(classed(each, "costs-pc-name")[0]!))).not.toContain("Old PC");
    expect(textOf(sheet)).not.toContain("Error");
  });

  it("switches to Today and 30 days, the chip with it", async () => {
    const root = await mount(true);
    const sheet = await openSheet(root);
    await act(async () => { (button(sheet, "Today").props["onClick"] as () => void)(); });
    expect(textOf(classed(root.root, "costs-total")[0]!)).toContain("~$100");
    expect(textOf(chipOf(root)[0]!)).toBe("$100today");
    await act(async () => { (button(classed(root.root, "costs-sheet")[0]!, "30 days").props["onClick"] as () => void)(); });
    expect(textOf(classed(root.root, "costs-total")[0]!)).toContain("~$252");
    expect(textOf(chipOf(root)[0]!)).toBe("$25230d");
  });

  it("opens a PC's All agents sorted by cost when it is tapped", async () => {
    const root = await mount(true);
    const sheet = await openSheet(root);
    await act(async () => { (classed(sheet, "costs-pc")[1]!.props["onClick"] as () => void)(); });
    expect(picked).toEqual([{ machineId: "cde", sort: "cost" }]);
    expect(classed(root.root, "costs-sheet")).toEqual([]);
  });

  it("shows no figure while prices are unavailable, and says why", async () => {
    pricesReply = { prices: null, fallback: null };
    const root = await mount(true);
    expect(textOf(chipOf(root)[0]!)).toBe("—7d");
    const sheet = await openSheet(root);
    expect(textOf(sheet)).toContain("Prices are unavailable: costs not shown.");
    expect(textOf(sheet)).not.toContain("$");
    expect(classed(sheet, "costs-pc")).toEqual([]);
  });
});
