import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HostPc } from "../lib/hostChats.ts";

// the page is portalled to document.body, which the renderer has not: drawn in place instead
const realDom = await import("react-dom");
mock.module("react-dom", () => ({ ...realDom, createPortal: (node: ReactNode) => node }));
const { GroupPage } = await import("./GroupPage.tsx");
const { SettingsProvider } = await import("../lib/settings.ts");

const row = (session: string, title: string, over: Partial<HostChatRow> = {}): HostChatRow =>
  ({ session, title, status: "idle", modified_at: new Date().toISOString(), cwd: "/w/fictional", unread: false, archived: false, ...over });
const machine = (id: string, name: string, state: Machine["state"]): Machine =>
  ({ id, name, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot: null } as unknown as Machine);

const GROUP: ChatGroup = {
  id: 7, name: "FICTIONAL keep-warm", createdAt: "2026-10-29T09:00:00Z", updatedAt: "2026-10-31T09:00:00Z",
  members: [
    { pc: "local", session: "s-old", joined: "link", addedAt: "2026-10-29T09:00:00Z" },
    { pc: "local", session: "s-new", joined: "link", addedAt: "2026-10-30T09:00:00Z" },
    { pc: "cde", session: "s-far", joined: "manual", addedAt: "2026-10-31T09:00:00Z" },
  ],
};
const ANSWER: GroupsAnswer = {
  groups: [GROUP],
  links: [{ pc: "local", from: "s-old", to: "s-new", kind: "resume", at: "2026-10-30T09:00:00Z" }],
  summaries: [], digests: [], digestDefaults: { model: "m", effort: "low" },
};
const MACHINES = [machine("local", "Mac", "connected"), machine("cde", "CDE", "disconnected")];
const HOST_CHATS: ReadonlyMap<string, HostPc> = new Map([["local", { host: null, chats: [
  row("s-old", "FICTIONAL-262 follow-ups", { archived: true }),
  row("s-new", "FICTIONAL-265 groups", { status: "working" }),
] }]]);

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
const realFetch = globalThis.fetch;
let urls: string[] = [];

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  urls = [];
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame: () => 0,
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    location: { href: "/" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 390, innerHeight: 844,
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  } });
  // every chat read fails: the page still draws each member
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ error: { code: "down", message: "down" } }), { status: 502, headers: { "content-type": "application/json" } });
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

const nodeMock = () => ({ focus() {}, contains: () => false, closest: () => null, isConnected: true, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), style: {} });

async function open(): Promise<ReactTestRenderer> {
  const page = createElement(GroupPage, { group: GROUP, answer: ANSWER, machines: MACHINES, hostChats: HOST_CHATS, onOpenChat: () => {}, onClose: () => {} });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: page }), { createNodeMock: nodeMock }); });
  for (let turn = 0; turn < 5; turn++) await act(async () => { await Promise.resolve(); });
  return renderer!;
}

const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const card = (page: ReactTestRenderer, key: string): ReactTestInstance => page.root.find((each) => each.type === "li" && each.props["data-member"] === key);
const classed = (node: ReactTestInstance, name: string): ReactTestInstance[] =>
  node.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));

describe("the group page", () => {
  it("draws every member in hand-off order, the one added by hand last", async () => {
    const page = await open();
    const keys = page.root.findAll((each) => each.type === "li" && typeof each.props["data-member"] === "string").map((each) => each.props["data-member"] as string);
    expect(keys).toEqual(["local s-old", "local s-new", "cde s-far"]);
  });

  it("marks an archived member with the archived icon, and still opens it", async () => {
    const page = await open();
    const old = card(page, "local s-old");
    expect(classed(old, "group-member-archived")).toHaveLength(1);
    expect(textOf(old)).toContain("FICTIONAL-262 follow-ups");
    expect(old.findAll((each) => each.type === "button").length).toBeGreaterThan(0);
  });

  it("says PC offline for a member whose PC is offline, rather than hiding it", async () => {
    const page = await open();
    expect(textOf(card(page, "cde s-far"))).toContain("PC offline");
    // an offline PC is not asked for the chat's artifacts
    expect(urls.some((url) => url.includes("/machines/cde/"))).toBe(false);
  });

  it("says the join between cards: a hand-off, and a chat added by hand", async () => {
    const page = await open();
    const joins = classed(page.root, "group-join").map(textOf);
    expect(joins).toEqual(["handed off · resume", "added by you"]);
  });

  it("leaves the digest's place empty", async () => {
    const page = await open();
    expect(classed(page.root, "group-digest-slot")).toHaveLength(0);
  });
});
