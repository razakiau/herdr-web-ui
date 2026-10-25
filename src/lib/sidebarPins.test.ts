import { describe, expect, it } from "bun:test";
import { pinnedRowKeys, reorderPinnedRows, isHostChatPinKey, isWorkspacePinKey, loadSidebarPins, migratePins, pinnedGroupIds, pinnedWorkspaceIds, pruneSidebarPins, pruneWorkspacePins, reorderWorkspacePins, sidebarPinKey, splitPinnedGroups, splitPinnedRows, toggleSidebarPin, hostChatPinKey, hostFolderPinKey, isHostFolderPinKey, pinnedHostFolders, pruneHostFolderPins, toggleHostFolderPin, workspacePinKey } from "./sidebarPins.ts";

describe("sidebar agent pins", () => {
  it("moves workspace pins in both directions without moving other pin slots", () => {
    const pins = ["pc:workspace:a", "pc:p1", "other:workspace:a", "pc:workspace:b", "pc:workspace:c"];
    expect(reorderWorkspacePins(pins, "pc", "a", "c")).toEqual(["pc:workspace:b", "pc:p1", "other:workspace:a", "pc:workspace:c", "pc:workspace:a"]);
    expect(reorderWorkspacePins(pins, "pc", "c", "a")).toEqual(["pc:workspace:c", "pc:p1", "other:workspace:a", "pc:workspace:a", "pc:workspace:b"]);
    expect(pins[0]).toBe("pc:workspace:a");
  });

  it("leaves pins alone for self drops and either unpinned endpoint", () => {
    const pins = ["pc:workspace:a", "pc:workspace:b"];
    for (const [source, target] of [["a", "a"], ["missing", "b"], ["a", "missing"]]) {
      expect(reorderWorkspacePins(pins, "pc", source!, target!)).toEqual(pins);
    }
  });

  it("keys a pin by PC and pane", () => {
    expect(sidebarPinKey("pc-a", "pane-1")).toBe("pc-a:pane-1");
    expect(sidebarPinKey("pc-b", "pane-1")).not.toBe(sidebarPinKey("pc-a", "pane-1"));
  });

  it("toggles pins without changing the saved order of other pins", () => {
    expect(toggleSidebarPin(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSidebarPin(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("prunes only panes absent from the live roster", () => {
    expect(pruneSidebarPins(["pc-a:p1", "pc-b:p1"], new Set(["pc-b:p1"]), [{ id: "pc-a", snapshot: {} }, { id: "pc-b", snapshot: {} }])).toEqual(["pc-b:p1"]);
  });

  it("keeps saved pins until each machine's agent roster has loaded", () => {
    const pins = ["local:p1", "remote:p2"];
    const live = new Set(["local:p1"]);
    expect(pruneSidebarPins(pins, new Set(), [])).toEqual(pins);
    expect(pruneSidebarPins(pins, new Set(), [{ id: "local", snapshot: null }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: {} }])).toEqual(["local:p1"]);
  });

  it("matches the complete machine key instead of a shared prefix", () => {
    expect(pruneSidebarPins(["pc:p1", "pc-extra:p2"], new Set(), [{ id: "pc", snapshot: null }])).toEqual(["pc:p1"]);
  });

  it("keys a host chat by PC and session, apart from every pane and workspace", () => {
    expect(hostChatPinKey("m", "copilotcli:/x")).toBe("m:host:copilotcli:/x");
    expect(isHostChatPinKey(hostChatPinKey("m", "copilotcli:/x"))).toBe(true);
    expect(isHostChatPinKey(sidebarPinKey("m", "w1:p1"))).toBe(false);
    expect(isHostChatPinKey(workspacePinKey("m", "w1"))).toBe(false);
    expect(isWorkspacePinKey(hostChatPinKey("m", "s"))).toBe(false);
  });

  it("pruning agent pins keeps host chat pins", () => {
    expect(pruneSidebarPins(["m:host:copilotcli:/x", "m:gone-pane"], new Set(), [{ id: "m", snapshot: {} }])).toEqual(["m:host:copilotcli:/x"]);
  });

  it("places pinned rows first and keeps source order for the rest", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const order = (keys: string[]) => {
      const { pinned, rest } = splitPinnedRows(rows, keys, (row) => row.id);
      return [...pinned, ...rest].map((row) => row.id);
    };
    expect(order(["c", "a"])).toEqual(["c", "a", "b"]);
    expect(order(["missing", "b"])).toEqual(["b", "a", "c"]);
  });

  it("keys a workspace by PC and marks it as one", () => {
    expect(workspacePinKey("pc-a", "w1")).toBe("pc-a:workspace:w1");
    expect(isWorkspacePinKey(workspacePinKey("pc-a", "w1"))).toBe(true);
    expect(isWorkspacePinKey(sidebarPinKey("pc-a", "w1:p1"))).toBe(false);
    expect(pinnedWorkspaceIds(["pc-a:workspace:w2", "pc-a:w1:p1", "pc-b:workspace:w3", "pc-a:workspace:w1"], "pc-a")).toEqual(["w2", "w1"]);
  });

  it("prunes each kind of pin only where it is known", () => {
    const keys = ["pc-a:workspace:w1", "pc-a:workspace:gone", "pc-b:workspace:gone", "pc-a:p1"];
    // the Agents list leaves workspace pins alone, even of a loaded PC
    expect(pruneSidebarPins(keys, new Set(["pc-a:p1"]), [{ id: "pc-a", snapshot: {} }, { id: "pc-b", snapshot: {} }])).toEqual(keys);
    // a PC's workspace list prunes its own gone workspaces only
    expect(pruneWorkspacePins(keys, "pc-a", new Set(["w1"]))).toEqual(["pc-a:workspace:w1", "pc-b:workspace:gone", "pc-a:p1"]);
  });

  it("hoists only pinned rows and leaves a pinned head's worktrees in their group position", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
      { workspace: "other", children: [] },
    ];
    const split = (ids: string[]) => splitPinnedGroups(groups, ids, (id) => id);
    expect(split([])).toEqual({ pinned: [], rest: groups });
    expect(split(["wt2", "other"])).toEqual({
      pinned: [{ workspace: "wt2", children: [] }, { workspace: "other", children: [] }],
      rest: [{ workspace: "repo", children: ["wt1"] }, { workspace: "solo", children: [] }],
    });
    expect(split(["repo", "wt1", "missing"])).toEqual({
      pinned: [{ workspace: "repo", children: [] }, { workspace: "wt1", children: [] }],
      rest: [{ workspace: "wt2", children: [] }, { workspace: "solo", children: [] }, { workspace: "other", children: [] }],
    });
  });

  it("keeps unpinned worktrees in order between the groups around their pinned head", () => {
    const groups = [
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "after", children: [] },
    ];
    expect(splitPinnedGroups(groups, ["repo"], (id) => id)).toEqual({
      pinned: [{ workspace: "repo", children: [] }],
      rest: [{ workspace: "before", children: [] }, { workspace: "wt1", children: [] }, { workspace: "wt2", children: [] }, { workspace: "after", children: [] }],
    });
    expect(splitPinnedGroups(groups, [], (id) => id)).toEqual({ pinned: [], rest: groups });
  });

  it("identifies a pinned repository's unpinned worktrees to keep fixed outside the card", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
    ];
    expect([...pinnedGroupIds(groups, ["repo"], (id) => id)]).toEqual(["repo", "wt1", "wt2"]);
    expect([...pinnedGroupIds(groups, ["wt2"], (id) => id)]).toEqual(["wt2"]);
    expect(pinnedGroupIds(groups, [], (id) => id).size).toBe(0);
    expect(pinnedGroupIds([], ["missing"], (id: string) => id).size).toBe(0);
  });

  it("reorders pinned rows without moving their unpinned worktrees from the rest list", () => {
    const groups = [
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "after", children: [] },
    ];
    const pins = ["pc:workspace:repo", "pc:workspace:wt2", "pc:workspace:after"];
    const reordered = reorderWorkspacePins(pins, "pc", "repo", "after");
    const ids = pinnedWorkspaceIds(reordered, "pc");
    const shown = splitPinnedGroups(groups, ids, (id) => id);
    expect(shown.pinned).toEqual([
      { workspace: "wt2", children: [] },
      { workspace: "after", children: [] },
      { workspace: "repo", children: [] },
    ]);
    expect(shown.rest).toEqual([{ workspace: "before", children: [] }, { workspace: "wt1", children: [] }]);
    expect([...pinnedGroupIds(groups, ids, (id) => id)].filter((id) => !ids.includes(id))).toEqual(["wt1"]);
    expect(splitPinnedGroups(groups, ["wt2", "after"], (id) => id).rest).toEqual([
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1"] },
    ]);
  });

  it("pin_value_migrates", () => {
    // a stored "vscode:<s>" pin is read as "host:<s>", in its place, and written back that way
    expect(migratePins(["m:p1", "m:vscode:copilotcli:/x", "m:workspace:w1", "pc-b:vscode:s"])).toEqual(["m:p1", "m:host:copilotcli:/x", "m:workspace:w1", "pc-b:host:s"]);
    // the same chat pinned under both words is one pin; a pane id that merely holds the word is left alone
    expect(migratePins(["m:vscode:s", "m:host:s", "m:w1:vscode:x"])).toEqual(["m:host:s", "m:w1:vscode:x"]);
    const stored = new Map<string, string>([["ovis:sidebar-agent-pins", JSON.stringify(["m:vscode:copilotcli:/x", "m:p1"])]]);
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } } });
    try {
      expect(loadSidebarPins()).toEqual(["m:host:copilotcli:/x", "m:p1"]);
      expect(JSON.parse(stored.get("ovis:sidebar-agent-pins")!)).toEqual(["m:host:copilotcli:/x", "m:p1"]);
      expect(isHostChatPinKey(loadSidebarPins()[0]!)).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("starts with no pins when storage denies the read", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("denied"); } } });
    try { expect(loadSidebarPins()).toEqual([]); }
    finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("host folder pins", () => {
  it("keys a Copilot folder by PC and path, one trailing slash dropped, apart from every other pin", () => {
    expect(hostFolderPinKey("m", "/w/a/")).toBe("m:folder:/w/a");
    expect(hostFolderPinKey("m", "/w/a")).toBe(hostFolderPinKey("m", "/w/a/"));
    expect(isHostFolderPinKey(hostFolderPinKey("m", "/w/a"))).toBe(true);
    expect(isHostFolderPinKey(hostChatPinKey("m", "s"))).toBe(false);
    expect(isHostFolderPinKey(workspacePinKey("m", "w1"))).toBe(false);
    expect(isHostChatPinKey(hostFolderPinKey("m", "/w/a"))).toBe(false);
    expect(isWorkspacePinKey(hostFolderPinKey("m", "/w/a"))).toBe(false);
  });

  it("lists one PC's pinned folders in pin order", () => {
    const keys = [hostFolderPinKey("m", "/b"), workspacePinKey("m", "w1"), hostFolderPinKey("other", "/x"), hostFolderPinKey("m", "/a")];
    expect(pinnedHostFolders(keys, "m")).toEqual(["/b", "/a"]);
  });

  it("pruning agent pins keeps folder pins", () => {
    expect(pruneSidebarPins([hostFolderPinKey("m", "/w/a"), "m:gone-pane"], new Set(), [{ id: "m", snapshot: {} }])).toEqual(["m:folder:/w/a"]);
  });

  it("prunes only this PC's folder pins whose folder has no chat left", () => {
    const keys = [hostFolderPinKey("m", "/kept"), hostFolderPinKey("m", "/gone"), hostFolderPinKey("o", "/gone"), workspacePinKey("m", "w9")];
    expect(pruneHostFolderPins(keys, "m", new Set(["/kept"]))).toEqual(["m:folder:/kept", "o:folder:/gone", "m:workspace:w9"]);
  });
});

describe("toggleHostFolderPin", () => {
  it("pins a folder at the end, unpins it, and drops dead folder pins of that PC only on the change", () => {
    const keys = [hostFolderPinKey("m", "/gone"), workspacePinKey("m", "w1")];
    expect(toggleHostFolderPin(keys, "m", "/w/a/", new Set(["/w/a"]))).toEqual(["m:workspace:w1", "m:folder:/w/a"]);
    expect(toggleHostFolderPin(["m:folder:/w/a", "m:workspace:w1"], "m", "/w/a", new Set(["/w/a"]))).toEqual(["m:workspace:w1"]);
  });

  it("pinned_rows_mix_workspaces_and_folders_in_pin_order", () => {
    const pins = ["pc:workspace:a", "pc:p1", "pc:folder:/docs", "other:folder:/x", "pc:host:s1", "pc:workspace:b"];
    expect(pinnedRowKeys(pins, "pc")).toEqual(["pc:workspace:a", "pc:folder:/docs", "pc:workspace:b"]);
  });

  it("reorders_pinned_rows_across_kinds_leaving_other_slots", () => {
    const pins = ["pc:workspace:a", "pc:p1", "pc:folder:/docs", "other:workspace:a", "pc:workspace:b"];
    expect(reorderPinnedRows(pins, "pc", "pc:folder:/docs", "pc:workspace:a")).toEqual(["pc:folder:/docs", "pc:p1", "pc:workspace:a", "other:workspace:a", "pc:workspace:b"]);
    expect(reorderPinnedRows(pins, "pc", "pc:workspace:a", "pc:workspace:b")).toEqual(["pc:folder:/docs", "pc:p1", "pc:workspace:b", "other:workspace:a", "pc:workspace:a"]);
    for (const [source, target] of [["pc:workspace:a", "pc:workspace:a"], ["pc:folder:/gone", "pc:workspace:a"], ["pc:p1", "pc:workspace:a"]]) {
      expect(reorderPinnedRows(pins, "pc", source!, target!)).toEqual(pins);
    }
  });
});
