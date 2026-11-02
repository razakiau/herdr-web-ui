import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HostPc } from "../lib/hostChats.ts";

// the sheet is portalled to document.body, which the renderer has not: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { AddToGroupSheet } = await import("./AddToGroupSheet.tsx");
const { SettingsProvider } = await import("../lib/settings.ts");

const row = (session: string, title: string): HostChatRow =>
  ({ session, title, status: "idle", modified_at: new Date().toISOString(), cwd: "/w/fictional", unread: false, archived: false });
const group = (id: number, name: string, members: [string, string][]): ChatGroup => ({
  id, name, createdAt: "2026-10-29T09:00:00Z", updatedAt: "2026-10-31T09:00:00Z",
  members: members.map(([pc, session]) => ({ pc, session, joined: "manual", addedAt: "2026-10-30T09:00:00Z" })),
});
const ANSWER: GroupsAnswer = {
  groups: [group(1, "FICTIONAL mac work", [["local", "a"]]), group(2, "FICTIONAL desk work", [["desk", "d"]])],
  links: [], summaries: [], digests: [], digestDefaults: { model: "m", effort: "low" },
};
const MACHINES = [{ id: "local", name: "Mac" }, { id: "desk", name: "Desk" }] as unknown as Machine[];
const HOST_CHATS: ReadonlyMap<string, HostPc> = new Map([["local", { host: null, chats: [row("a", "A"), row("free", "Free")] }]]);

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame: () => 0, history: { state: null, pushState() {}, replaceState() {}, back() {} }, location: { href: "/" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 390, innerHeight: 844,
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
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

const nodeMock = () => ({ focus() {}, contains: () => false, closest: () => null, isConnected: true, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), style: {} });
const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));

async function sheet(mergeFrom: ChatGroup | null = null): Promise<ReactTestInstance> {
  const view = createElement(AddToGroupSheet, { chat: { pc: "local", session: "free" }, mergeFrom, answer: ANSWER, hostChats: HOST_CHATS, machines: MACHINES, onClose: () => {} });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: view }), { createNodeMock: nodeMock }); });
  return renderer!.root;
}

describe("Add to group: the PC filter and the search, one row", () => {
  for (const mode of ["add", "merge"] as const) {
    it(`${mode}: the PC pill comes first in the search row, the search after it; New group… is its own row`, async () => {
      const root = await sheet(mode === "merge" ? group(3, "FICTIONAL source", [["local", "s"]]) : null);
      const line = classed(root, "add-to-group-search-line")[0]!;
      // the row's own elements in order: All agents' sort pill (a menu button, no native select), then the field
      const kids = line.findAll((each) => (each.type === "button" && each.props["aria-haspopup"] === "menu") || each.type === "label");
      expect(kids.map((each) => each.type)).toEqual(["button", "label"]);
      expect(kids[0]!.props["className"]).toContain("group-pc-filter");
      expect(kids[0]!.props["className"]).toContain("all-agents-sort");
      expect(root.findAll((each) => each.type === "select")).toHaveLength(0);
      const news = classed(root, "add-to-group-new");
      expect(news).toHaveLength(mode === "add" ? 1 : 0);
      if (news[0]) expect(classed(news[0], "group-pc-filter")).toHaveLength(0);
    });
  }

  it("filters the lists by the PC picked in the pill's menu: All PCs, then each PC by name, the pick checked", async () => {
    const root = await sheet();
    const names = () => root.findAll((each) => each.props["role"] === "radio").map((each) => classed(each, "add-to-group-name")[0]!.children.join(""));
    const text = (node: ReactTestInstance): string => node.children.map((each) => typeof each === "string" ? each : text(each)).join("");
    const pill = () => classed(root, "group-pc-filter")[0]!;
    expect(names().sort()).toEqual(["FICTIONAL desk work", "FICTIONAL mac work"]);
    expect(text(pill())).toBe("All PCs");
    expect(pill().props["aria-label"]).toBe("Show groups on: All PCs");
    await act(async () => { pill().props["onClick"]({ currentTarget: nodeMock() }); });
    expect(pill().props["aria-expanded"]).toBe(true);
    const items = () => root.findAll((each) => each.type === "button" && each.props["role"] === "menuitemcheckbox");
    expect(items().map((item) => [text(item), item.props["aria-checked"]])).toEqual([["All PCs", true], ["Desk", false], ["Mac", false]]);
    await act(async () => { items()[1]!.props["onClick"](); });
    expect(items()).toEqual([]);
    expect(names()).toEqual(["FICTIONAL desk work"]);
    expect(text(pill())).toBe("Desk");
  });
});
