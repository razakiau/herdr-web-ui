import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { DigestSnapshot } from "../../shared/digest.ts";

// the sheet is portalled to document.body, which the test renderer has not: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { WeekSheet } = await import("./WeekSheet.tsx");
const { SettingsProvider } = await import("../lib/settings.ts");

/**
 * The "This week" page (ZAC-262, mockup B): the digest's snapshot as stored, phone first (390 px):
 * the range, the total as the Cost tab's hero, how it moved, a bar a day, the pills, the costliest
 * chats, keep-warm, and the earlier weeks one tap or swipe away.
 */

const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
const snapshot = (over: Partial<DigestSnapshot> = {}): DigestSnapshot => ({
  week: "2026-10-26", from: Date.parse("2026-10-26T00:00:00Z"), cut: Date.parse("2026-11-01T18:00:00Z"), built: Date.parse("2026-11-01T18:00:00Z"),
  total: { usd: 184.2, floor: false },
  days: DAYS.map((day, index) => ({ day, usd: [31, 22, 40, 18, 35, 12, 26.2][index]!, restartsUsd: index === 2 ? 9.1 : index === 4 ? 9 : 0 })),
  chats: [
    { machineId: "desk", session: "s:/a", title: "FICTIONAL cost page", usd: 61.4, restarts: 2 },
    { machineId: "cde", session: "s:/b", title: "FICTIONAL thresholds", usd: 33, restarts: 1 },
    { machineId: "desk", session: "s:/c", title: "", usd: 20.5, restarts: 0 },
    { machineId: "desk", session: "s:/d", title: "FICTIONAL fourth", usd: 10, restarts: 0 },
  ],
  pcs: [{ machineId: "desk", name: "Desk", usd: 130, chats: 25 }, { machineId: "cde", name: "CDE", usd: 54.2, chats: 12 }],
  offline: [], noCounts: [],
  restarts: { n: 3, usd: 18.1 }, firstWrites: { n: 2, usd: 4.2 }, handoffs: 4,
  keepWarm: { pings: 40, usd: 4, avoided: 5, avoidedUsd: 29 },
  cutDay: { day: "2026-11-01", perChat: {}, counts: {}, keepWarm: null },
  ...over,
});
// the list as the server gives it: newest first
const LAST_WEEK = snapshot({ week: "2026-10-19", from: Date.parse("2026-10-19T00:00:00Z"), cut: Date.parse("2026-10-25T17:00:00Z"), total: { usd: 162, floor: false },
  days: DAYS.slice(0, 5).map((day) => ({ day: day.replace("2026-10-2", "2026-10-1"), usd: 32.4, restartsUsd: 0 })), offline: ["Laptop"], noCounts: ["CDE"],
  pcs: [{ machineId: "desk", name: "Desk", usd: 162, chats: 1 }] });
const DIGESTS = [snapshot(), LAST_WEEK];

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let opened: unknown[];

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  opened = [];
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    innerWidth: 390,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [],
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
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

async function mount(digests: readonly DigestSnapshot[] | null, week: string | null = null): Promise<ReactTestInstance> {
  const sheet = createElement(WeekSheet, { digests, week, onOpenChat: (target: unknown) => { opened.push(target); }, onClose: () => {} });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: sheet })); });
  return renderer!.root;
}

const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const one = (node: ReactTestInstance, name: string): string => textOf(classed(node, name)[0]!);
const labelled = (node: ReactTestInstance, label: string): ReactTestInstance =>
  node.find((each) => each.type === "button" && each.props["aria-label"] === label);

describe("the This week page", () => {
  it("says the range at list price, the total as the Cost tab's hero, and how it moved", async () => {
    const root = await mount(DIGESTS);
    expect(classed(root, "week-sheet")[0]!.props["className"]).toContain("session-sheet");
    expect(one(root, "week-range")).toBe("Oct 26 – Nov 1 · at list price");
    expect(one(root, "session-hero")).toBe("$184.20");
    expect(one(root, "week-delta")).toBe("▲ $22 vs last week · 37 chats on 2 PCs");
  });

  it("draws a bar a day, its cold-restart part in the restart colour", async () => {
    const root = await mount(DIGESTS);
    const bars = classed(root, "week-bar");
    expect(bars).toHaveLength(7);
    expect(bars.map((bar) => classed(bar, "is-restarts").length)).toEqual([0, 0, 1, 0, 1, 0, 0]);
    expect(classed(bars[2]!, "cost-part").map((part) => part.props["className"])).toEqual(["cost-part is-reads", "cost-part is-restarts"]);
    // the costliest day is the full height
    expect(classed(bars[2]!, "week-bar-stack")[0]!.props["style"]).toEqual({ height: "100%" });
    expect(classed(root, "week-bar-day").map(textOf)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });

  // the notification's dollars (shared/digest.ts digestUsd): whole from $10 on, cents under
  it("shows the week's pills", async () => {
    const root = await mount(DIGESTS);
    expect(classed(root, "session-cost-pill").map(textOf)).toEqual(["🧊 3 cold restarts · $18", "🔥 saved $25", "🤝 4 hand-offs", "✨ 2 first writes · $4.20"]);
    expect(classed(root, "session-cost-pill")[0]!.props["className"]).toContain("is-restart");
  });

  it("lists the top 3 chats, and a tap opens the chat", async () => {
    const root = await mount(DIGESTS);
    const rows = classed(root, "week-chat");
    expect(rows.map((row) => one(row, "week-chat-title"))).toEqual(["FICTIONAL cost page", "FICTIONAL thresholds", "Copilot chat"]);
    expect(rows.map((row) => one(row, "week-chat-meta"))).toEqual(["Desk · 2 cold restarts", "CDE · 1 cold restart", "Desk"]);
    expect(rows.map((row) => one(row, "week-chat-usd"))).toEqual(["$61", "$33", "$21"]);
    await act(async () => { (rows[1]!.props["onClick"] as () => void)(); });
    expect(opened).toEqual([{ machineId: "cde", session: "s:/b" }]);
  });

  it("lists keep-warm's pings, the restarts avoided and the net saved", async () => {
    const root = await mount(DIGESTS);
    const rows = classed(classed(root, "week-keep-warm")[0]!, "session-part");
    expect(rows.map(textOf)).toEqual(["Pings40 · $4.00", "Restarts avoided5 · $29", "Net saved$25"]);
  });

  it("goes to the previous week and back, each arrow off at its end", async () => {
    const root = await mount(DIGESTS);
    expect(labelled(root, "Next week").props["disabled"]).toBe(true);
    expect(labelled(root, "Previous week").props["disabled"]).toBe(false);
    await act(async () => { (labelled(root, "Previous week").props["onClick"] as () => void)(); });
    expect(one(root, "week-range")).toBe("Oct 19 – Oct 25 · at list price");
    expect(labelled(root, "Previous week").props["disabled"]).toBe(true);
    expect(labelled(root, "Next week").props["disabled"]).toBe(false);
    // the first week has no earlier one: no arrow, only the counts; fewer than 7 days drawn as they are
    expect(one(root, "week-delta")).toBe("1 chat on 1 PC");
    expect(classed(root, "week-bar")).toHaveLength(5);
    await act(async () => { (labelled(root, "Next week").props["onClick"] as () => void)(); });
    expect(one(root, "week-range")).toBe("Oct 26 – Nov 1 · at list price");
  });

  it("names a PC not counted, and one whose bridge has no counts", async () => {
    const root = await mount(DIGESTS, "2026-10-19");
    expect(classed(root, "week-note").map(textOf)).toEqual(["Laptop not counted", "CDE: update the bridge to count restarts and hand-offs"]);
  });

  it("opens on the week a link names, and says so when it has none", async () => {
    expect(one(await mount(DIGESTS, "2026-10-19"), "week-range")).toBe("Oct 19 – Oct 25 · at list price");
    expect(textOf(classed(await mount(DIGESTS, "2025-01-06"), "host-context-body")[0]!)).toContain("No digest for that week.");
  });

  it("says when it is loading or there is no digest yet", async () => {
    expect(textOf(classed(await mount(null), "host-context-body")[0]!)).toContain("Loading…");
    expect(textOf(classed(await mount([]), "host-context-body")[0]!)).toContain("No weekly digest yet: the first comes on Sunday at 19:00.");
  });

  it("marks a floor's total and says ▼ when the week cost less", async () => {
    const root = await mount([snapshot({ total: { usd: 140, floor: true } }), LAST_WEEK]);
    expect(one(root, "session-hero")).toBe("≥$140.00");
    expect(one(root, "week-delta")).toBe("▼ $22 vs last week · 37 chats on 2 PCs");
  });
});
