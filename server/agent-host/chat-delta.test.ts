import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { HostChatRead } from "../../shared/host-chats.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { applyDelta, knownParam, knownQuery, PAGE_MAX_CHARS, prependPage, TAIL_MAX_CHARS } from "../../shared/host-chat-delta.ts";
import { handleMachineRequest } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { DELTA_HEADER, DELTA_LEVEL, deltaRead, pageBefore, prefixHashes, WindowMoved } from "./chat-delta.ts";

const turnPair = (i: number, words = `FICTIONAL message ${i}`): ConversationTurn[] => [
  { role: "user", parts: [{ kind: "text", text: words }] } as ConversationTurn,
  { role: "assistant", parts: [{ kind: "text", text: `FICTIONAL reply to ${words}` }] } as ConversationTurn,
];

const chatRead = (pairs: number, overrides: Partial<HostChatRead> = {}): HostChatRead => ({
  session: "copilotcli:/fictional", title: "FICTIONAL chat", status: "idle",
  turns: Array.from({ length: pairs }, (_, i) => turnPair(i)).flat(),
  cursor: null, prompt: null, model: null, agent: null, busy: false, pending: [],
  commands: [{ name: "fictional-skill", description: "FICTIONAL does a thing", kind: "skill" }] as unknown as HostChatRead["commands"],
  background: { subagents: 0, commands: 0 }, confirmations: 0, context: null, message_ids: Array.from({ length: pairs }, (_, i) => `t${i}`),
  checkpoints: [], restored: null, signature: `sig-${pairs}`, ...overrides,
});

const query = (base: HostChatRead | null, extra: Record<string, string> = {}) =>
  new URLSearchParams({ ...(base?.base ? { known: knownParam(base.base) } : {}), ...(base?.commands_hash ? { commands: base.commands_hash } : {}), ...extra });

describe("a chat read's prefix digest (ZAC-340)", () => {
  it("is the digest of JSON.stringify(turns.slice(0, n)) for every n, from one pass", () => {
    const turns = chatRead(3).turns;
    const all = [0, 1, 2, 3, 4, 5, 6];
    const hashes = prefixHashes(turns, all);
    for (const n of all) expect(hashes.get(n)).toBe(createHash("sha256").update(JSON.stringify(turns.slice(0, n))).digest("base64url").slice(0, 22));
    expect(prefixHashes(turns, [7, -1]).size).toBe(0);
  });

  it("a delta applied to the read it was asked against is the full read, deep equal", () => {
    const before = deltaRead(chatRead(5), new URLSearchParams());
    // idle and unchanged
    const same = deltaRead(chatRead(5), query(before));
    expect(same.turns).toEqual([]);
    expect(applyDelta(before, same)).toEqual(before);
    // a new host turn and a changed command list
    const grown = chatRead(6, { commands: [] });
    const delta = deltaRead(grown, query(before));
    expect(delta.delta).toEqual({ from: 10 });
    expect(delta.turns).toEqual(grown.turns.slice(10));
    expect(applyDelta(before, delta)).toEqual(deltaRead(grown, new URLSearchParams()));
  });

  it("a busy chat changing its last turn: the delta resends that turn alone and rebuilds the full read", () => {
    const busy = (words: string) => chatRead(4, { busy: true, status: "working", turns: [...chatRead(3).turns, ...turnPair(3, words)] });
    const before = deltaRead(busy("FICTIONAL working"), new URLSearchParams());
    expect(before.base!.n).toBe(6);
    const later = busy("FICTIONAL working, further on");
    const delta = deltaRead(later, query(before));
    expect(delta.delta).toEqual({ from: 6 });
    expect(delta.turns).toEqual(later.turns.slice(6));
    expect(applyDelta(before, delta)).toEqual(deltaRead(later, new URLSearchParams()));
  });

  it("a delta that cannot be joined to what is held is refused", () => {
    const held = deltaRead(chatRead(1), new URLSearchParams());
    const far = deltaRead(chatRead(5), new URLSearchParams());
    expect(applyDelta(held, { ...far, turns: [], delta: { from: 8 } })).toBeNull();
    expect(applyDelta(null, { ...far, delta: { from: 0 } })).toBeNull();
    const { commands: _commands, ...noCommands } = far;
    expect(applyDelta(null, { ...noCommands, commands_same: true } as HostChatRead)).toBeNull();
  });
});

describe("CT 208's proxy for a bridge before ZAC-340", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

  /** A stand-in bridge: answers each chat read with `read()`, with or without the delta header. */
  function bridge(read: () => HostChatRead, headers: Record<string, string> = {}) {
    const asked: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
      asked.push(new URL(request.url).search);
      return new Response(JSON.stringify(read()), { headers: { "content-type": "application/json", ...headers } });
    } });
    servers.push(server);
    const manager = { endpoint: (id: string) => id === "pc" ? { url: `http://127.0.0.1:${server.port}`, token: "FICTIONAL-token" } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const get = async (search: string) => (await (await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc/host-chats/chat${search}`), manager)).json()) as HostChatRead;
    return { asked, get };
  }

  it("adds the base the old bridge does not, and answers the phone's known with only what changed", async () => {
    let current = chatRead(4);
    const pc = bridge(() => current);
    const first = await pc.get("?session=s");
    expect(first.base).toEqual({ n: 8, hash: expect.any(String) });
    expect(first.turns).toHaveLength(8);
    current = chatRead(5);
    const next = await pc.get(`?session=s&${query(first).toString()}`);
    // the bridge is asked with the same query: a bridge that knows `known` answers it itself
    expect(pc.asked[1]).toContain("known=");
    expect(next.delta).toEqual({ from: 8 });
    expect(next.turns).toEqual(current.turns.slice(8));
    expect(next.commands_same).toBe(true);
    expect(applyDelta(first, next)).toEqual(deltaRead(current, new URLSearchParams()));
  });

  it("an answer that already has its base or a delta is passed on as it is, header or not", async () => {
    const before = deltaRead(chatRead(2), new URLSearchParams());
    const answered = deltaRead(chatRead(3), query(before));
    expect(answered.delta).toEqual({ from: 4 });
    // no header (a proxy or bridge between that drops it): the delta must not be made again over the tail
    const headerless = bridge(() => answered);
    expect(await headerless.get(`?session=s&${query(before).toString()}`)).toEqual(answered);
    const full = deltaRead(chatRead(3), new URLSearchParams());
    const withBase = bridge(() => full);
    expect(await withBase.get(`?session=s&known=${encodeURIComponent("4.AAAAAAAAAAAAAAAAAAAAAA")}`)).toEqual(full);
  });

  it("passes a new bridge's answer and an older page on as they are", async () => {
    const answered = deltaRead(chatRead(2), new URLSearchParams());
    const fresh = bridge(() => answered, { [DELTA_HEADER]: DELTA_LEVEL });
    expect(await fresh.get(`?session=s&${query(answered).toString()}`)).toEqual(answered);
    const old = bridge(() => chatRead(2));
    const page = await old.get(`?session=s&before=c1&${query(answered).toString()}`);
    expect(page.base).toBeUndefined();
    expect(page.turns).toHaveLength(4);
  });
});

describe("the first open of a chat: its last turns, the older ones paged in (ZAC-340 part 2)", () => {
  const big = (i: number, chars: number) => turnPair(i, `FICTIONAL ${i} ${"w".repeat(chars)}`);
  const sized = (pairs: number, chars: (i: number) => number, overrides: Partial<HostChatRead> = {}) =>
    chatRead(pairs, { turns: Array.from({ length: pairs }, (_, i) => big(i, chars(i))).flat(), ...overrides });
  const tail = new URLSearchParams({ tail: "1" });
  const chars = (turns: unknown[]) => turns.reduce<number>((sum, turn) => sum + JSON.stringify(turn).length, 0);

  it("a tail holds the last 10 host turns, fewer past 150 KB, and never less than the last host turn", () => {
    const small = deltaRead(chatRead(30), tail);
    expect(small.offset).toBe(40);
    expect(small.turns).toEqual(chatRead(30).turns.slice(40));
    expect(small.base).toEqual({ from: 40, n: 60, hash: expect.any(String), anchor: "t20" });
    const heavy = sized(30, () => 40_000);
    const cut = deltaRead(heavy, tail);
    expect(cut.turns.length).toBeLessThan(20);
    expect(chars(cut.turns)).toBeLessThanOrEqual(TAIL_MAX_CHARS);
    expect(chars(heavy.turns.slice(cut.offset! - 2))).toBeGreaterThan(TAIL_MAX_CHARS);
    const huge = deltaRead(sized(5, () => 400_000), tail);
    expect(huge.turns).toHaveLength(2);
    expect(huge.offset).toBe(8);
    // a chat with fewer turns than a tail is read whole
    expect(deltaRead(chatRead(3), tail).offset).toBeUndefined();
  });

  it("paging the turns before the tail back in gives the full read's turns, deep equal", () => {
    const whole = sized(120, (i) => (i * 7919) % 60_000);
    let held = applyDelta(null, deltaRead(whole, tail))!;
    expect(held.offset).toBeGreaterThan(0);
    let pages = 0;
    while ((held.offset ?? 0) > 0) {
      const page = pageBefore(whole, held.message_ids[held.offset! / 2]!);
      // a page holds up to 600 KB (a tail 150 KB), one host turn at least
      expect(chars(page.turns) <= PAGE_MAX_CHARS || page.turns.length === 2).toBe(true);
      // cut by size, not by count: one host turn more would have been over
      if (page.offset > 0 && page.turns.length < 20) expect(chars(whole.turns.slice(page.offset - 2, page.offset + page.turns.length))).toBeGreaterThan(PAGE_MAX_CHARS);
      held = prependPage(held, page)!;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(held.turns).toEqual(whole.turns);
    expect(held.offset).toBeUndefined();
  });

  it("a tail chat read again is a delta from its range, idle, busy, and after the window grew before it", () => {
    // as the client holds it: a first open's tail, its commands deferred
    const before = applyDelta(null, deltaRead(chatRead(30), tail))!;
    expect(before.commands).toEqual([]);
    // as the client asks: no commands digest while it holds none
    const known = (read: HostChatRead) => new URLSearchParams({ ...knownQuery(read.base!), ...(read.commands_deferred ? {} : { commands: read.commands_hash! }), tail: "1" });
    // idle, unchanged: the commands come now
    const same = deltaRead(chatRead(30), known(before));
    expect(same.delta).toEqual({ from: 60 });
    expect(same.anchor_at).toBe(40);
    expect(same.turns).toEqual([]);
    const { commands_deferred: _deferred, ...fuller } = before;
    expect(applyDelta(before, same)).toEqual({ ...fuller, commands: chatRead(30).commands });
    // a new host turn, then busy with it running
    const grown = deltaRead(chatRead(31, { busy: true, status: "working" }), known(before));
    expect(grown.turns).toEqual(chatRead(31).turns.slice(60));
    const held = applyDelta(before, grown)!;
    expect(held.turns).toEqual(chatRead(31).turns.slice(40));
    expect(held.base).toEqual({ from: 40, n: 60, hash: expect.any(String), anchor: "t20" });
    // the host loaded 4 older host turns ahead of the window: the held turns move with their anchor
    const older = chatRead(35, { message_ids: [...["o1", "o2", "o3", "o4"], ...Array.from({ length: 31 }, (_, i) => `t${i}`)] });
    older.turns = [...chatRead(4).turns, ...chatRead(31).turns];
    const moved = deltaRead(older, known(held));
    expect(moved.anchor_at).toBe(48);
    const after = applyDelta(held, moved)!;
    expect(after.offset).toBe(48);
    expect(after.turns).toEqual(older.turns.slice(48));
  });

  it("a first open's tail leaves the commands for the next read, which brings them; a read knowing anything never defers them", () => {
    const first = deltaRead(chatRead(30), tail);
    expect("commands" in first).toBe(false);
    expect(first.commands_deferred).toBe(true);
    const next = deltaRead(chatRead(30), new URLSearchParams({ ...knownQuery(first.base!), tail: "1" }));
    expect(next.delta).toEqual({ from: 60 });
    expect(next.commands).toEqual(chatRead(30).commands);
    expect(next.commands_deferred).toBeUndefined();
    // a known that no longer matches gets a tail again, with its commands
    const stale = deltaRead(chatRead(30), new URLSearchParams({ known: "40.60.AAAAAAAAAAAAAAAAAAAAAA", anchor: "t20", tail: "1" }));
    expect(stale.offset).toBe(40);
    expect(stale.commands).toEqual(chatRead(30).commands);
    // a whole read (no tail) is never without them
    expect(deltaRead(chatRead(30), new URLSearchParams()).commands).toEqual(chatRead(30).commands);
  });

  it("a page before a turn the window no longer has is refused: 409 history_changed at the route", () => {
    expect(() => pageBefore(chatRead(5), "t-gone")).toThrow(WindowMoved);
    // a pending message's id is no turn
    expect(() => pageBefore(chatRead(2, { message_ids: ["t0", "t1", "pending-1"] }), "pending-1")).toThrow(WindowMoved);
  });
});

describe("CT 208's proxy, first open, for a bridge before bundle 1105", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
  const proxy = (read: () => HostChatRead, headers: Record<string, string> = {}) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(JSON.stringify(read()), { headers: { "content-type": "application/json", ...headers } }) });
    servers.push(server);
    const manager = { endpoint: () => ({ url: `http://127.0.0.1:${server.port}`, token: "FICTIONAL-token" }), trackTerminal: () => () => {} } as unknown as MachineManager;
    return async (search: string) => {
      const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc/host-chats/chat?session=s&${search}`), manager);
      return { status: response.status, body: await response.json() as any };
    };
  };

  it("cuts the tail, pages, and answers a range's delta itself; a page past the window is 409", async () => {
    for (const headers of [{}, { [DELTA_HEADER]: "1" }] as Record<string, string>[]) {
      // bundle 1104 adds a plain base to its whole read; older bundles none
      const answer = () => "x-ovis-chat-base" in headers ? deltaRead(chatRead(30), new URLSearchParams()) : chatRead(30);
      const get = proxy(answer, headers);
      const first = (await get("tail=1")).body as HostChatRead;
      expect(first.offset).toBe(40);
      expect(first.turns).toEqual(chatRead(30).turns.slice(40));
      expect(first.commands_deferred).toBe(true);
      expect("commands" in first).toBe(false);
      const again = (await get(new URLSearchParams({ ...knownQuery(first.base!), tail: "1" }).toString())).body as HostChatRead;
      expect(again.delta).toEqual({ from: 60 });
      expect(again.turns).toEqual([]);
      const page = (await get("page_before=t20")).body;
      expect(page).toMatchObject({ page: true, offset: 20, message_ids: Array.from({ length: 10 }, (_, i) => `t${i + 10}`) });
      expect(page.turns).toEqual(chatRead(30).turns.slice(20, 40));
      const gone = await get("page_before=t-gone");
      expect({ status: gone.status, code: gone.body.error.code }).toEqual({ status: 409, code: "history_changed" });
    }
  });

  it("a 1104 bridge is asked only what it understands: a tail chat's third read is still a delta, never the whole window", async () => {
    const asked: URLSearchParams[] = [];
    // bundle 1104: plain `known` and `commands` only, a ranged known not one (a whole read, commands left out if they match)
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
      const query = new URL(request.url).searchParams;
      asked.push(query);
      const plain = /^\d+\.[A-Za-z0-9_-]{8,64}$/.test(query.get("known") ?? "");
      const old = new URLSearchParams({ ...(plain ? { known: query.get("known")! } : {}), ...(query.has("commands") ? { commands: query.get("commands")! } : {}) });
      return new Response(JSON.stringify(deltaRead(chatRead(30), old)), { headers: { "content-type": "application/json", [DELTA_HEADER]: "1" } });
    } });
    servers.push(server);
    const manager = { endpoint: () => ({ url: `http://127.0.0.1:${server.port}`, token: "FICTIONAL-token" }), trackTerminal: () => () => {} } as unknown as MachineManager;
    const get = async (query: Record<string, string>) => await (await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc/host-chats/chat?${new URLSearchParams({ session: "s", ...query }).toString()}`), manager)).json() as HostChatRead;
    const first = await get({ tail: "1" });
    expect(first).toMatchObject({ offset: 40, commands_deferred: true });
    const second = await get({ ...knownQuery(first.base!), tail: "1" });
    expect(second).toMatchObject({ delta: { from: 60 }, turns: [] });
    expect(second.commands).toEqual(chatRead(30).commands);
    const third = await get({ ...knownQuery(second.base!), commands: second.commands_hash!, tail: "1" });
    expect(third).toMatchObject({ delta: { from: 60 }, turns: [], commands_same: true });
    // the bridge never saw the range nor the digest
    expect(asked.map((query) => [query.has("known"), query.has("anchor"), query.has("commands")])).toEqual([[false, false, false], [false, false, false], [false, false, false]]);
  });

  it("a 1105 bridge's tail goes through as it is", async () => {
    const made = deltaRead(chatRead(30), new URLSearchParams({ tail: "1" }));
    const get = proxy(() => made, { [DELTA_HEADER]: DELTA_LEVEL });
    expect((await get("tail=1")).body).toEqual(made);
  });
});
