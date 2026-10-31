import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostLink } from "../shared/host-chats.ts";
import { GroupStore } from "./groups-store.ts";

const dirs: string[] = [];
const stores: GroupStore[] = [];
function open(dir = mkdtempSync(join(tmpdir(), "ovis-groups-"))): GroupStore {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = new GroupStore(dir);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const link = (from: string, to: string, kind: HostLink["kind"] = "spawn"): HostLink => ({ from, to, kind, at: "2026-10-31T10:00:00.000Z" });
const sessionsOf = (store: GroupStore, id: number) => store.snapshot().groups.find((group) => group.id === id)?.members.map((member) => member.session).sort();
const groupOf = (store: GroupStore, session: string) => store.snapshot().groups.find((group) => group.members.some((member) => member.session === session));

describe("GroupStore", () => {
  it("files a chain", () => {
    const store = open();
    const titles = new Map([["262", "ZAC-262 plan"], ["265", "ZAC-265"]]);
    expect(store.addLinks("pc1", [link("262", "265"), link("262", "266")], titles)).toEqual({ filed: 2 });
    const { groups, links } = store.snapshot();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("ZAC-262 plan");
    expect(groups[0]!.members.map((member) => [member.pc, member.session, member.joined]).sort()).toEqual([["pc1", "262", "link"], ["pc1", "265", "link"], ["pc1", "266", "link"]]);
    expect(links.map((row) => `${row.pc} ${row.from}>${row.to}`).sort()).toEqual(["pc1 262>265", "pc1 262>266"]);
  });

  it("relinking from zero respects decided", () => {
    const store = open();
    const all = [link("262", "265"), link("262", "266"), link("300", "301")];
    store.addLinks("pc1", all);
    const chain = groupOf(store, "262")!.id;
    const third = groupOf(store, "300")!.id;
    const other = store.create("Elsewhere");
    store.remove("pc1", "266");
    store.move(other, "pc1", "265");
    store.delete(third);
    const before = store.snapshot().groups;
    expect(store.addLinks("pc1", all)).toEqual({ filed: 0 });
    expect(store.snapshot().groups).toEqual(before);
    expect(sessionsOf(store, chain)).toEqual(["262"]);
    expect(sessionsOf(store, other)).toEqual(["265"]);
    expect(groupOf(store, "266")).toBeUndefined();
    expect(groupOf(store, "301")).toBeUndefined();
  });

  it("idempotent", () => {
    const store = open();
    const all = [link("a", "b"), link("b", "c")];
    expect(store.addLinks("pc1", all)).toEqual({ filed: 2 });
    expect(store.addLinks("pc1", all)).toEqual({ filed: 0 });
    expect(store.snapshot().links).toHaveLength(2);
    expect(store.snapshot().groups).toHaveLength(1);
  });

  it("names a group after an unknown chat neutrally", () => {
    const store = open();
    store.addLinks("pc1", [link("a", "b")]);
    expect(store.snapshot().groups[0]!.name).toBe("Chat group");
  });

  it("split", () => {
    const store = open();
    store.addLinks("pc1", [link("a", "b"), link("b", "c")]);
    const old = groupOf(store, "a")!.id;
    store.add(old, "pc1", "m");
    const fresh = store.split("pc1", "b");
    expect(fresh).not.toBe(old);
    expect(sessionsOf(store, fresh)).toEqual(["b", "c"]);
    expect(sessionsOf(store, old)).toEqual(["a", "m"]);
  });

  it("ids not reused", () => {
    const store = open();
    store.create("one");
    const newest = store.create("two");
    store.delete(newest);
    expect(store.create("three")).toBeGreaterThan(newest);
  });

  it("starts a group from a chat by hand, and links leave it there", () => {
    const store = open();
    const id = store.create("Mine", { pc: "pc1", session: "b" });
    expect(store.snapshot().groups[0]!.members).toMatchObject([{ pc: "pc1", session: "b", joined: "manual" }]);
    expect(store.addLinks("pc1", [link("a", "b")])).toEqual({ filed: 0 });
    expect(sessionsOf(store, id)).toEqual(["b"]);
  });

  it("forks", () => {
    const store = open();
    store.addLinks("pc1", [link("a", "b")], new Map([["a", "Plan"]]));
    expect(store.addForks("pc1", [{ session: "a", title: "Plan" }, { session: "f", fork_of: "a", title: "Plan (fork)" }])).toEqual({ filed: 1 });
    expect(sessionsOf(store, groupOf(store, "a")!.id)).toEqual(["a", "b", "f"]);
    expect(store.snapshot().links.find((row) => row.to === "f")?.kind).toBe("fork");
    expect(store.addForks("pc1", [{ session: "f", fork_of: "a", title: "Plan (fork)" }])).toEqual({ filed: 0 });
  });

  it("keeps groups, decided chats, summaries, digests and settings across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-groups-"));
    const first = open(dir);
    first.addLinks("pc1", [link("a", "b")]);
    const id = groupOf(first, "a")!.id;
    first.rename(id, "Renamed");
    first.remove("pc1", "b");
    first.setSummary({ pc: "pc1", session: "a", text: "five lines", lastCallSeen: "t1", model: "m", writtenAt: "t2" });
    first.setDigest({ groupId: id, direction: "on", open: [{ text: "x" }], done: [], perChat: [{ pc: "pc1", session: "a", line: "l" }], model: "m", effort: "low", cost: 0.1, writtenAt: "t3", chatsSeen: { "pc1 a": "t1" } });
    first.setSetting("digestModel", "m");
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const again = open(dir);
    expect(again.addLinks("pc1", [link("a", "b")])).toEqual({ filed: 0 });
    const snap = again.snapshot();
    expect(snap.groups.map((group) => [group.name, group.members.map((member) => member.session)])).toEqual([["Renamed", ["a"]]]);
    expect(snap.summaries).toEqual([{ pc: "pc1", session: "a", text: "five lines", lastCallSeen: "t1", model: "m", writtenAt: "t2" }]);
    expect(snap.digests[0]).toMatchObject({ groupId: id, direction: "on", open: [{ text: "x" }], cost: 0.1, chatsSeen: { "pc1 a": "t1" } });
    expect(again.getSetting("digestModel")).toBe("m");
    expect(again.getSetting("missing")).toBeNull();
  });
});
