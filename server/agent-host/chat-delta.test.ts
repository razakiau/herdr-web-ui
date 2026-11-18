import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { HostChatRead } from "../../shared/host-chats.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { applyDelta, knownParam } from "../../shared/host-chat-delta.ts";
import { handleMachineRequest } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { DELTA_HEADER, deltaRead, prefixHashes } from "./chat-delta.ts";

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
    const fresh = bridge(() => answered, { [DELTA_HEADER]: "1" });
    expect(await fresh.get(`?session=s&${query(answered).toString()}`)).toEqual(answered);
    const old = bridge(() => chatRead(2));
    const page = await old.get(`?session=s&before=c1&${query(answered).toString()}`);
    expect(page.base).toBeUndefined();
    expect(page.turns).toHaveLength(4);
  });
});
