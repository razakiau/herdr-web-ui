import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import type { HostPc } from "./hostChats.ts";
import { fitHostWorkspaces, folderFace, folderTree, HOST_WORKSPACES_BUDGET, folderKey, moveBlock, type MergedRow, mergedKeys, mergedOrder, moveInMerged, withOrder, workspaceKey, hostFolders, isTabOpen, firstHostTab, tabAfterClose, upkeepPc, shouldSeed, currentHostWorkspaces, setHostWorkspaces, subscribeHostWorkspaces, closeTab, closeWorkspace, isOpenFolder, openTab, openWorkspace, prunePc, sanitizeHostWorkspaces, seedPc, tabsOf, type PcHostWorkspaces } from "./hostWorkspaces.ts";

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

  it("seed_follows_the_auto_open_setting", () => {
    const chats = [row("b-asks", "/b", { status: "asks" }), row("c-shown", "/c"), row("d-idle", "/d")];
    expect(seedPc(chats, new Set(["/d"]), "c-shown", "pinned").open.map((each) => each.cwd).sort()).toEqual(["/c", "/d"]);
    expect(seedPc(chats, new Set(["/d"]), "c-shown", "none").open.map((each) => each.cwd)).toEqual(["/c"]);
    expect(seedPc(chats, new Set(["/d"]), null, "none").open).toEqual([]);
    expect(upkeepPc({}, "m", { host: { state: "connected" }, chats } as unknown as HostPc, new Set(["/d"]), null, "pinned")).toEqual({ m: seedPc(chats, new Set(["/d"]), null, "pinned") });
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
      expect(JSON.parse(stored.get("ovis:host-workspaces")!)).toEqual(state);
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
    // the chat on screen keeps its tab: a new chat is not listed until its first message
    const fresh = { m: { open: [{ cwd: "/a", tabs: ["new"] }] } };
    expect(upkeepPc(fresh, "m", live([]), new Set(), "new")).toBe(fresh);
  });

  it("a_look_is_not_a_tab", () => {
    const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y", "z"] }] };
    expect(isTabOpen(pc, "y")).toBe(true);
    expect(isTabOpen(pc, "q")).toBe(false);
    expect(isTabOpen(undefined, "y")).toBe(false);
  });

  it("a PC with no panes opens its first agent host workspace's first tab, in sidebar order", () => {
    const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y"] }, { cwd: "/b", tabs: ["q"] }], order: ["f:/b", "f:/a"] };
    expect(firstHostTab(pc)).toBe("q");
    expect(firstHostTab({ open: [{ cwd: "/a", tabs: ["x"] }, { cwd: "/b", tabs: ["q"] }] })).toBe("x");
    // a workspace with no tabs is passed over; none at all opens nothing
    expect(firstHostTab({ open: [{ cwd: "/a", tabs: [] }, { cwd: "/b", tabs: ["q"] }] })).toBe("q");
    expect(firstHostTab({ open: [] })).toBeNull();
    expect(firstHostTab(undefined)).toBeNull();
  });

  it("closing_the_tab_on_screen_moves_to_its_neighbour", () => {
    const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y", "z"] }, { cwd: "/b", tabs: ["q"] }] };
    expect(tabAfterClose(pc, "y")).toBe("z");
    expect(tabAfterClose(pc, "z")).toBe("y");
    // the workspace's last tab: nothing of its own is left
    expect(tabAfterClose(pc, "q")).toBeNull();
    expect(tabAfterClose(pc, "gone")).toBeNull();
  });

  it("folders_to_open_list_each_with_its_chats", () => {
    const chats = [
      row("a1", "/a", { age: 5 * MIN }), row("a2", "/a/", { age: 60 * MIN }), row("b1", "/b", { age: 1 * MIN }),
      row("gone", "/c", { archived: true }), row("none", null),
    ];
    expect(hostFolders(chats, { open: [{ cwd: "/a", tabs: ["a1"] }] })).toEqual([
      { cwd: "/b", chats: 1, modified_at: chats[2]!.modified_at, open: false },
      { cwd: "/a", chats: 2, modified_at: chats[0]!.modified_at, open: true },
    ]);
  });

  it("hostFolders_never_offers_the_no_folder_row_to_start_a_chat_in", () => {
    // a new chat started there would run in ~/.copilot/chats itself, not in a folder of its own
    const chats = [row("lost", "/home/fictional/.copilot/chats", { no_folder: true }), row("b1", "/b")];
    expect(hostFolders(chats, undefined).map((each) => each.cwd)).toEqual(["/b"]);
  });

  it("folderFace_names_the_no_folder_row_and_says_the_newest_chats_branch", () => {
    expect(folderFace([row("lost", "/h/.copilot/chats", { no_folder: true })])).toEqual({ noFolder: true, branch: null, detached: false });
    // the newest chat's branch: the folder's checkout as VS Code saw it last
    expect(folderFace([row("old", "/a", { branch: "old/branch", age: 90 * MIN }), row("new", "/a", { branch: "main", age: 5 * MIN })])).toEqual({ noFolder: false, branch: "main", detached: false });
    // a detached HEAD is said as herdr's rows say it (Detached HEAD), not left blank
    expect(folderFace([row("new", "/a", { detached: true, age: 5 * MIN }), row("old", "/a", { branch: "main", age: 90 * MIN })])).toEqual({ noFolder: false, branch: null, detached: true });
    expect(folderFace([])).toEqual({ noFolder: false, branch: null, detached: false });
  });

  describe("merged order", () => {
    const names = (rows: ReturnType<typeof mergedOrder>): string[] => rows.map((each) => each.kind === "workspace" ? each.id : each.cwd);

    it("merged_keeps_herdr_relative_order", () => {
      const saved = [workspaceKey("w1"), folderKey("/a"), workspaceKey("w2")];
      expect(names(mergedOrder(["w1", "w2", "w3"], ["/a"], saved))).toEqual(["w1", "/a", "w2", "w3"]);
      // herdr moved w2 up: herdr's rows follow herdr, and /a stays right after w1
      expect(names(mergedOrder(["w2", "w1", "w3"], ["/a"], saved))).toEqual(["w2", "w1", "/a", "w3"]);
    });

    it("folder_saved_first_stays_first", () => {
      expect(names(mergedOrder(["w1", "w2"], ["/a", "/b"], [folderKey("/b"), folderKey("/a"), workspaceKey("w1")]))).toEqual(["/b", "/a", "w1", "w2"]);
    });

    it("drops_missing_ids", () => {
      const saved = [workspaceKey("gone"), folderKey("/a"), folderKey("/closed"), workspaceKey("w1")];
      expect(names(mergedOrder(["w1"], ["/a"], saved))).toEqual(["/a", "w1"]);
      // a folder whose saved neighbour left lands after the row before that one
      expect(names(mergedOrder(["w1", "w2"], ["/a"], [workspaceKey("w1"), workspaceKey("gone"), folderKey("/a"), workspaceKey("w2")]))).toEqual(["w1", "/a", "w2"]);
    });

    it("new_host_rows_go_last", () => {
      expect(names(mergedOrder(["w1", "w2"], ["/new", "/a"], [folderKey("/a"), workspaceKey("w1")]))).toEqual(["/a", "w1", "w2", "/new"]);
      expect(names(mergedOrder(["w1"], ["/a/"], undefined))).toEqual(["w1", "/a"]);
    });

    it("move_in_merged_places_the_row", () => {
      const keys = mergedKeys(mergedOrder(["w1", "w2"], ["/a"], undefined));
      expect(moveInMerged(keys, folderKey("/a"), workspaceKey("w1"), "before")).toEqual([folderKey("/a"), workspaceKey("w1"), workspaceKey("w2")]);
      expect(moveInMerged(keys, workspaceKey("w1"), folderKey("/a"), "after")).toEqual([workspaceKey("w2"), folderKey("/a"), workspaceKey("w1")]);
      expect(moveInMerged(keys, folderKey("/a"), folderKey("/a"), "before")).toBe(keys);
    });

    it("with_order_keeps_the_open_workspaces", () => {
      const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x"] }] };
      const next = withOrder({ m: pc }, "m", [folderKey("/a")]);
      expect(next.m).toEqual({ open: [{ cwd: "/a", tabs: ["x"] }], order: ["f:/a"] });
      const none = {};
      expect(withOrder(none, "m", ["w:w1"])).toBe(none);
      expect(withOrder(next, "m", ["f:/a"])).toBe(next);
    });
  });

  it("fit_keeps_a_state_the_server_takes", () => {
    const tabs = Array.from({ length: 51 }, (_, i) => `s${i}`);
    const open = Array.from({ length: 201 }, (_, i) => ({ cwd: `/f${i}`, tabs: ["x"] }));
    const order = Array.from({ length: 501 }, (_, i) => `w:${i}`);
    const fitted = fitHostWorkspaces({ m: { open: [{ cwd: "/a", tabs }], order }, n: { open } });
    // the newest tabs, the last opened workspaces and the order's head stay
    expect(fitted.m!.open[0]!.tabs).toEqual(tabs.slice(1));
    expect(fitted.m!.order).toEqual(order.slice(0, 500));
    expect(fitted.n!.open.map((each) => each.cwd)).toEqual(open.slice(1).map((each) => each.cwd));
    expect(sanitizeHostWorkspaces(fitted)).toEqual(fitted);
    const fine = { m: { open: [{ cwd: "/a", tabs: ["x"] }] } };
    expect(fitHostWorkspaces(fine)).toBe(fine);
  });

  it("fit_stays_inside_its_share_of_the_preferences", () => {
    const long = (i: number, j: number) => `vscode-chat-session://local/${"x".repeat(200)}-${i}-${j}`;
    const open = Array.from({ length: 40 }, (_, i) => ({ cwd: `/dossier-é/${i}`, tabs: Array.from({ length: 10 }, (_, j) => long(i, j)) }));
    const fitted = fitHostWorkspaces({ m: { open } });
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(HOST_WORKSPACES_BUDGET);
    // the oldest opened go first: the newest workspace stays whole
    expect(fitted.m!.open.at(-1)).toEqual(open.at(-1));
  });

  it("the_store_writes_only_what_fits", () => {
    const stored = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } } });
    try {
      setHostWorkspaces({ m: { open: [{ cwd: "/a", tabs: Array.from({ length: 60 }, (_, i) => `s${i}`) }] } });
      expect(currentHostWorkspaces().m!.open[0]!.tabs.length).toBe(50);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("agent host worktree folders (herdr's tree)", () => {
  const repoOf = (cwd: string): string | undefined => ({ "/r.wt/a": "/r", "/r.wt/b": "/r", "/s.wt/x": "/s" } as Record<string, string>)[cwd];
  it("a worktree folder sits under its repo's folder row, in the list's order", () => {
    const rows: MergedRow[] = [{ kind: "folder", cwd: "/r.wt/b" }, { kind: "workspace", id: "w1" }, { kind: "folder", cwd: "/r" }, { kind: "folder", cwd: "/r.wt/a" }];
    expect(folderTree(rows, repoOf)).toEqual([
      { kind: "workspace", id: "w1" },
      { kind: "folder", cwd: "/r", worktrees: ["/r.wt/b", "/r.wt/a"] },
    ]);
  });
  it("a repo with no row of its own gets a header row, where its first worktree stood", () => {
    const rows: MergedRow[] = [{ kind: "workspace", id: "w1" }, { kind: "folder", cwd: "/s.wt/x" }, { kind: "folder", cwd: "/plain" }];
    expect(folderTree(rows, repoOf)).toEqual([
      { kind: "workspace", id: "w1" },
      { kind: "repo", cwd: "/s", worktrees: ["/s.wt/x"] },
      { kind: "folder", cwd: "/plain", worktrees: [] },
    ]);
  });
  it("moving a row moves its worktrees with it; a header row's key moves its worktrees", () => {
    const keys = ["f:/r", "f:/r.wt/a", "w:w1", "f:/p"];
    expect(moveBlock(keys, ["f:/r", "f:/r.wt/a"], "w:w1", "after")).toEqual(["w:w1", "f:/r", "f:/r.wt/a", "f:/p"]);
    expect(moveBlock(keys, ["f:/p"], "f:/r", "before")).toEqual(["f:/p", "f:/r", "f:/r.wt/a", "w:w1"]);
    // dropped after a row whose worktrees follow it: after the worktrees
    expect(moveBlock(["w:w1", "f:/r", "f:/r.wt/a", "f:/p"], ["w:w1"], "f:/r", "after", ["f:/r", "f:/r.wt/a"])).toEqual(["f:/r", "f:/r.wt/a", "w:w1", "f:/p"]);
    expect(moveBlock(keys, ["f:/r", "f:/r.wt/a"], "f:/r", "after")).toBe(keys);
  });
});

describe("moving a host chat tab", () => {
  it("a tab dragged to another place in its strip keeps that place", async () => {
    const { moveTab } = await import("./hostWorkspaces.ts");
    const pc: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y", "z"] }] };
    expect(moveTab(pc, ["x", "y", "z"], "z", 0).open[0]!.tabs).toEqual(["z", "x", "y"]);
    expect(moveTab(pc, ["x", "y", "z"], "x", 3).open[0]!.tabs).toEqual(["y", "z", "x"]);
    expect(moveTab(pc, ["x", "y", "z"], "y", 1)).toBe(pc);
    // a strip drawing two folders' tabs: each folder takes the new order of its own
    const two: PcHostWorkspaces = { open: [{ cwd: "/a", tabs: ["x", "y"] }, { cwd: "/b", tabs: ["p", "q"] }] };
    expect(moveTab(two, ["x", "y", "p", "q"], "y", 0).open).toEqual([{ cwd: "/a", tabs: ["y", "x"] }, { cwd: "/b", tabs: ["p", "q"] }]);
  });
});
