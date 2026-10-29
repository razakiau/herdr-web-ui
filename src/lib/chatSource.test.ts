import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";

import type { HostChatRead } from "../../shared/host-chats.ts";
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { forgetKeptContexts, hostSource, keepContext, paneSource, HOST_WATCH_MS } from "./chatSource.ts";
import { ConversationRefresh } from "./conversationRefresh.ts";
import { noteHostChatMessage, noteHostChatStreamOpen } from "./hostChats.ts";
import type { MachineApi } from "./machineContext.tsx";

const realFetch = globalThis.fetch;
const globals = globalThis as unknown as { window?: unknown };
const realWindow = globals.window;
let restoreClock: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  globals.window = realWindow;
  restoreClock?.();
  restoreClock = undefined;
});

const said = (role: ConversationTurn["role"], text: string): ConversationTurn => ({ role, ts: null, parts: [{ kind: "text", text }] });
/** A host chat's read: each host turn is a user turn and an assistant turn, under the host turn's id. */
const hostRead = (ids: string[], cursor: string | null, extra: Partial<HostChatRead> = {}): HostChatRead => ({
  session: "s", title: "FICTIONAL chat", status: "idle", cursor, prompt: null,
  turns: ids.flatMap((id) => [said("user", `FICTIONAL ask ${id}`), said("assistant", `FICTIONAL answer ${id}`)]),
  model: { id: "fictional/model-a", effort: "high" }, agent: null, busy: false, pending: [], commands: [], background: { subagents: 0, commands: 0 }, confirmations: 0, context: null, message_ids: ids, checkpoints: [], restored: null, signature: ids.join(","), ...extra,
});
/** fetch answers each host-chats/chat GET with the next read, and records the URLs asked. */
const answering = (...reads: HostChatRead[]): string[] => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(init?.method === "POST" ? `POST ${url} ${String(init.body)}` : url);
    if (init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    const read = reads.length > 1 ? reads.shift()! : reads[0]!;
    return new Response(JSON.stringify(read), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
};
const texts = (answer: ConversationResponse): string[] => answer.turns.map((turn) => (turn.parts[0] as { text: string }).text);

describe("hostSource", () => {
  it("host_source_maps_read_to_conversation", async () => {
    const urls = answering(hostRead(["t2", "t3"], "c1"));
    const source = hostSource("m", "s");
    const answer = await source.read();
    expect(urls).toEqual(["/api/machines/m/host-chats/chat?session=s"]);
    expect(answer.source).toBe("agent-host");
    expect(texts(answer)).toEqual(["FICTIONAL ask t2", "FICTIONAL answer t2", "FICTIONAL ask t3", "FICTIONAL answer t3"]);
    // the host's cursor is where the turns before these start: the `before` the chat pages with
    expect(answer.cursor).toBe("c1");
    expect(answer.metadata).toEqual({ model: "fictional/model-a", reasoning_effort: "high" });
    // the chat is one history for as long as it is open: its older pages join it
    expect(answer.history_id).toBe("s");
    expect(source.key).toBe("host:m:s");
  });

  it("a chat at its beginning says so (cursor null), and a chat without a model has none", async () => {
    answering(hostRead(["t1"], null, { model: null }));
    const answer = await hostSource("local", "s").read();
    expect(answer.cursor).toBeNull();
    expect(answer.metadata).toEqual({ model: null, reasoning_effort: null });
  });

  it("host_source_image_url", () => {
    expect(hostSource("m", "copilotcli:/1").image("t1:0")).toBe("/api/machines/m/host-chats/image?session=copilotcli%3A%2F1&ref=t1%3A0");
    expect(hostSource("local", "s").image("t1:0")).toBe("/api/host-chats/image?session=s&ref=t1%3A0");
  });

  it("toolOutput reads the call's whole output from the host chat", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ output: "FICTIONAL whole" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect(await hostSource("m", "s").toolOutput("call-1")).toBe("FICTIONAL whole");
    expect(urls).toEqual(["/api/machines/m/host-chats/tool-output?session=s&ref=call-1"]);
  });

  it("an older page is only the turns the host put ahead of the ones shown, under the host's next cursor", async () => {
    // the host's read with `before` is its whole loaded window: t1 came in ahead of t2 t3
    const urls = answering(hostRead(["t2", "t3"], "c1"), hostRead(["t1", "t2", "t3"], null));
    const source = hostSource("m", "s");
    await source.read();
    const page = await source.read({ before: "c1" });
    expect(urls[1]).toBe("/api/machines/m/host-chats/chat?session=s&before=c1");
    expect(texts(page)).toEqual(["FICTIONAL ask t1", "FICTIONAL answer t1"]);
    expect(page.cursor).toBeNull();
    expect(page.history_id).toBe("s");
  });

  it("a newest read held `from` an older page's start is the turns after it, and answers that very cursor", async () => {
    answering(hostRead(["t2", "t3"], "c1"), hostRead(["t1", "t2", "t3"], null), hostRead(["t1", "t2", "t3", "t4"], null));
    const source = hostSource("m", "s");
    await source.read();
    await source.read({ before: "c1" });
    const newest = await source.read({ from: "c1" });
    // no turn twice: t1 sits in the older page, the newest starts at t2 and has the new t4
    expect(texts(newest)).toEqual(["FICTIONAL ask t2", "FICTIONAL answer t2", "FICTIONAL ask t3", "FICTIONAL answer t3", "FICTIONAL ask t4", "FICTIONAL answer t4"]);
    // the same cursor back: nothing to fill in between
    expect(newest.cursor).toBe("c1");
  });

  it("a window that restarts with a cursor (the host restarted) is the newest page from then on, not a shrunk page at the beginning", async () => {
    answering(hostRead(["t1", "t2", "t3"], null), hostRead(["t3"], "c9"), hostRead(["t2", "t3"], "c8"));
    const source = hostSource("m", "s");
    expect((await source.read()).cursor).toBeNull();
    const restarted = await source.read();
    expect(texts(restarted)).toEqual(["FICTIONAL ask t3", "FICTIONAL answer t3"]);
    // the older turns are reachable again: through the new window's cursor
    expect(restarted.cursor).toBe("c9");
    const older = await source.read({ before: "c9" });
    expect(texts(older)).toEqual(["FICTIONAL ask t2", "FICTIONAL answer t2"]);
  });

  it("anchored at the chat's beginning, a window that gets a cursor or a turn ahead of its first is read from again", async () => {
    // the first turn stays, but the host now says there are turns before it
    answering(hostRead(["t1", "t2"], null), hostRead(["t1", "t2", "t3"], "c5"));
    let source = hostSource("m", "s");
    await source.read();
    const cursored = await source.read();
    expect(cursored.cursor).toBe("c5");
    expect(cursored.turns).toHaveLength(6);
    // a turn came in ahead of the first one shown (the window grew back): no turn is left out of reach
    answering(hostRead(["t1", "t2"], null), hostRead(["t0", "t1", "t2"], null));
    source = hostSource("m", "s");
    await source.read();
    const grownBack = await source.read();
    expect(texts(grownBack)[0]).toBe("FICTIONAL ask t0");
    expect(grownBack.cursor).toBeNull();
  });

  it("a newest page whose first turn is gone from the chat is read from the window the host has now", async () => {
    answering(hostRead(["t2", "t3"], "c1"), hostRead(["x9"], "c7"));
    const source = hostSource("m", "s");
    await source.read();
    const replaced = await source.read();
    expect(texts(replaced)).toEqual(["FICTIONAL ask x9", "FICTIONAL answer x9"]);
    expect(replaced.cursor).toBe("c7");
  });

  it("a window read with no turn but a cursor is no anchor: the next read's window is the newest page", async () => {
    answering(hostRead([], "c1"), hostRead(["t5"], "c2"));
    const source = hostSource("m", "s");
    expect((await source.read()).cursor).toBe("c1");
    const next = await source.read();
    expect(texts(next)).toEqual(["FICTIONAL ask t5", "FICTIONAL answer t5"]);
    expect(next.cursor).toBe("c2");
  });

  it("a newest page anchored at the window's beginning keeps it while that turn stays, and an empty chat anchors on its first turn", async () => {
    answering(hostRead([], null), hostRead(["t1"], null), hostRead(["t1", "t2"], null));
    const source = hostSource("m", "s");
    expect((await source.read()).turns).toEqual([]);
    expect(texts(await source.read())).toEqual(["FICTIONAL ask t1", "FICTIONAL answer t1"]);
    const grown = await source.read();
    expect(grown.turns).toHaveLength(4);
    expect(grown.cursor).toBeNull();
  });

  it("a cursor whose turn the chat no longer holds is a changed history (409), so the chat reads it again", async () => {
    answering(hostRead(["t2", "t3"], "c1"), hostRead(["x9"], null));
    const source = hostSource("m", "s");
    await source.read();
    const failed = await source.read({ from: "c1" }).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(409);
    expect(await source.read({ from: "unknown" }).catch((cause: unknown) => (cause as ApiError).status)).toBe(409);
  });

  it("each read is handed to the screen's listeners: the title, the prompt and the pills read it there", async () => {
    answering(hostRead(["t1"], null, { title: "FICTIONAL heard" }));
    const source = hostSource("m", "s");
    const heard: string[] = [];
    const stop = source.onRead((read) => heard.push(read.title));
    await source.read();
    stop();
    await source.read();
    expect(heard).toEqual(["FICTIONAL heard"]);
    expect(source.last()?.title).toBe("FICTIONAL heard");
  });

  it("onChange: this chat's push, its PC's host coming up and a resume; not another chat's or PC's", () => {
    const source = hostSource("m", "s");
    let changes = 0;
    const stop = source.onChange!(() => { changes += 1; });
    noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    noteHostChatMessage("m", { type: "host-chat-changed", session: "other" });
    noteHostChatMessage("other-pc", { type: "host-chat-changed", session: "s" });
    noteHostChatMessage("m", { type: "host-chat-state", host: { state: "connected", signed_in: true, protocol: "1" } });
    noteHostChatMessage("m", { type: "host-chat-state", host: { state: "starting" } });
    noteHostChatStreamOpen();
    expect(changes).toBe(3);
    stop();
    noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    noteHostChatStreamOpen();
    expect(changes).toBe(3);
  });

  it("watch holds the bridge's lease: asked at once, renewed every 30 s while on, never after off", () => {
    jest.useFakeTimers();
    const urls = answering(hostRead([], null));
    const source = hostSource("m", "s");
    const watches = () => urls.filter((url) => url.startsWith("POST /api/machines/m/host-chats/chat/watch")).length;
    expect(HOST_WATCH_MS).toBe(30_000);
    source.watch!(true);
    expect(watches()).toBe(1);
    jest.advanceTimersByTime(HOST_WATCH_MS - 1);
    expect(watches()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(watches()).toBe(2);
    // a second holder (StrictMode's double effect) shares the one lease
    source.watch!(true);
    source.watch!(false);
    jest.advanceTimersByTime(HOST_WATCH_MS);
    expect(watches()).toBe(3);
    source.watch!(false);
    jest.advanceTimersByTime(HOST_WATCH_MS * 3);
    expect(watches()).toBe(3);
    expect(urls.find((url) => url.includes("chat/watch"))).toBe('POST /api/machines/m/host-chats/chat/watch {"session":"s"}');
  });
});

/** The browser timer ChatView's refresh lane uses, advanced without sleeping or a DOM. */
function laneClock(): { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => { clock.mockRestore(); };
  globals.window = {
    setTimeout(callback: () => void, delay: number): number { const id = next++; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number | undefined): void { if (id !== undefined) timers.delete(id); },
  };
  return {
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

const settle = async (): Promise<void> => { for (let step = 0; step < 20; step++) await Promise.resolve(); };

describe("a host chat's pushes in ChatView's lane", () => {
  it("pushes during one read make exactly one more read, however many come", async () => {
    const clock = laneClock();
    const held: (() => void)[] = [];
    let reads = 0;
    globalThis.fetch = (async () => {
      reads += 1;
      await new Promise<void>((resolve) => held.push(resolve));
      return new Response(JSON.stringify(hostRead(["t1"], null)), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    // wired as ChatView wires a source: its reader on the lane, its changes refreshing it
    const source = hostSource("m", "s");
    const lane = new ConversationRefresh();
    lane.setPushes(true);
    lane.setRead(async () => { await source.read().catch(() => undefined); });
    const stop = source.onChange(() => lane.refresh());
    lane.refresh();
    await settle();
    expect(reads).toBe(1);
    for (let push = 0; push < 10; push++) noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    noteHostChatStreamOpen();
    await settle();
    expect(reads).toBe(1);
    held.shift()!();
    await settle();
    expect(reads).toBe(2);
    held.shift()!();
    await settle();
    expect(reads).toBe(2);
    // idle again: the next push reads at once
    noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    await settle();
    expect(reads).toBe(3);
    held.shift()!();
    await settle();
    // a failed read does not stop the one after it
    globalThis.fetch = (async () => { reads += 1; throw new TypeError("FICTIONAL offline"); }) as unknown as typeof fetch;
    noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    await settle();
    noteHostChatMessage("m", { type: "host-chat-changed", session: "s" });
    await settle();
    expect(reads).toBe(5);
    stop();
    lane.stop();
    clock.advance(60_000);
    expect(reads).toBe(5);
  });
});

describe("paneSource", () => {
  it("pane_source_matches_today", async () => {
    const calls: unknown[][] = [];
    const answer = { source: "claude-transcript", turns: [], cursor: null } as ConversationResponse;
    const api = { fetchPaneConversation: async (...args: unknown[]) => { calls.push(args); return answer; } } as unknown as MachineApi;
    const source = paneSource("local", "w1:p1", api);
    expect(await source.read()).toBe(answer);
    await source.read({ before: "c:1", since: "c:0" });
    await source.read({ from: "c:1" });
    expect(calls).toEqual([["w1:p1", undefined], ["w1:p1", { before: "c:1", since: "c:0" }], ["w1:p1", { from: "c:1" }]]);
    // the pane's memory key is the one the chat has always kept it under (paneStorageId)
    expect(source.key).toBe("w1:p1");
    expect(paneSource("desk pc", "w1:p1", api).key).toBe("remote:desk%20pc:w1%3Ap1");
    expect(source.image("img-1")).toBe("/api/pane/conversation/image?pane_id=w1%3Ap1&ref=img-1");
    expect(paneSource("desk", "w1:p1", api).image("img-1")).toBe("/api/machines/desk/pane/conversation/image?pane_id=w1%3Ap1&ref=img-1");
    // no lease, no pushes of its own: the pane's conversation-watch and pushes stay with PaneTerminal
    expect(source.watch).toBeUndefined();
    expect(source.onChange).toBeUndefined();
  });

  it("toolOutput fetches the pane's tool-output URL as text, with the caller's signal", async () => {
    const asked: { url: string; signal: AbortSignal | null | undefined }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), signal: init?.signal });
      return new Response("FICTIONAL whole");
    }) as typeof fetch;
    const controller = new AbortController();
    const api = {} as MachineApi;
    expect(await paneSource("desk", "w1:p1", api).toolOutput("ref 1", controller.signal)).toBe("FICTIONAL whole");
    expect(asked).toEqual([{ url: "/api/machines/desk/pane/conversation/tool-output?pane_id=w1%3Ap1&ref=ref+1", signal: controller.signal }]);
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await paneSource("local", "w1:p1", api).toolOutput("x").catch(() => "failed")).toBe("failed");
  });
});

describe("keptContext", () => {
  const usage = (n: number) => ({ currentTokens: n }) as unknown as NonNullable<HostChatRead["context"]>;
  it("keeps a chat's last breakdown at module scope, so a chat view keyed per session finds it again after a remount", () => {
    forgetKeptContexts();
    const first = usage(100);
    expect(keepContext("mac", "s1", first, 1000)).toEqual({ usage: first, at: 1000 });
    // the bridge reads none while the chat works: what was kept stands
    expect(keepContext("mac", "s1", null, 2000)).toEqual({ usage: first, at: 1000 });
    // the same breakdown again keeps its first time; a new one replaces it
    expect(keepContext("mac", "s1", first, 3000)?.at).toBe(1000);
    const next = usage(200);
    expect(keepContext("mac", "s1", next, 4000)).toEqual({ usage: next, at: 4000 });
    // another chat, or the same session on another PC, is kept apart
    expect(keepContext("mac", "s2", null, 5000)).toBeNull();
    expect(keepContext("pc", "s1", null, 5000)).toBeNull();
  });
});
