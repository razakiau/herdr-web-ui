import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { HostPc } from "./hostChats.ts";
import { upkeepPc, shouldSeed, currentHostWorkspaces, setHostWorkspaces, subscribeHostWorkspaces, closeTab, closeWorkspace, isOpenFolder, openTab, openWorkspace, prunePc, sanitizeHostWorkspaces, seedPc, tabsOf, type PcHostWorkspaces } from "./hostWorkspaces.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const MIN = 60_000;
const row = (session: string, cwd: string | null, extra: Partial<HostChatRow> & { age?: number } = {}): HostChatRow => {
  const { age = 60 * MIN, ...rest } = extra;
  return { session, title: `FICTIONAL ${session}`, status: "idle", modified_at: new Date(NOW - age).toISOString(), cwd, unread: false, archived: false, ...rest };
};
const EMPTY: PcHostWorkspaces = { open: [] };

describe("agent host workspaces", () => {
  it("seed_opens_pinned_live_and_on_screen", () => {
    const chats = [row("a-old", "/a", { age: 30 * 24 * 60 * MIN }), row("b-asks", "/b", { status: "asks" }), row("c-shown", "/c"), row("d-idle", "/d")];
    const seeded = seedPc(chats, new Set(["/d"]), "c-shown");
    expect(seeded.open.map((each) => each.cwd).sort()).toEqual(["/b", "/c", "/d"]);
    expect(tabsOf(seeded, "/b")).toEqual(["b-asks"]);
    expect(tabsOf(seeded, "/c")).toContain("c-shown");
  });

  it("open_seeds_live_unread_and_newest", () => {
    const chats = [
      row("o", "/a", { age: 90 * MIN }), row("n", "/a", { age: 1 * MIN }), row("u", "/a", { age: 50 * MIN, unread: true }), row("w", "/a", { age: 70 * MIN, status: "working" }),
      row("elsewhere", "/b", { status: "working" }),
    ];
    expect(openWorkspace(EMPTY, "/a", chats).open[0]!.tabs).toEqual(["w", "u", "n"]);
  });

  it("close_keeps_nothing", () => {
    const opened = openWorkspace(EMPTY, "/a", [row("x", "/a")]);
    expect(closeWorkspace(opened, "/a").open).toEqual([]);
  });

  it("close_last_tab_closes_workspace", () => {
    expect(closeTab({ open: [{ cwd: "/a", tabs: ["x"] }] }, "x").open).toEqual([]);
    expect(closeTab({ open: [{ cwd: "/a", tabs: ["x", "y"] }] }, "x").open).toEqual([{ cwd: "/a", tabs: ["y"] }]);
  });

  it("open_tab_opens_its_workspace", () => {
    const once = openTab(EMPTY, row("x", "/a"));
    expect(once.open).toEqual([{ cwd: "/a", tabs: ["x"] }]);
    expect(openTab(once, row("x", "/a"))).toEqual(once);
    expect(openTab(once, row("y", "/a")).open).toEqual([{ cwd: "/a", tabs: ["x", "y"] }]);
  });

  it("one_folder_whatever_its_slash", () => {
    const pc = openTab(EMPTY, row("x", "/a/"));
    expect(isOpenFolder(pc, "/a")).toBe(true);
    expect(openWorkspace(pc, "/a", [row("x", "/a/")]).open).toHaveLength(1);
    expect(openTab(pc, row("y", "/a")).open).toEqual([{ cwd: "/a", tabs: ["x", "y"] }]);
  });

  it("prunes_gone_chats", () => {
    const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y"] }] };
    expect(prunePc(pc, [row("y", "/a")]).open).toEqual([{ cwd: "/a", tabs: ["y"] }]);
    expect(prunePc(pc, []).open).toEqual([]);
    expect(prunePc(pc, [row("x", "/a"), row("y", "/a", { archived: true })]).open).toEqual([{ cwd: "/a", tabs: ["x"] }]);
    // nothing changed: the same object, so a caller writes nothing
    const kept = { open: [{ cwd: "/a", tabs: ["x"] }] };
    expect(prunePc(kept, [row("x", "/a")])).toBe(kept);
  });

  it("sanitize_rejects_bad_shapes", () => {
    expect(sanitizeHostWorkspaces("x")).toBeNull();
    expect(sanitizeHostWorkspaces({ m: { open: [{ cwd: 1 }] } })).toBeNull();
    expect(sanitizeHostWorkspaces({ m: { open: Array.from({ length: 201 }, (_, i) => ({ cwd: `/f${i}`, tabs: [] })) } })).toBeNull();
    const good = { m: { open: [{ cwd: "/a", tabs: ["x"] }], order: ["w:1", "f:/a"] } };
    expect(sanitizeHostWorkspaces(good)).toEqual(good);
  });

  it("store_saves_tells_and_reads_back", () => {
    const stored = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } } });
    try {
      let heard = 0;
      const stop = subscribeHostWorkspaces(() => { heard += 1; });
      const state = { m: { open: [{ cwd: "/a", tabs: ["x"] }] } };
      setHostWorkspaces(state);
      setHostWorkspaces(structuredClone(state));
      stop();
      expect(heard).toBe(1);
      expect(currentHostWorkspaces()).toEqual(state);
      expect(JSON.parse(stored.get("herdr-web-ui:host-workspaces")!)).toEqual(state);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("seeds_only_after_a_list", () => {
    const read = { host: { state: "connected" } as HostPc["host"], chats: [] };
    expect(shouldSeed({}, "m", undefined)).toBe(false);
    // a host that is not up lists nothing: seeding then would save an empty PC for good
    expect(shouldSeed({}, "m", { host: null, chats: [] })).toBe(false);
    expect(shouldSeed({}, "m", read)).toBe(true);
    expect(shouldSeed({ m: { open: [] } }, "m", read)).toBe(false);
    // a list kept from before the bridge answered again is not a read
    expect(shouldSeed({}, "m", { ...read, stale: true })).toBe(false);
  });

  it("upkeep_seeds_then_prunes_only_from_a_live_list", () => {
    const live = (chats: HostChatRow[]): HostPc => ({ host: { state: "connected" } as HostPc["host"], chats });
    const chats = [row("w", "/a", { status: "working" }), row("i", "/b")];
    const seeded = upkeepPc({}, "m", live(chats), new Set(), null);
    expect(seeded.m!.open).toEqual([{ cwd: "/a", tabs: ["w"] }]);
    // nothing changed: the same object, so nothing is written
    expect(upkeepPc(seeded, "m", live(chats), new Set(), null)).toBe(seeded);
    // a failed list or a host that is down prunes nothing
    expect(upkeepPc(seeded, "m", { ...live([]), stale: true }, new Set(), null)).toBe(seeded);
    expect(upkeepPc(seeded, "m", { host: null, chats: [] }, new Set(), null)).toBe(seeded);
    // a live list without the chat drops its tab, and the workspace with its last
    expect(upkeepPc(seeded, "m", live([row("i", "/b")]), new Set(), null)).toEqual({ m: { open: [] } });
  });
});
