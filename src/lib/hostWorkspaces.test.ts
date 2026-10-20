import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { closeTab, closeWorkspace, isOpenFolder, openTab, openWorkspace, prunePc, sanitizeHostWorkspaces, seedPc, tabsOf, type PcHostWorkspaces } from "./hostWorkspaces.ts";

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
});
