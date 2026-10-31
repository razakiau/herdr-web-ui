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

  it("drops the artifacts of a chat that leaves the group while the page is open", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://x");
      urls.push(url.toString());
      const session = url.searchParams.get("session");
      const artifacts = session === "s-old" ? [{ id: "p1", type: "pullRequest", label: "FICTIONAL#1", isArtifact: true, link: "https://example.invalid/pull/1" }]
        : session === "s-new" ? [{ id: "f1", type: "file", label: "notes.md", isArtifact: true, uri: "file:///w/notes.md" }] : [];
      return new Response(JSON.stringify({ session, busy: false, title: "", turns: [], artifacts }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const page = await open();
    const chips = () => classed(page.root, "group-artifact-chip").map(textOf);
    expect(chips()).toEqual(["1 pull request", "1 file"]);
    // a nudge moved s-old out of the group
    const left: ChatGroup = { ...GROUP, members: GROUP.members.filter((member) => member.session !== "s-old") };
    await act(async () => { page.update(createElement(SettingsProvider, { children: createElement(GroupPage, { group: left, answer: { ...ANSWER, groups: [left] }, machines: MACHINES, hostChats: HOST_CHATS, onOpenChat: () => {}, onClose: () => {} }) })); });
    for (let turn = 0; turn < 5; turn++) await act(async () => { await Promise.resolve(); });
    expect(chips()).toEqual(["1 file"]);
  });

  it("reads at most three chats at a time, and does not read them again on a re-render", async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise<Response>((resolve) => pending.push(() => {
        inFlight -= 1;
        resolve(new Response(JSON.stringify({ session: "x", busy: false, title: "", turns: [], artifacts: [] }), { status: 200, headers: { "content-type": "application/json" } }));
      }));
    }) as typeof fetch;
    const many: ChatGroup = { ...GROUP, members: Array.from({ length: 7 }, (_, at) => ({ pc: "local", session: `s-${at}`, joined: "manual" as const, addedAt: `2026-10-29T0${at}:00:00Z` })) };
    const props = { group: many, answer: { ...ANSWER, groups: [many], links: [] }, machines: MACHINES, hostChats: HOST_CHATS, onOpenChat: () => {}, onClose: () => {} };
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(GroupPage, props) }), { createNodeMock: nodeMock }); });
    expect(urls).toHaveLength(3);
    // every read answered, one by one: the rest follow, never more than three at once
    const deadline = Date.now() + 5_000;
    while (urls.length < 7 || pending.length > 0) {
      if (Date.now() > deadline) throw new Error("the reads did not all run");
      await act(async () => { pending.shift()?.(); await Promise.resolve(); await Promise.resolve(); });
    }
    expect(most).toBe(3);
    expect(urls).toHaveLength(7);
    // the same members again (a nudge, a PC reconnecting): no new reads
    await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(GroupPage, { ...props, group: { ...many }, machines: [...MACHINES] }) })); });
    for (let turn = 0; turn < 5; turn++) await act(async () => { await Promise.resolve(); });
    expect(urls).toHaveLength(7);
  });

  it("a read that never answers frees its place once it times out, and counts as no artifacts", async () => {
    // AbortSignal.timeout stands in: each read's signal is aborted by hand, as its timer would
    const realTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    const timers: { ms: number; controller: AbortController }[] = [];
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: (ms: number) => {
      const controller = new AbortController();
      timers.push({ ms, controller });
      return controller.signal;
    } });
    try {
      // every read hangs until its signal aborts, as fetch does
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
      }) as typeof fetch;
      const four: ChatGroup = { ...GROUP, members: Array.from({ length: 4 }, (_, at) => ({ pc: "local", session: `s-${at}`, joined: "manual" as const, addedAt: `2026-10-29T0${at}:00:00Z` })) };
      const props = { group: four, answer: { ...ANSWER, groups: [four], links: [] }, machines: MACHINES, hostChats: HOST_CHATS, onOpenChat: () => {}, onClose: () => {} };
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(GroupPage, props) }), { createNodeMock: nodeMock }); });
      expect(urls).toHaveLength(3);
      expect(timers.map((each) => each.ms)).toEqual([20_000, 20_000, 20_000]);
      // the first read times out: the fourth takes its place
      await act(async () => { timers[0]!.controller.abort(); for (let turn = 0; turn < 5; turn++) await Promise.resolve(); });
      expect(urls).toHaveLength(4);
      expect(classed(renderer!.root, "group-artifact-chip")).toHaveLength(0);
    } finally { Object.defineProperty(AbortSignal, "timeout", realTimeout); }
  });
});
