import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import { agentsListHostChats, foldPcs, placeHostChats } from "./hostPlacement.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const chat = (session: string, cwd: string | null, ageMs: number, extra: Partial<HostChatRow> = {}): HostChatRow => ({
  session, title: `FICTIONAL ${session}`, status: "idle", modified_at: new Date(NOW - ageMs).toISOString(), cwd, unread: false, archived: false, ...extra,
});
const none = (): boolean => false;

describe("placeHostChats", () => {
  it("chat_goes_into_matching_workspace", () => {
    const placed = placeHostChats([chat("a", "/w/a", 1000)], [{ workspace_id: "w1", cwds: ["/w/other"] }, { workspace_id: "w2", cwds: ["/w/a/"] }], none, NOW);
    expect([...placed.tabs.keys()]).toEqual(["w2"]);
    expect(placed.tabs.get("w2")!.map((row) => row.session)).toEqual(["a"]);
    expect(placed.folders).toEqual([]);
    expect(placed.hidden).toBe(0);
  });

  it("matches the exact path only: no prefix, case kept, the first workspace wins", () => {
    const rows = [chat("a", "/w/a", 1000), chat("b", "/w/A", 2000), chat("c", "/w/ab", 3000)];
    const placed = placeHostChats(rows, [{ workspace_id: "w1", cwds: ["/w"] }, { workspace_id: "w2", cwds: ["/w/a"] }, { workspace_id: "w3", cwds: ["/w/a"] }], none, NOW);
    expect(placed.tabs.get("w2")!.map((row) => row.session)).toEqual(["a"]);
    expect(placed.tabs.has("w1")).toBe(false);
    expect(placed.tabs.has("w3")).toBe(false);
    expect(placed.folders.map((folder) => folder.cwd)).toEqual(["/w/A", "/w/ab"]);
  });

  it("no_match_makes_folder_group", () => {
    const placed = placeHostChats([chat("b1", "/w/b", 1000), chat("b2", "/w/b/", 2000), chat("x", null, 500)], [{ workspace_id: "w1", cwds: ["/w/a"] }], none, NOW);
    expect(placed.tabs.size).toBe(0);
    // one group per folder, newest chat first; a chat without a folder has nowhere to go
    expect(placed.folders).toEqual([{ cwd: "/w/b", chats: [expect.objectContaining({ session: "b1" }), expect.objectContaining({ session: "b2" })] }]);
  });

  it("ten_recent_per_pc", () => {
    const rows: HostChatRow[] = [
      ...Array.from({ length: 25 }, (_, i) => chat(`r${i}`, "/w/r", (i + 1) * 60_000)),
      ...Array.from({ length: 4 }, (_, i) => chat(`old${i}`, "/w/o", 8 * DAY + i)),
      chat("live", "/w/l", 9 * DAY, { status: "working" }),
      chat("asks", "/w/l", 10 * DAY, { status: "asks" }),
      chat("pin", "/w/p", 30 * DAY),
      chat("unread", "/w/u", 20 * DAY, { unread: true }),
    ];
    const placed = placeHostChats(rows, [], (session) => session === "pin", NOW);
    const shown = [...placed.tabs.values(), ...placed.folders.map((folder) => folder.chats)].flat().map((row) => row.session);
    expect(shown.length).toBe(10);
    // live and pinned are never cut; the room left goes to the newest
    for (const kept of ["live", "asks", "pin"]) expect(shown).toContain(kept);
    expect(shown).toContain("r0");
    expect(shown).not.toContain("r24");
    expect(shown.some((session) => session.startsWith("old"))).toBe(false);
    expect(placed.hidden).toBe(rows.length - 10);
  });

  it("live and pinned are kept even past ten", () => {
    const rows = Array.from({ length: 12 }, (_, i) => chat(`w${i}`, "/w/a", i * 1000, { status: "working" }));
    const placed = placeHostChats([...rows, chat("idle", "/w/a", 100)], [], none, NOW);
    expect(placed.folders[0]!.chats.length).toBe(12);
    expect(placed.hidden).toBe(1);
  });

  it("archived_never_placed", () => {
    const rows = [chat("gone", "/w/a", 1000, { archived: true, status: "working", unread: true }), chat("kept", "/w/a", 2000)];
    const placed = placeHostChats(rows, [{ workspace_id: "w1", cwds: ["/w/a"] }], (session) => session === "gone", NOW);
    expect(placed.tabs.get("w1")!.map((row) => row.session)).toEqual(["kept"]);
    expect(placed.hidden).toBe(1);
  });
});

describe("agentsListHostChats", () => {
  it("agents_list_keeps_unread_until_read", () => {
    const rows = [
      chat("idle", "/w", 1000), chat("working", "/w", 1000, { status: "working" }), chat("asks", "/w", 1000, { status: "asks" }),
      chat("done", "/w", 1000, { unread: true }), chat("pinned", "/w", 40 * DAY), chat("archived", "/w", 1000, { archived: true }),
    ];
    expect(agentsListHostChats(rows, (session) => session === "pinned").map((row) => row.session)).toEqual(["working", "asks", "done", "pinned"]);
    // opened: the host marks it read, and it leaves the list
    const read = rows.map((row) => row.session === "done" ? { ...row, unread: false } : row);
    expect(agentsListHostChats(read, (session) => session === "pinned").map((row) => row.session)).toEqual(["working", "asks", "pinned"]);
  });
});

describe("foldPcs", () => {
  const pc = (id: string): Machine => ({ id, name: `FICTIONAL ${id}` }) as Machine;
  it("fold_pcs", () => {
    const two = [pc("a"), pc("b")];
    expect(foldPcs(two, "b", none)).toEqual({ open: two, folded: [] });
    const six = ["a", "b", "c", "d", "e", "f"].map(pc);
    const ids = (list: Machine[]): string[] => list.map((machine) => machine.id);
    expect(ids(foldPcs(six, "c", none).open)).toEqual(["c"]);
    expect(ids(foldPcs(six, "c", none).folded)).toEqual(["a", "b", "d", "e", "f"]);
    // one that needs you stays open, in its place in the roster
    const needs = foldPcs(six, "c", (id) => id === "e");
    expect(ids(needs.open)).toEqual(["c", "e"]);
    expect(ids(needs.folded)).toEqual(["a", "b", "d", "f"]);
  });

  it("with no current PC the first one is open", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map(pc);
    expect(foldPcs(six, null, none).open.map((machine) => machine.id)).toEqual(["a"]);
    expect(foldPcs(six, "gone", none).open.map((machine) => machine.id)).toEqual(["a"]);
  });
});

describe("the chat open now", () => {
  it("an old chat opened from the sheet is placed while it is open", async () => {
    const { pcPlacement, hostChatHome } = await import("./hostPlacement.ts");
    const snapshot = { workspaces: [{ workspace_id: "w1" }], panes: [{ workspace_id: "w1", cwd: "/w/a/" }] };
    const rows = [chat("old", "/w/a", 60 * DAY), chat("far", "/w/z", 60 * DAY)];
    expect(hostChatHome(pcPlacement(snapshot, rows, none, null, NOW), "old")).toBeNull();
    expect(hostChatHome(pcPlacement(snapshot, rows, none, "old", NOW), "old")).toEqual({ workspace: "w1" });
    expect(hostChatHome(pcPlacement(snapshot, rows, none, "far", NOW), "far")).toEqual({ folder: "/w/z" });
  });
});
