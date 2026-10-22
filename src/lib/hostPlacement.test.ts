import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { Machine } from "../../shared/machines.ts";
import { agentsListHostChats, foldPcs, placeHostChats } from "./hostPlacement.ts";
import type { PcHostWorkspaces } from "../../shared/host-workspaces.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const chat = (session: string, cwd: string | null, ageMs: number, extra: Partial<HostChatRow> = {}): HostChatRow => ({
  session, title: `FICTIONAL ${session}`, status: "idle", modified_at: new Date(NOW - ageMs).toISOString(), cwd, unread: false, archived: false, ...extra,
});
const none = (): boolean => false;

describe("placeHostChats", () => {
  const openAt = (...folders: [string, string[]][]): PcHostWorkspaces => ({ open: folders.map(([cwd, tabs]) => ({ cwd, tabs })) });

  it("chat_goes_into_matching_workspace", () => {
    const placed = placeHostChats([chat("a", "/w/a", 1000)], [{ workspace_id: "w1", cwds: ["/w/other"] }, { workspace_id: "w2", cwds: ["/w/a/"] }], openAt(["/w/a", ["a"]]), null);
    expect([...placed.tabs.keys()]).toEqual(["w2"]);
    expect(placed.tabs.get("w2")!.map((row) => row.session)).toEqual(["a"]);
    expect(placed.folders).toEqual([]);
    expect(placed.hidden).toBe(0);
  });

  it("matches the exact path only: no prefix, case kept, the first workspace wins", () => {
    const rows = [chat("a", "/w/a", 1000), chat("b", "/w/A", 2000), chat("c", "/w/ab", 3000)];
    const placed = placeHostChats(rows, [{ workspace_id: "w1", cwds: ["/w"] }, { workspace_id: "w2", cwds: ["/w/a"] }, { workspace_id: "w3", cwds: ["/w/a"] }], openAt(["/w/a", ["a"]], ["/w/A", ["b"]], ["/w/ab", ["c"]]), null);
    expect(placed.tabs.get("w2")!.map((row) => row.session)).toEqual(["a"]);
    expect(placed.tabs.has("w1")).toBe(false);
    expect(placed.tabs.has("w3")).toBe(false);
    expect(placed.folders.map((folder) => folder.cwd)).toEqual(["/w/A", "/w/ab"]);
  });

  it("places_only_open_tabs", () => {
    const rows = [chat("x", "/a", 3000), chat("y", "/a/", 1000), chat("z", "/a", 2000)];
    const placed = placeHostChats(rows, [], openAt(["/a", ["x"]]), null);
    expect(placed.folders).toEqual([{ cwd: "/a", chats: [rows[0]!], look: false }]);
    expect(placed.hidden).toBe(2);
  });

  it("keeps the tabs in their strip order and the workspaces in the order opened", () => {
    const rows = [chat("x", "/a", 3000), chat("y", "/a", 1000), chat("q", "/b", 500)];
    const placed = placeHostChats(rows, [], openAt(["/b", ["q"]], ["/a", ["y", "x"]]), null);
    expect(placed.folders.map((folder) => [folder.cwd, folder.chats.map((row) => row.session)])).toEqual([["/b", ["q"]], ["/a", ["y", "x"]]]);
  });

  it("closed_folder_has_no_row", () => {
    const placed = placeHostChats([chat("b1", "/b", 1000, { status: "working" }), chat("a", "/a", 1000)], [], openAt(["/a", ["a"]]), null);
    expect(placed.folders.map((folder) => folder.cwd)).toEqual(["/a"]);
  });

  it("herdr_workspace_takes_the_folders_tabs", () => {
    const placed = placeHostChats([chat("x", "/a", 1000), chat("y", "/a", 2000)], [{ workspace_id: "w", cwds: ["/a"] }], openAt(["/a", ["x"]]), null);
    expect(placed.tabs.get("w")!.map((row) => row.session)).toEqual(["x"]);
    expect(placed.folders).toEqual([]);
  });

  it("closed_folder_under_a_herdr_workspace_adds_nothing", () => {
    const placed = placeHostChats([chat("x", "/a", 1000)], [{ workspace_id: "w", cwds: ["/a"] }], openAt(), null);
    expect(placed.tabs.get("w")).toBeUndefined();
  });

  it("a_look_shows_its_folder", () => {
    const rows = [chat("x", "/a", 1000), chat("y", "/b", 2000), chat("v", "/a", 3000)];
    const closed = placeHostChats(rows, [], openAt(["/a", ["x"]]), "y");
    expect(closed.folders).toEqual([{ cwd: "/a", chats: [rows[0]!], look: false }, { cwd: "/b", chats: [rows[1]!], look: true }]);
    const inOpen = placeHostChats(rows, [], openAt(["/a", ["x"]]), "v");
    expect(inOpen.folders).toEqual([{ cwd: "/a", chats: [rows[0]!, rows[2]!], look: false }]);
    // under a herdr workspace the look joins its strip
    expect(placeHostChats(rows, [{ workspace_id: "w", cwds: ["/b"] }], openAt(), "y").tabs.get("w")!.map((row) => row.session)).toEqual(["y"]);
  });

  it("archived_never_placed", () => {
    const rows = [chat("gone", "/w/a", 1000, { archived: true, status: "working", unread: true }), chat("kept", "/w/a", 2000)];
    const placed = placeHostChats(rows, [{ workspace_id: "w1", cwds: ["/w/a"] }], openAt(["/w/a", ["gone", "kept"]]), "gone");
    expect(placed.tabs.get("w1")!.map((row) => row.session)).toEqual(["kept"]);
    expect(placed.hidden).toBe(1);
  });

  it("a tab whose chat has no row yet is skipped, and nothing open places nothing", () => {
    expect(placeHostChats([chat("x", "/a", 1000)], [], openAt(["/a", ["missing", "x"]]), null).folders[0]!.chats.map((row) => row.session)).toEqual(["x"]);
    expect(placeHostChats([chat("x", "/a", 1000)], [], undefined, null).folders).toEqual([]);
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
  it("a chat opened from the sheet is placed while it is on screen", async () => {
    const { pcPlacement, hostChatHome } = await import("./hostPlacement.ts");
    const snapshot = { workspaces: [{ workspace_id: "w1" }], panes: [{ workspace_id: "w1", cwd: "/w/a/" }] };
    const rows = [chat("old", "/w/a", 60 * DAY), chat("far", "/w/z", 60 * DAY)];
    expect(hostChatHome(pcPlacement(snapshot, rows, { open: [] }, null), "old")).toBeNull();
    expect(hostChatHome(pcPlacement(snapshot, rows, { open: [] }, "old"), "old")).toEqual({ workspace: "w1" });
    expect(hostChatHome(pcPlacement(snapshot, rows, { open: [] }, "far"), "far")).toEqual({ folder: "/w/z" });
  });
});
