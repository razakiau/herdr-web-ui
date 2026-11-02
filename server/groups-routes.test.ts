import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestEstimate, GroupDigestAnswer, GroupsAnswer } from "../shared/groups.ts";
import type { HostChatRead, HostLink } from "../shared/host-chats.ts";
import { ChatFactsCache, DigestJobs, digestModelAllowed, modelPrice } from "./group-digest.ts";
import { OmniRouteError } from "./omniroute.ts";
import type { MachineEvent } from "../shared/machines.ts";
import { DIGEST_DEFAULTS, DIGEST_EFFORT_KEY, DIGEST_MODEL_KEY, GroupsSignal, createGroupsPoller, handleGroupsRequest, pullGroups, remotePcChats, type GroupsPcSource } from "./groups-routes.ts";
import { GroupStore } from "./groups-store.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const dirs: string[] = [];
const stores: GroupStore[] = [];
function open(): GroupStore {
  const dir = mkdtempSync(join(tmpdir(), "ovis-groups-routes-"));
  dirs.push(dir);
  const store = new GroupStore(dir);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const link = (from: string, to: string, kind: HostLink["kind"] = "spawn"): HostLink => ({ from, to, kind, at: "2026-10-31T10:00:00.000Z" });

/**
 * A remote PC's bridge as `remoteJson` reads it (server/index.ts): each path answers a status and a
 * body, a non-2xx or a throw reads as null, as remoteJson's does.
 */
function fakeBridge(answers: Record<string, { status: number; body?: unknown } | "timeout">) {
  const calls: string[] = [];
  const fakeFetch = async (path: string): Promise<Response> => {
    calls.push(path);
    const answer = answers[path];
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (answer === "timeout") throw new DOMException("timed out", "TimeoutError");
    return new Response(JSON.stringify(answer.body ?? null), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  const get = async <T,>(path: string, _timeoutMs: number): Promise<T | null> => {
    try {
      const response = await fakeFetch(path);
      if (!response.ok) { await response.body?.cancel(); return null; }
      return await response.json() as T;
    } catch { return null; }
  };
  return { calls, get };
}

const rows = [
  { session: "262", title: "ZAC-262 plan", status: "idle", modified_at: "2026-10-31T09:00:00.000Z", cwd: null, unread: false, archived: false },
  { session: "265", title: "ZAC-265", status: "idle", modified_at: "2026-10-31T10:00:00.000Z", cwd: null, unread: false, archived: false },
  { session: "f1", title: "a fork", status: "idle", modified_at: "2026-10-31T11:00:00.000Z", cwd: null, unread: false, archived: false, fork_of: "262" },
];

describe("pulling every PC's links", () => {
  it("files a PC's links and forks under its rows' titles, and tells only a poll that filed something", async () => {
    const store = open();
    const bridge = fakeBridge({ "/api/host-chats/links": { status: 200, body: { links: [link("262", "265")], complete: true } }, "/api/host-chats/chats": { status: 200, body: { chats: rows } } });
    const sources: GroupsPcSource[] = [{ pc: "pc2", read: () => remotePcChats(bridge.get) }];
    let told = 0;
    expect(await pullGroups(store, sources, () => { told++; })).toBe(2);
    expect(told).toBe(1);
    const { groups } = store.snapshot();
    expect(groups.map((group) => [group.name, group.members.map((member) => member.session).sort()])).toEqual([["ZAC-262 plan", ["262", "265", "f1"]]]);
    // the full list again on the next tick: nothing new, nothing told
    expect(await pullGroups(store, sources, () => { told++; })).toBe(0);
    expect(told).toBe(1);
    // the links are asked for whole, never `since` (R4)
    expect(bridge.calls.filter((path) => path.startsWith("/api/host-chats/links"))).toEqual(["/api/host-chats/links", "/api/host-chats/links"]);
  });

  it("offline pc keeps members: a PC whose links call fails changes nothing", async () => {
    const store = open();
    store.addLinks("pc2", [link("262", "265")], new Map([["262", "ZAC-262 plan"]]));
    const before = store.snapshot();
    const offline = fakeBridge({ "/api/host-chats/links": "timeout", "/api/host-chats/chats": "timeout" });
    let told = 0;
    const sources: GroupsPcSource[] = [
      { pc: "pc2", read: () => remotePcChats(offline.get) },
      { pc: "pc3", read: () => Promise.reject(new Error("unreachable")) },
    ];
    expect(await pullGroups(store, sources, () => { told++; })).toBe(0);
    expect(store.snapshot()).toEqual(before);
    expect(told).toBe(0);
  });

  it("old bundle: a 404 on the links route is no error and changes nothing, forks included", async () => {
    const store = open();
    const old = fakeBridge({ "/api/host-chats/chats": { status: 200, body: { chats: rows } } });
    expect(await remotePcChats(old.get)).toBeNull();
    expect(await pullGroups(store, [{ pc: "pc2", read: () => remotePcChats(old.get) }], () => {})).toBe(0);
    expect(store.snapshot().groups).toEqual([]);
  });

  it("files nothing from a PC whose rows cannot be read: its links would carry log ids, not row ids", async () => {
    const store = open();
    const down = fakeBridge({ "/api/host-chats/links": { status: 200, body: { links: [link("copilotcli:/a", "copilotcli:/b")], complete: true } }, "/api/host-chats/chats": { status: 503, body: { error: { code: "host_down", message: "down" } } } });
    expect(await pullGroups(store, [{ pc: "pc2", read: () => remotePcChats(down.get) }], () => {})).toBe(0);
    expect(store.snapshot().links).toEqual([]);
  });

  it("keeps only well-formed links and rows from a bridge", async () => {
    const bridge = fakeBridge({
      "/api/host-chats/links": { status: 200, body: { links: [link("a", "b"), { from: "a", to: 3, kind: "spawn", at: "x" }, { from: "a", to: "c", kind: "teleport", at: "x" }, null], complete: true } },
      "/api/host-chats/chats": { status: 200, body: { chats: [{ session: "a", title: "A" }, { session: 4, title: "B" }, { session: "c", title: "C", fork_of: 9 }] } },
    });
    expect(await remotePcChats(bridge.get)).toEqual({ links: [link("a", "b")], rows: [{ session: "a", title: "A" }, { session: "c", title: "C" }] });
  });

  it("switch off: with chatGroups false a tick asks no PC anything", async () => {
    const store = open();
    const bridge = fakeBridge({ "/api/host-chats/links": { status: 200, body: { links: [link("262", "265")] } }, "/api/host-chats/chats": { status: 200, body: { chats: rows } } });
    let on = false;
    const poller = createGroupsPoller({ store: () => store, intervalMs: 10, wanted: () => on, sources: () => [{ pc: "pc2", read: () => remotePcChats(bridge.get) }], changed: () => {} });
    poller.start();
    await Bun.sleep(60); // fixed wait: proving no tick asks while the switch is off
    expect(bridge.calls).toEqual([]);
    on = true;
    const deadline = Date.now() + 5_000;
    while (store.snapshot().groups.length === 0) { if (Date.now() > deadline) throw new Error("no poll filed the link"); await Bun.sleep(5); }
    poller.stop();
    await poller.idle();
    expect(bridge.calls.length).toBeGreaterThan(0);
  });
});

describe("/api/groups", () => {
  const call = (store: GroupStore, method: string, path: string, body?: unknown, changed: () => void = () => {}) =>
    handleGroupsRequest(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), path, store, changed);
  const answer = async (store: GroupStore) => await (await call(store, "GET", "/api/groups")).json() as GroupsAnswer;
  const code = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  it("answers the snapshot with the digest defaults", async () => {
    const store = open();
    store.addLinks("pc1", [link("262", "265")]);
    const body = await answer(store);
    expect(body.digestDefaults).toEqual(DIGEST_DEFAULTS);
    expect(DIGEST_DEFAULTS).toEqual({ model: "claude/claude-haiku-5-5", effort: "medium" });
    expect(body.groups.length).toBe(1);
    expect(body.links).toEqual([{ pc: "pc1", ...link("262", "265") }]);
    store.setSetting("digestModel", "other-model");
    expect((await answer(store)).digestDefaults).toEqual({ model: "other-model", effort: "medium" });
  });

  it("creates, renames, adds, moves, removes, splits and deletes, telling each change", async () => {
    const store = open();
    let told = 0;
    const changed = () => { told++; };
    const created = await call(store, "POST", "/api/groups", { name: "Plan", first: { pc: "pc1", session: "a" } }, changed);
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: number };
    expect((await answer(store)).groups.map((group) => [group.id, group.name, group.members.map((member) => member.session)])).toEqual([[id, "Plan", ["a"]]]);
    expect((await call(store, "POST", `/api/groups/${id}/rename`, { name: "Renamed" }, changed)).status).toBe(200);
    expect((await call(store, "POST", `/api/groups/${id}/add`, { pc: "pc1", session: "b" }, changed)).status).toBe(200);
    const other = (await (await call(store, "POST", "/api/groups", { name: "Other" }, changed)).json() as { id: number }).id;
    // add also moves
    expect((await call(store, "POST", `/api/groups/${other}/add`, { pc: "pc1", session: "b" }, changed)).status).toBe(200);
    let groups = (await answer(store)).groups;
    expect(groups.map((group) => [group.name, group.members.map((member) => member.session)])).toEqual([["Renamed", ["a"]], ["Other", ["b"]]]);
    expect((await call(store, "POST", "/api/groups/remove", { pc: "pc1", session: "b" }, changed)).status).toBe(200);
    groups = (await answer(store)).groups;
    expect(groups.find((group) => group.id === other)!.members).toEqual([]);
    const split = await call(store, "POST", "/api/groups/split", { pc: "pc1", session: "a" }, changed);
    expect(split.status).toBe(200);
    const splitId = (await split.json() as { id: number }).id;
    expect((await answer(store)).groups.find((group) => group.id === splitId)!.members.map((member) => member.session)).toEqual(["a"]);
    expect((await call(store, "POST", `/api/groups/${id}/delete`, undefined, changed)).status).toBe(200);
    expect((await answer(store)).groups.some((group) => group.id === id)).toBe(false);
    expect(told).toBe(8);
  });

  it("merges a group into another: its chats move, it goes; a bad target is 400, a missing group 404", async () => {
    const store = open();
    let told = 0;
    const changed = () => { told++; };
    const source = store.create("Source", { pc: "pc1", session: "a" });
    store.add(source, "pc2", "b");
    const target = store.create("Target", { pc: "pc1", session: "c" });
    for (const into of [source, "2", 0, 1.5, undefined]) expect((await call(store, "POST", `/api/groups/${source}/merge`, { into }, changed)).status).toBe(400);
    expect(await code(await call(store, "POST", `/api/groups/${source}/merge`, { into: 99 }, changed))).toEqual([404, "group_not_found"]);
    expect(await code(await call(store, "POST", `/api/groups/99/merge`, { into: target }, changed))).toEqual([404, "group_not_found"]);
    expect(told).toBe(0);
    expect((await call(store, "POST", `/api/groups/${source}/merge`, { into: target }, changed)).status).toBe(200);
    expect(told).toBe(1);
    expect((await answer(store)).groups.map((group) => [group.name, group.members.map((member) => member.session).sort()])).toEqual([["Target", ["a", "b", "c"]]]);
  });

  it("refuses a missing or wrong field with 400 and changes nothing", async () => {
    const store = open();
    const id = store.create("G");
    let told = 0;
    const changed = () => { told++; };
    const before = store.snapshot();
    const refusals: [string, unknown][] = [
      ["/api/groups", {}],
      ["/api/groups", { name: "  " }],
      ["/api/groups", { name: 3 }],
      ["/api/groups", { name: "x".repeat(201) }],
      ["/api/groups", { name: "ok", first: { pc: "pc1" } }],
      ["/api/groups", "not json"],
      [`/api/groups/${id}/rename`, {}],
      [`/api/groups/${id}/add`, { pc: "pc1" }],
      [`/api/groups/${id}/add`, { session: "a" }],
      ["/api/groups/remove", { pc: "", session: "a" }],
      ["/api/groups/split", { pc: "pc1" }],
    ];
    for (const [path, body] of refusals) expect([path, (await call(store, "POST", path, body, changed)).status]).toEqual([path, 400]);
    expect(store.snapshot()).toEqual(before);
    expect(told).toBe(0);
  });

  it("answers 404 for a group that does not exist, and 400 for splitting a chat in no group", async () => {
    const store = open();
    expect(await code(await call(store, "POST", "/api/groups/99/add", { pc: "pc1", session: "a" }))).toEqual([404, "group_not_found"]);
    expect(await code(await call(store, "POST", "/api/groups/99/rename", { name: "x" }))).toEqual([404, "group_not_found"]);
    expect(await code(await call(store, "POST", "/api/groups/99/delete"))).toEqual([404, "group_not_found"]);
    expect(await code(await call(store, "POST", "/api/groups/0x1/delete"))).toEqual([404, "not_found"]);
    expect(await code(await call(store, "POST", "/api/groups/split", { pc: "pc1", session: "a" }))).toEqual([400, "not_in_group"]);
    expect(store.snapshot().groups).toEqual([]);
    // the chat a refused add named was not marked as placed by hand: a link still files it
    expect(store.addLinks("pc1", [link("z", "a")]).filed).toBe(1);
  });

  it("answers 405 for a method a route does not take", async () => {
    const store = open();
    expect((await call(store, "PUT", "/api/groups", {})).status).toBe(405);
    expect((await call(store, "GET", "/api/groups/remove")).status).toBe(405);
  });
});

it("tells a groups change on the PC event stream", async () => {
  const signal = new GroupsSignal();
  const manager = { subscribe: () => () => undefined } as unknown as MachineManager;
  const abort = new AbortController();
  const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager,
    undefined, undefined, false, undefined, undefined, signal);
  const reader = response.body!.getReader();
  const events: MachineEvent[] = [];
  let buffer = "";
  try {
    signal.tell();
    const deadline = Date.now() + 5_000;
    while (!events.some((event) => event.type === "groups")) {
      if (Date.now() > deadline) throw new Error("no groups event");
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    }
    expect(events.filter((event) => event.type === "groups")).toEqual([{ type: "groups" }]);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
});

it("serves /api/groups behind sign-in and the same-origin check, as /api/preferences", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-groups-server-"));
  dirs.push(stateDir);
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-groups", tailscaleOwner: null, machines: false, sidecar: false });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer test-groups" };
  const json = { "content-type": "application/json" };
  try {
    expect((await fetch(`${base}/api/groups`)).status).toBe(401);
    const empty = await (await fetch(`${base}/api/groups`, { headers: auth })).json() as GroupsAnswer;
    expect(empty).toEqual({ groups: [], links: [], summaries: [], digests: [], digestDefaults: DIGEST_DEFAULTS });
    // a cross-site page cannot change the groups
    const crossSite = await fetch(`${base}/api/groups`, { method: "POST", headers: { ...auth, ...json, origin: "https://evil.example" }, body: JSON.stringify({ name: "x" }) });
    expect(crossSite.status).toBe(403);
    const created = await fetch(`${base}/api/groups`, { method: "POST", headers: { ...auth, ...json, "x-herdr-machine": "1" }, body: JSON.stringify({ name: "Plan" }) });
    expect(created.status).toBe(200);
    expect((await (await fetch(`${base}/api/groups`, { headers: auth })).json() as GroupsAnswer).groups.map((group) => group.name)).toEqual(["Plan"]);
  } finally {
    server.stop();
  }
});

describe("the digest's routes", () => {
  function routes(options: { on?: boolean; models?: () => Promise<string[]>; modelAllowed?: (id: string) => boolean } = {}) {
    const store = open();
    const id = store.create("Group");
    store.add(id, "local", "a");
    let told = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const listed = new Map<string, Set<string>>();
    const facts = new ChatFactsCache(async () => ({ lastCalls: new Map([["local a", "2026-10-31T10:00:00.000Z"]]), contexts: new Map([["local a", 4_000]]), archived: new Set<string>(), listed }), 60_000, () => {});
    const jobs = new DigestJobs({
      store: () => store,
      readChat: async (_pc, session) => { await gate; return { session, title: session, status: "idle", turns: [], cursor: null, prompt: null, model: null, agent: null, busy: false, pending: [], commands: [], background: { subagents: 0, commands: 0 }, confirmations: 0, context: null } as unknown as HostChatRead; },
      complete: async (request) => ({ text: request.system.includes("one coding-agent chat") ? JSON.stringify({ text: "did a" }) : JSON.stringify({ direction: "D1\nD2\nD3", open: [], done: [], perChat: [] }), usage: { input: 1000, cached: 0, output: 100 } }),
      prices: async () => ({ prices: { "opencode-go": { "claude-haiku-5-5": { input: 1, output: 5 } } }, fallback: null }),
      facts, models: options.models ?? (async () => ["opencode-go/claude-haiku-5-5", "m2"]), changed: () => { told += 1; },
      ...(options.modelAllowed ? { modelAllowed: options.modelAllowed } : {}),
    });
    const on = { value: options.on ?? true };
    const ask = (path: string, init: RequestInit = {}) => handleGroupsRequest(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`).pathname, store, () => {}, { on: () => on.value, jobs });
    return { store, id, jobs, ask, release, told: () => told, on, listed };
  }
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const CHOICE = { model: "opencode-go/claude-haiku-5-5", effort: "low" };

  it("404 groups_off with the switch off, on every digest route", async () => {
    const { id, ask } = routes({ on: false });
    for (const [path, init] of [[`/api/groups/${id}/digest`, {}], [`/api/groups/${id}/digest`, post(CHOICE)], [`/api/groups/${id}/digest/estimate?model=m&effort=low`, {}], ["/api/groups/models", {}]] as const) {
      const response = await ask(path, init);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("groups_off");
    }
  });

  it("POST starts a job and answers at once; a second POST while it runs is 409 digest_running; GET shows its stage, then the digest", async () => {
    const { id, ask, release, store, listed } = routes();
    const started = await ask(`/api/groups/${id}/digest`, post(CHOICE));
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ job: 1 });
    const again = await ask(`/api/groups/${id}/digest`, post(CHOICE));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("digest_running");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await (await ask(`/api/groups/${id}/digest`)).json()).toEqual({ digest: null, spentUsd: 0, spendIncomplete: false, writing: { phase: "summaries", done: 0, total: 1 } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = await (await ask(`/api/groups/${id}/digest`)).json() as GroupDigestAnswer;
    expect(done.writing).toBeUndefined();
    expect(done.digest?.direction).toBe("D1\nD2\nD3");
    expect(done.spentUsd).toBeCloseTo(0.003, 10);
    // the Groups cards: the first two lines, the spend, and nothing moved on
    const answer = await (await ask("/api/groups")).json() as GroupsAnswer;
    expect(answer.digests).toEqual([expect.objectContaining({ groupId: id, direction: "D1\nD2", staleCount: 0, model: CHOICE.model, effort: "low" })]);
    expect(answer.digests[0]!.spentUsd).toBeCloseTo(0.003, 10);
    expect(answer.digestDefaults).toEqual(CHOICE);
    // a chat that joined since counts as moved on
    store.add(id, "local", "b");
    expect(((await (await ask("/api/groups")).json()) as GroupsAnswer).digests[0]!.staleCount).toBe(1);
    // ...unless its PC's list answered without it (deleted): gone, not moved on
    listed.set("local", new Set(["a"]));
    expect(((await (await ask("/api/groups")).json()) as GroupsAnswer).digests[0]!.staleCount).toBe(0);
  });

  it("merge and delete are 409 digest_running while either group's digest is being written", async () => {
    const { id, ask, release, store } = routes();
    const other = store.create("Other", { pc: "local", session: "z" });
    expect((await ask(`/api/groups/${id}/digest`, post(CHOICE))).status).toBe(200);
    for (const [path, body] of [[`/api/groups/${id}/delete`, {}], [`/api/groups/${id}/merge`, { into: other }], [`/api/groups/${other}/merge`, { into: id }]] as const) {
      const response = await ask(path, post(body));
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 409, "digest_running"]);
    }
    // the other group, with no job of its own and no merge into a busy one, can still go
    expect(store.snapshot().groups.map((group) => group.id)).toEqual([id, other]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await ask(`/api/groups/${other}/merge`, post({ into: id }))).status).toBe(200);
    expect((await ask(`/api/groups/${id}/delete`, post({}))).status).toBe(200);
  });

  it("a saved pick the picker no longer offers reads as the default, and a refresh with it uses the default; the effort sticks", async () => {
    const allow = "claude/claude-haiku-5-5,claude/claude-opus-5-5";
    const { id, ask, release, store } = routes({ modelAllowed: (model) => digestModelAllowed(model, allow) });
    store.setSetting(DIGEST_MODEL_KEY, "cc/claude-haiku-5-5");
    store.setSetting(DIGEST_EFFORT_KEY, "high");
    expect(((await (await ask("/api/groups")).json()) as GroupsAnswer).digestDefaults).toEqual({ model: DIGEST_DEFAULTS.model, effort: "high" });
    // an allowed pick stays
    store.setSetting(DIGEST_MODEL_KEY, "claude/claude-opus-5-5");
    expect(((await (await ask("/api/groups")).json()) as GroupsAnswer).digestDefaults.model).toBe("claude/claude-opus-5-5");
    // a refresh sent with the old id runs with the default, and saves it
    expect((await ask(`/api/groups/${id}/digest`, post({ model: "cc/claude-haiku-5-5", effort: "high" }))).status).toBe(200);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.digest(id)?.model).toBe(DIGEST_DEFAULTS.model);
    expect(store.getSetting(DIGEST_MODEL_KEY)).toBe(DIGEST_DEFAULTS.model);
    expect(store.getSetting(DIGEST_EFFORT_KEY)).toBe("high");
  });

  it("the default model is Claude's Haiku, priced under the claude provider (not the OpenCode Go quota)", () => {
    expect(DIGEST_DEFAULTS.model.startsWith("claude/")).toBe(true);
    expect(modelPrice(DIGEST_DEFAULTS.model, { claude: { "claude-haiku-5-5": { input: 1, output: 5 } } }, null)).toEqual({ input: 1, output: 5 });
    expect(digestModelAllowed(DIGEST_DEFAULTS.model, undefined)).toBe(true);
  });

  it("digestModelAllowed: the list when set, else the providers without effort variants", () => {
    expect(digestModelAllowed("cc/claude-haiku-5-5", "opencode-go/claude-haiku-5-5")).toBe(false);
    expect(digestModelAllowed("opencode-go/claude-haiku-5-5", " opencode-go/claude-haiku-5-5 , x")).toBe(true);
    expect(digestModelAllowed("cc/claude-haiku-5-5", undefined)).toBe(false);
    expect(digestModelAllowed("claude/claude-opus-5-5-high", "")).toBe(false);
    expect(digestModelAllowed("claude/claude-opus-5-5", "")).toBe(true);
  });

  it("the estimate's shape; a bad query is 400; an unknown group 404", async () => {
    const { id, ask } = routes();
    const estimate = await (await ask(`/api/groups/${id}/digest/estimate?model=opencode-go/claude-haiku-5-5&effort=low`)).json() as DigestEstimate;
    expect(Object.keys(estimate).sort()).toEqual(["chats", "groupPasses", "tokensIn", "usd"]);
    expect(estimate.chats).toBe(1);
    expect(estimate.groupPasses).toBe(1);
    expect(typeof estimate.usd).toBe("number");
    expect((await ask(`/api/groups/${id}/digest/estimate?model=m&effort=extreme`)).status).toBe(400);
    expect((await ask("/api/groups/99/digest")).status).toBe(404);
    expect((await ask(`/api/groups/${id}/digest`, post({ model: "", effort: "low" }))).status).toBe(400);
  });

  it("models: OmniRoute's ids, and its failure in fixed words", async () => {
    expect(await (await routes().ask("/api/groups/models")).json()).toEqual({ models: ["opencode-go/claude-haiku-5-5", "m2"] });
    const failing = routes({ models: async () => { throw new Error("Could not reach OmniRoute"); } });
    const response = await failing.ask("/api/groups/models");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "models_unavailable", message: "Could not reach OmniRoute" } });
    const keyless = routes({ models: async () => { throw new OmniRouteError("digest_unavailable", 409, "No OmniRoute API key (HERDR_WEB_OMNIROUTE_API_KEY)"); } });
    const unavailable = await keyless.ask("/api/groups/models");
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: { code: "digest_unavailable", message: "No OmniRoute API key (HERDR_WEB_OMNIROUTE_API_KEY)" } });
  });
});

it("a watching device cannot start a digest; the switch off is groups_off", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-groups-digest-server-"));
  dirs.push(stateDir);
  const WATCH = "e".repeat(64);
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdee", label: "Watch", role: "watch", token_hash: createHash("sha256").update(WATCH).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-groups", tailscaleOwner: null, machines: false, sidecar: false });
  const base = `http://127.0.0.1:${server.port}`;
  const json = { "content-type": "application/json", "x-herdr-machine": "1" };
  try {
    const watching = await fetch(`${base}/api/groups/1/digest`, { method: "POST", headers: { ...json, "x-forwarded-for": "100.64.0.9", cookie: `ovis_device=${WATCH}` }, body: JSON.stringify({ model: "m", effort: "low" }) });
    expect(watching.status).toBe(403);
    expect(((await watching.json()) as { error: { code: string } }).error.code).toBe("read_only");
    const off = await fetch(`${base}/api/groups/models`, { headers: { authorization: "Bearer test-groups" } });
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("groups_off");
  } finally {
    server.stop();
  }
});
