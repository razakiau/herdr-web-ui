import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ChatGroup, GroupsAnswer } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HostPc } from "../lib/hostChats.ts";
import { groupsView } from "../lib/groups.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { GroupsLens } from "./GroupsLens.tsx";
import { shownLens, sidebarLenses, sidebarSearchView } from "./MachineSidebar.tsx";

const row = (session: string, title: string): HostChatRow =>
  ({ session, title, status: "idle", modified_at: new Date().toISOString(), cwd: "/w/fictional", unread: false, archived: false });
const group = (id: number, name: string, sessions: string[]): ChatGroup => ({
  id, name, createdAt: "2026-10-29T09:00:00Z", updatedAt: "2026-10-31T09:00:00Z",
  members: sessions.map((session) => ({ pc: "local", session, joined: "link", addedAt: "2026-10-30T09:00:00Z" })),
});
const ANSWER: GroupsAnswer = {
  groups: [group(7, "FICTIONAL keep-warm", ["s-a", "s-b"]), group(9, "FICTIONAL mounts", ["s-c"])],
  links: [{ pc: "local", from: "s-a", to: "s-b", kind: "resume", at: "2026-10-30T09:00:00Z" }],
  summaries: [], digests: [], digestDefaults: { model: "m", effort: "low" },
};
const MACHINES = [{ id: "local", name: "Mac", kind: "local", enabled: true, state: "connected", error: null, snapshot: null } as unknown as Machine];
const HOST_CHATS: ReadonlyMap<string, HostPc> = new Map([["local", { host: null, chats: [row("s-a", "A"), row("s-b", "B"), row("s-c", "C")] }]]);

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  } });
  globalThis.fetch = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
  groupsView.closeAll();
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  globalThis.fetch = realFetch;
  groupsView.closeAll();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

async function lens(answer: GroupsAnswer | null, over: Partial<Parameters<typeof GroupsLens>[0]> = {}): Promise<ReactTestRenderer> {
  const view = createElement(GroupsLens, { answer, failed: false, machines: MACHINES, hostChats: HOST_CHATS, ...over });
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: view })); });
  return renderer!;
}

describe("the sidebar's Groups lens", () => {
  it("is a tab only while Settings → Chat groups is on, counting the groups", () => {
    expect(sidebarLenses({ chatGroups: false, agents: 16, groups: 2, pcs: 1 }).map((each) => each.id)).toEqual(["agents", "pcs"]);
    expect(sidebarLenses({ chatGroups: true, agents: 16, groups: 2, pcs: 1 })).toEqual([
      { id: "agents", count: 16 }, { id: "groups", count: 2 }, { id: "pcs", count: 1 }]);
    // not answered yet: no number rather than a wrong 0
    expect(sidebarLenses({ chatGroups: true, agents: 16, groups: null, pcs: 1 })[1]).toEqual({ id: "groups", count: null });
  });

  it("the sidebar search: in Groups it searches the groups; in Agents, agents plus a Groups section; the field says what it finds", () => {
    expect(sidebarSearchView("groups", true, true, "zac")).toEqual({ agents: false, pcs: false, groups: true, groupHits: false, placeholder: "Groups and their chats" });
    expect(sidebarSearchView("agents", true, true, "zac")).toEqual({ agents: true, pcs: true, groups: false, groupHits: true, placeholder: "Agents and groups" });
    // nothing typed yet: no Groups section
    expect(sidebarSearchView("agents", true, true, " ").groupHits).toBe(false);
    // chat groups off: as before
    expect(sidebarSearchView("agents", false, true, "zac")).toEqual({ agents: true, pcs: true, groups: false, groupHits: false, placeholder: "Workspaces and agents" });
    // no search: the lens alone
    expect(sidebarSearchView("groups", true, false, "")).toMatchObject({ agents: false, pcs: false, groups: true });
  });

  it("reads a kept Groups pick as Agents once chat groups are off", () => {
    expect(shownLens("groups", false)).toBe("agents");
    expect(shownLens("groups", true)).toBe("groups");
    expect(shownLens("pcs", false)).toBe("pcs");
  });

  it("draws each group as the Groups sheet's card, and a tap opens that group's page", async () => {
    const page = await lens(ANSWER);
    const cards = page.root.findAll((each) => each.type === "button" && each.props["className"] === "groups-card");
    expect(cards).toHaveLength(2);
    const mounts = cards.find((each) => textOf(each).includes("FICTIONAL mounts"))!;
    await act(async () => { mounts.props["onClick"](); });
    expect(groupsView.read().group).toBe(9);
  });

  it("shows the groups on the PC the search row picked, and none of its own select", async () => {
    const desk = { ...group(11, "FICTIONAL desk work", []), members: [{ pc: "desk", session: "d-1", joined: "link" as const, addedAt: "2026-10-30T09:00:00Z" }] };
    const answer = { ...ANSWER, groups: [...ANSWER.groups, desk] };
    const cards = (page: ReactTestRenderer) => page.root.findAll((each) => each.type === "button" && each.props["className"] === "groups-card").map(textOf);
    const all = await lens(answer);
    expect(all.root.findAll((each) => each.type === "select")).toHaveLength(0);
    expect(cards(all)).toHaveLength(3);
    await act(async () => { renderer?.unmount(); });
    const page = await lens(answer, { pc: "desk" });
    expect(cards(page)).toHaveLength(1);
    expect(cards(page)[0]).toContain("FICTIONAL desk work");
  });

  it("a search finds groups by name and by their chats' titles, every word; none says so", async () => {
    const cards = (page: ReactTestRenderer) => page.root.findAll((each) => each.type === "button" && each.props["className"] === "groups-card").map(textOf);
    expect(cards(await lens(ANSWER, { query: "mounts" }))).toHaveLength(1);
    await act(async () => { renderer?.unmount(); });
    // "C" is s-c's title, in FICTIONAL mounts; "keep-warm b": the name and chat B
    expect(cards(await lens(ANSWER, { query: "keep-warm b" }))[0]).toContain("FICTIONAL keep-warm");
    await act(async () => { renderer?.unmount(); });
    expect(textOf((await lens(ANSWER, { query: "nothing here" })).root)).toContain("No group has “nothing here” in its name or its chats.");
  });

  it("a short section: at most `limit` cards, then a way to all of them", async () => {
    let more = 0;
    const page = await lens(ANSWER, { query: "fictional", limit: 1, onMore: () => { more++; } });
    expect(page.root.findAll((each) => each.type === "button" && each.props["className"] === "groups-card")).toHaveLength(1);
    const all = page.root.find((each) => each.type === "button" && typeof each.props["className"] === "string" && each.props["className"].includes("groups-lens-more"));
    expect(textOf(all)).toBe("Show all 2 in Groups");
    await act(async () => { all.props["onClick"](); });
    expect(more).toBe(1);
  });

  it("says there are no groups yet with the sheet's words", async () => {
    const page = await lens({ ...ANSWER, groups: [] });
    expect(textOf(page.root)).toContain("No groups yet.");
  });
});
