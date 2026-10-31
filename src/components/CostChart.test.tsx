import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { CostChart, type MessageCost, messageCosts } from "./CostChart.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let records: Map<string, string>;
let renderer: ReactTestRenderer | undefined;
let downs: ((event: Event) => void)[];

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "Node", "getComputedStyle", "HTMLElement"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  records = new Map();
  downs = [];
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type: string, listener: (event: Event) => void) => { if (type === "pointerdown") downs.push(listener); },
    removeEventListener: (type: string, listener: (event: Event) => void) => { if (type === "pointerdown") downs = downs.filter((each) => each !== listener); },
  } });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const reply = (at: string, over: Partial<MessageCost> = {}): MessageCost => ({ at, restart: 0, rest: 1, context: 100_000, calls: 10, restarts: 0, ...over });
const SHORT = [
  reply("2026-10-29T10:00:00Z", { rest: 0.5, calls: 12 }),
  reply("2026-10-29T11:00:00Z", { rest: 1.92, context: 214_000, calls: 37 }),
  reply("2026-10-29T12:00:00Z", { rest: 1, restart: 0.75, restarts: 1, calls: 3 }),
];
// 45 replies over 3 days (UTC): 15 a day
const LONG = Array.from({ length: 45 }, (_, index) => reply(new Date(Date.UTC(2026, 9, 20 + Math.floor(index / 15), 8, index)).toISOString(), { calls: 2 }));

async function mount(messages: readonly MessageCost[]): Promise<ReactTestRenderer> {
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(CostChart, { messages, priced: true, timeZone: "UTC" }) })); });
  return renderer!;
}
const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const card = (root: ReactTestRenderer): string | null => {
  const found = classed(root.root, "session-chart-card");
  return found.length === 0 ? null : found.map(textOf).join("");
};
const hits = (root: ReactTestRenderer): ReactTestInstance[] => classed(root.root, "session-chart-hit");
const group = (root: ReactTestRenderer): ReactTestInstance => classed(root.root, "session-chart-hits")[0]!;
async function key(root: ReactTestRenderer, name: string): Promise<boolean> {
  let prevented = false;
  await act(async () => { (group(root).props["onKeyDown"] as (event: unknown) => void)({ key: name, preventDefault: () => { prevented = true; }, stopPropagation() {} }); });
  return prevented;
}
const modeButtons = (root: ReactTestRenderer): ReactTestInstance[] => classed(root.root, "session-chart-mode").flatMap((each) => each.findAllByType("button"));

describe("CostChart (option B)", () => {
  it("two axes: $ ticks on the left, context in K on the right, gridlines at the $ ticks", async () => {
    const root = await mount(SHORT);
    const [usd, context] = classed(root.root, "session-chart-yaxis");
    expect(usd!.props["className"]).toContain("is-usd");
    expect(usd!.children.map(textOf)).toEqual(["$0", "$1", "$2"]);
    expect(context!.props["className"]).toContain("is-context");
    expect(context!.children.map(textOf)).toEqual(["0K", "100K", "200K", "300K"]);
    expect(root.root.findAll((each) => each.type === "line" && each.props["stroke"] === "var(--border)")).toHaveLength(3);
  });

  it("a tap on a bar opens its card: reply, date, calls; cost; cold restart only when there was one; context at the end", async () => {
    const root = await mount(SHORT);
    expect(card(root)).toBeNull();
    expect(hits(root)).toHaveLength(3);
    // each hit area is its whole slot
    expect(hits(root).map((each) => (each.props["style"] as { width: string }).width)).toEqual(Array(3).fill(`${100 / 3}%`));
    await act(async () => { (hits(root)[1]!.props["onClick"] as () => void)(); });
    expect(card(root)).toMatch(/^Reply 2 · Oct 29, [^·]+ · 37 callsCost\$1\.92Context at the end214K$/);
    // the others dimmed, a guide and a dot drawn
    const groups = root.root.findAll((each) => each.type === "g");
    expect(groups.map((each) => each.props["opacity"])).toEqual([0.35, 1, 0.35]);
    expect(classed(root.root, "session-chart-guide")).toHaveLength(1);
    expect(classed(root.root, "session-chart-dot")).toHaveLength(1);
    await act(async () => { (hits(root)[2]!.props["onClick"] as () => void)(); });
    expect(card(root)).toContain("Cold restart$0.75");
    // a tap outside clears it
    expect(downs).toHaveLength(1);
    await act(async () => { downs[0]!({ target: {} } as unknown as Event); });
    expect(card(root)).toBeNull();
  });

  it("keyboard: one focus stop, arrows move, Enter selects, Escape clears", async () => {
    const root = await mount(SHORT);
    expect(group(root).props["tabIndex"]).toBe(0);
    expect(hits(root).every((each) => each.props["tabIndex"] === undefined)).toBe(true);
    // the arrows start from the latest reply
    expect(await key(root, "ArrowLeft")).toBe(true);
    expect(group(root).props["aria-activedescendant"]).toBe("session-chart-bar-1");
    await key(root, "ArrowLeft");
    await key(root, "ArrowLeft");
    expect(group(root).props["aria-activedescendant"]).toBe("session-chart-bar-0");
    await key(root, "Enter");
    expect(card(root)).toMatch(/^Reply 1 ·/);
    await key(root, "ArrowRight");
    await key(root, " ");
    expect(card(root)).toMatch(/^Reply 2 ·/);
    expect(hits(root)[1]!.props["aria-selected"]).toBe(true);
    expect(await key(root, "Escape")).toBe(true);
    expect(card(root)).toBeNull();
    // Escape with nothing selected is left to the sheet (it closes)
    expect(await key(root, "Escape")).toBe(false);
  });

  it("up to 40 replies: one bar each, no Replies | Days switch", async () => {
    const root = await mount(LONG.slice(0, 40));
    expect(hits(root)).toHaveLength(40);
    expect(modeButtons(root)).toHaveLength(0);
  });

  it("past 40 replies: one bar per day, a card per day, the switch; Replies scrolls and is remembered", async () => {
    const root = await mount(LONG);
    expect(hits(root)).toHaveLength(3);
    expect(textOf(classed(root.root, "session-kicker")[0]!)).toBe("Per day · 45 replies");
    expect(modeButtons(root).map((each) => [textOf(each), each.props["aria-pressed"]])).toEqual([["Replies", false], ["Days", true]]);
    expect(classed(root.root, "session-chart-axis")[0]!.children.map(textOf)).toEqual(["Oct 20", "Oct 21", "Oct 22"]);
    await act(async () => { (hits(root)[1]!.props["onClick"] as () => void)(); });
    expect(card(root)).toBe("Wed, Oct 21 · 15 replies · 30 callsCost$15.00Largest context100K");
    await act(async () => { (modeButtons(root)[0]!.props["onClick"] as () => void)(); });
    expect(records.get("ovis:cost-chart-mode")).toBe("replies");
    expect(hits(root)).toHaveLength(45);
    expect(card(root)).toBeNull();
    expect(classed(root.root, "is-scrolling")).toHaveLength(1);
    expect((classed(root.root, "session-chart-plot")[0]!.props["style"] as { width: string }).width).toBe("450px");
  });

  it("the remembered choice opens a long chat on replies", async () => {
    records.set("ovis:cost-chart-mode", "replies");
    const root = await mount(LONG);
    expect(hits(root)).toHaveLength(45);
  });
});

describe("CostChart: a reply over an hour long (ZAC-262)", () => {
  // 3 replies; the second ran 3 hours: $3 in its first hour, none in its second (left out by the bridge), $6 and $9 after
  const SPLIT = [
    reply("2026-10-30T19:00:00Z", { rest: 2, calls: 4 }),
    reply("2026-10-30T20:36:00Z", { rest: 18, calls: 30, context: 220_000, hours: [
      reply("2026-10-30T20:36:00Z", { rest: 3, calls: 5, context: 190_000 }),
      reply("2026-10-30T22:36:00Z", { rest: 6, calls: 10, context: 205_000 }),
      reply("2026-10-30T23:36:00Z", { rest: 9, calls: 15, context: 220_000 }),
    ] }),
    reply("2026-10-31T00:50:00Z", { rest: 1, calls: 2 }),
  ];

  it("one bar per hour, a bracket under the reply's bars, the hour's card; avg still per reply", async () => {
    const root = await mount(SPLIT);
    expect(hits(root)).toHaveLength(5);
    const brackets = classed(root.root, "session-chart-bracket");
    expect(brackets.map((each) => each.props["data-reply"])).toEqual([1]);
    // from the second bar's left edge to the fourth's right edge (5 slots of 60 in the 300-wide plot, bars 8.5 wide)
    const style = brackets[0]!.props["style"] as { left: string; width: string };
    expect(parseFloat(style.left)).toBeCloseTo(((60 + (60 - 8.5) / 2) / 300) * 100, 6);
    expect(parseFloat(style.width)).toBeCloseTo(((2 * 60 + 8.5) / 300) * 100, 6);
    await act(async () => { (hits(root)[3]!.props["onClick"] as () => void)(); });
    expect(card(root)).toMatch(/^Reply 2 · part 3 of 3 · Oct 30, (23:36|11:36 PM) · 15 callsCost\$9\.00Context at the end220K$/);
    await act(async () => { (hits(root)[4]!.props["onClick"] as () => void)(); });
    expect(card(root)).toMatch(/^Reply 3 · Oct 31,/);
    // (2 + 18 + 1) / 3 replies, not / 5 bars
    expect(textOf(classed(root.root, "session-chart-avg")[0]!)).toBe("avg $7.00");
    // each hour's tick its own start
    expect(classed(root.root, "session-chart-axis")[0]!.children.map(textOf)[0]).toMatch(/^(19:00|07:00 PM)$/);
  });

  it("a reply without hours (an old bridge): one bar, no bracket", async () => {
    const root = await mount(SPLIT.map(({ hours: _hours, ...each }) => each));
    expect(hits(root)).toHaveLength(3);
    expect(classed(root.root, "session-chart-bracket")).toHaveLength(0);
  });

  it("the Days view sums whole replies: no hours, no bracket", async () => {
    const many = [...LONG.slice(0, 41), ...SPLIT];
    const root = await mount(many);
    expect(textOf(classed(root.root, "session-kicker")[0]!)).toBe("Per day · 44 replies");
    expect(hits(root)).toHaveLength(5);
    expect(classed(root.root, "session-chart-bracket")).toHaveLength(0);
    await act(async () => { (modeButtons(root)[0]!.props["onClick"] as () => void)(); });
    expect(hits(root)).toHaveLength(46);
    expect(classed(root.root, "session-chart-bracket")).toHaveLength(1);
  });
});

describe("messageCosts", () => {
  it("a reply holding the chat's first write draws no cold restart: the write is in the rest (ZAC-262)", () => {
    const [first] = messageCosts([{ at: "2026-10-29T10:00:00Z", input: 0, cacheRead: 0, cacheWrite: 73_961, firstWrite: 73_961, output: 0, main: true, context: 73_961, lastCacheRead: 0, calls: 1, restarts: 0 }], "claude-fictional-4", { input: 5, output: 25, cached: 0.5 });
    expect(first!.restart).toBe(0);
    expect(first!.restarts).toBe(0);
    expect(first!.rest).toBeCloseTo(73_961 * 10 / 1e6, 12);
  });
});
