import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HostChatRead, HostChatRow } from "../../shared/host-chats.ts";
import { readFileSync } from "node:fs";
import { ApiError } from "./api.ts";
import { HOST_ATTEMPT_TTL_MS, contextMeter, hostChatLive, hostStatusLine, openHostChatClosed, readsOnView, type HostPc } from "./hostChats.ts";
import { archiveHostChat, deleteHostChat, markHostChatRead, renameHostChat } from "./hostChats.ts";
import { attemptFor, choose, chosenFor, createHostChat, fetchHostChats, fetchHostState, folderChoices, groupModels, hostLine, isHostChatsOff, keepHostDraft, readHostDraft, fetchHostChat, sendErrorText, sendHost, stopHost, removeHostPending, noteHostChatMessage, noteHostChatStreamOpen, onHostChatMessage, sessionForFolder, HostPcs, settleChoice, takeHostChatEvent, type HostLast } from "./hostChats.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NONE: HostLast = { model: null, agent: null };
const withoutId = (body: unknown): unknown => { const { id: _, ...rest } = body as Record<string, unknown>; return rest; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const row = (session: string, status: HostChatRow["status"], ageMs: number): HostChatRow => ({
  session, title: session, status, modified_at: new Date(NOW - ageMs).toISOString(), cwd: "/home/user/project", unread: false, archived: false,
});

describe("host chats per PC", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (status: number, body: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return urls;
  };

  it("asks the PC's own bridge for its list and its host", async () => {
    const urls = answer(200, { chats: [row("a", "idle", 0)], host: { state: "starting" } });
    expect((await fetchHostChats("local")).map((r) => r.session)).toEqual(["a"]);
    expect(await fetchHostState("desk")).toEqual({ state: "starting" });
    expect(urls).toEqual(["/api/host-chats/chats", "/api/machines/desk/host-chats/state"]);
  });

  it("tells a PC without the feature from a down host", async () => {
    answer(404, { error: { code: "host_chats_off", message: "off" } });
    const off = await fetchHostChats("desk").catch((error: unknown) => error);
    expect(isHostChatsOff(off)).toBe(true);
    answer(503, { error: { code: "agent_host_down", message: "down" }, host: { state: "no_server" } });
    const down = await fetchHostChats("desk").catch((error: unknown) => error);
    expect(isHostChatsOff(down)).toBe(false);
  });

  it("says what a host that is not ready needs, and nothing for a signed-in one", () => {
    const t = (key: string, vars?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
    expect(hostLine({ state: "connected", signed_in: true, protocol: "1.0.0" }, t)).toBeNull();
    expect(hostLine({ state: "off" }, t)).toBeNull();
    expect(hostLine({ state: "connected", signed_in: false, protocol: "1.0.0" }, t)).toBe("The agent host on this PC is not signed in to Copilot");
    expect(hostLine({ state: "refused", server_version: "2.0.0" }, t)).toBe("The agent host refused this app's protocol (it speaks 2.0.0)");
    expect(hostLine({ state: "no_server" }, t)).toBe("No agent host on this PC");
    expect(hostLine({ state: "unsupported" }, t)).toBe("The agent host is not supported on Windows yet");
    expect(hostLine({ state: "starting" }, t)).toBe("Starting the agent host…");
    // a PC that leaves the start to something else waits for the host to come up
    expect(hostLine({ state: "waiting" }, t)).toBe("Starting the agent host…");
  });
});

describe("the phone's model and agent choice", () => {
  const realFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let session: Map<string, string>;
  beforeEach(() => {
    session = new Map();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => { session.set(key, value); },
        removeItem: (key: string) => { session.delete(key); },
      } },
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const record = (status: number, body: unknown) => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
  };

  it("a choice is kept per chat, through a failed send and a sent one, until a read shows the chat uses it", async () => {
    expect(chosenFor("desk", "s1")).toEqual({});
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" } });
    choose("desk", "s1", { agent: "file:///tmp/fictional/agents/Report.agent.md" });
    expect(chosenFor("desk", "s1")).toEqual({ model: { id: "fictional/model-b", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md" });
    // another chat, or the same session on another PC, has no choice of its own
    expect(chosenFor("desk", "s2")).toEqual({});
    expect(chosenFor("laptop", "s1")).toEqual({});
    expect(session.has("herdr-web-ui:host-chat-choice:desk:s1")).toBe(true);
    // a send that fails keeps it for the user's next tap
    record(502, { error: { code: "agent_host_failed", message: "down" } });
    await expect(sendHost("desk", { session: "s1", text: "FICTIONAL hello" }, NONE)).rejects.toThrow();
    expect(chosenFor("desk", "s1").model?.id).toBe("fictional/model-b");
    record(200, { queued: false });
    expect(await sendHost("desk", { session: "s1", text: "FICTIONAL hello" }, NONE)).toEqual({ queued: false });
    // a read a moment behind (the chat's last is still the old one) keeps it
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-a", effort: null }, agent: null }).model?.id).toBe("fictional/model-b");
    // a read naming only the model as used keeps the whole pick
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: null }).agent).toBe("file:///tmp/fictional/agents/Report.agent.md");
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md" })).toEqual({});
    expect(session.has("herdr-web-ui:host-chat-choice:desk:s1")).toBe(false);
  });

  it("sendHost carries the mode; stopHost and removeHostPending post their routes", async () => {
    let calls = record(200, { queued: true, joined: true });
    expect(await sendHost("desk", { session: "s1", text: "FICTIONAL steer", mode: "steer" }, NONE)).toEqual({ queued: true, joined: true });
    expect(calls[0]).toMatchObject({ url: "/api/machines/desk/host-chats/chat/send", body: { session: "s1", text: "FICTIONAL steer", mode: "steer" } });
    calls = record(200, { ok: true });
    await stopHost("desk", "s1");
    await removeHostPending("desk", "s1", "p1");
    expect(calls).toEqual([
      { url: "/api/machines/desk/host-chats/chat/stop", body: { session: "s1" } },
      { url: "/api/machines/desk/host-chats/chat/pending/remove", body: { session: "s1", id: "p1" } },
    ]);
  });

  it("createHostChat posts once and answers the session; the text and choice wait in the chat when the first message did not go", async () => {
    const body = { id: "00000000-0000-4000-8000-000000000001", cwd: "/tmp/fictional-repo", text: "FICTIONAL first", model: { id: "fictional/model-b", effort: "high" }, agent: null };
    let calls = record(200, { session: "s-new" });
    expect(await createHostChat("desk", body)).toBe("s-new");
    expect(calls).toEqual([{ url: "/api/machines/desk/host-chats/chat/new", body }]);
    expect(readHostDraft("desk", "s-new")).toBe("");
    expect(chosenFor("desk", "s-new")).toEqual({});
    // created, but its first message did not go: the chat opens with the words in its box, never re-sent
    calls = record(200, { session: "s-kept", sent: false });
    expect(await createHostChat("desk", body)).toBe("s-kept");
    expect(calls).toHaveLength(1);
    expect(readHostDraft("desk", "s-kept")).toBe("FICTIONAL first");
    expect(chosenFor("desk", "s-kept")).toEqual({ model: { id: "fictional/model-b", effort: "high" }, agent: null });
    // refused before anything was made: it throws, and nothing is kept anywhere
    calls = record(503, { error: { code: "agent_host_down", message: "FICTIONAL host down" } });
    await expect(createHostChat("desk", { id: "00000000-0000-4000-8000-000000000002", cwd: "/tmp/fictional-repo", text: "FICTIONAL other" })).rejects.toThrow("FICTIONAL host down");
    expect(calls).toHaveLength(1);
  });

  it("every send carries what the pills show: a pick, then the same pick again on the next message", async () => {
    const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT });
    const calls = record(200, { queued: false });
    const before: HostLast = { model: { id: "fictional/model-a", effort: null }, agent: null };
    await sendHost("desk", { session: "s1", text: "FICTIONAL one" }, before);
    // the read after the send: the chat's last is now the pick, which is let go
    const after: HostLast = { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT };
    expect(settleChoice("desk", "s1", after)).toEqual({});
    await sendHost("desk", { session: "s1", text: "FICTIONAL two" }, after);
    const carried = { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT };
    expect(calls.map((each) => withoutId(each.body))).toEqual([{ session: "s1", text: "FICTIONAL one", ...carried }, { session: "s1", text: "FICTIONAL two", ...carried }]);
  });

  it("with no pick, every send carries the chat's last model and agent; Agent and no model go as absent", async () => {
    const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
    const calls = record(200, { queued: true });
    expect(await sendHost("desk", { session: "s1", text: "FICTIONAL next" }, { model: { id: "fictional/model-a", effort: "low" }, agent: REPORT })).toEqual({ queued: true });
    await sendHost("desk", { session: "s1", text: "FICTIONAL again" }, { model: { id: "fictional/model-a", effort: null }, agent: null });
    await sendHost("desk", { session: "s1", text: "FICTIONAL bare" }, NONE);
    expect(calls.map((each) => withoutId(each.body))).toEqual([
      { session: "s1", text: "FICTIONAL next", model: { id: "fictional/model-a", effort: "low" }, agent: REPORT },
      { session: "s1", text: "FICTIONAL again", model: { id: "fictional/model-a" } },
      { session: "s1", text: "FICTIONAL bare" },
    ]);
    // a pick of "Agent" over a chat that used Report: no agent goes
    choose("desk", "s1", { agent: null });
    await sendHost("desk", { session: "s1", text: "FICTIONAL plain" }, { model: null, agent: REPORT });
    expect(withoutId(calls.at(-1)?.body)).toEqual({ session: "s1", text: "FICTIONAL plain" });
  });
  it("a retry of the same words reuses the send's id, even after leaving the screen; new words or a sent message mint a new one", async () => {
    const ids = (calls: { body: unknown }[]) => calls.map((each) => (each.body as { id: string }).id);
    let calls = record(502, { error: { code: "bad_gateway", message: "FICTIONAL proxy" } });
    await expect(sendHost("desk", { session: "s1", text: "FICTIONAL once" }, NONE)).rejects.toThrow();
    await expect(sendHost("desk", { session: "s1", text: " FICTIONAL once " }, NONE)).rejects.toThrow();
    const [first, retry] = ids(calls);
    expect(first).toMatch(UUID);
    expect(retry).toBe(first);
    // kept with the chat (sessionStorage), not the screen; another chat has its own
    expect(session.has("herdr-web-ui:host-chat-send:desk:s1")).toBe(true);
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s2", text: "FICTIONAL once" }, NONE);
    expect(ids(calls)[0]).not.toBe(first);
    // changed words: a new id
    calls = record(502, {});
    await expect(sendHost("desk", { session: "s1", text: "FICTIONAL once, edited" }, NONE)).rejects.toThrow();
    const edited = ids(calls)[0];
    expect(edited).not.toBe(first);
    // sent: the next message, even with the same words, is a new one
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s1", text: "FICTIONAL once, edited" }, NONE);
    expect(ids(calls)[0]).toBe(edited);
    expect(session.has("herdr-web-ui:host-chat-send:desk:s1")).toBe(false);
    await sendHost("desk", { session: "s1", text: "FICTIONAL once, edited" }, NONE);
    expect(ids(calls)[1]).not.toBe(edited);
    expect(ids(calls)[1]).toMatch(UUID);
  });

  it("an attempt whose answer was lost is let go once a read shows its id: the same words later are a new message", async () => {
    let calls = record(502, { error: { code: "bad_gateway", message: "FICTIONAL proxy" } });
    await expect(sendHost("desk", { session: "s1", text: "yes" }, NONE)).rejects.toThrow();
    const lost = (calls[0]!.body as { id: string }).id;
    // the user sees the turn in the chat (it went) and does not retry
    calls = record(200, { session: "s1", title: "t", status: "idle", turns: [], cursor: null, prompt: null, model: null, agent: null, busy: false, signature: "x", message_ids: [crypto.randomUUID(), lost] });
    await fetchHostChat("desk", "s1");
    expect(session.has("herdr-web-ui:host-chat-send:desk:s1")).toBe(false);
    // later, the same words: a new message, under a new id
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s1", text: "yes" }, NONE);
    const next = (calls[0]!.body as { id: string }).id;
    expect(next).toMatch(UUID);
    expect(next).not.toBe(lost);
  });

  it("a read that does not show the attempt's id keeps it for the retry", async () => {
    let calls = record(502, {});
    await expect(sendHost("desk", { session: "s1", text: "yes" }, NONE)).rejects.toThrow();
    const lost = (calls[0]!.body as { id: string }).id;
    record(200, { session: "s1", title: "t", status: "idle", turns: [], cursor: null, prompt: null, model: null, agent: null, busy: false, signature: "x", message_ids: [crypto.randomUUID()] });
    await fetchHostChat("desk", "s1");
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s1", text: "yes" }, NONE);
    expect((calls[0]!.body as { id: string }).id).toBe(lost);
  });

  it("an attempt older than its TTL is not reused: a retry after it mints a new id", async () => {
    let calls = record(502, {});
    await expect(sendHost("desk", { session: "s1", text: "yes" }, NONE)).rejects.toThrow();
    const lost = (calls[0]!.body as { id: string }).id;
    const key = "herdr-web-ui:host-chat-send:desk:s1";
    const stored = JSON.parse(session.get(key)!) as Record<string, unknown>;
    session.set(key, JSON.stringify({ ...stored, at: Date.now() - HOST_ATTEMPT_TTL_MS - 1 }));
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s1", text: "yes" }, NONE);
    expect((calls[0]!.body as { id: string }).id).not.toBe(lost);
    // an attempt with no time on it (an older bundle's) is not trusted either
    calls = record(502, {});
    await expect(sendHost("desk", { session: "s1", text: "again" }, NONE)).rejects.toThrow();
    const untimed = (calls[0]!.body as { id: string }).id;
    session.set(key, JSON.stringify({ key: "again", id: untimed }));
    calls = record(200, { queued: false });
    await sendHost("desk", { session: "s1", text: "again" }, NONE);
    expect((calls[0]!.body as { id: string }).id).not.toBe(untimed);
    expect(HOST_ATTEMPT_TTL_MS).toBe(10 * 60_000);
  });

  it("attemptFor keeps the id for the same key and mints one for another", () => {
    let n = 0;
    const mint = () => `id-${++n}`;
    const a = attemptFor(null, "k", mint);
    expect(attemptFor(a, "k", mint)).toBe(a);
    expect(attemptFor(a, "other", mint)).toEqual({ key: "other", id: "id-2" });
  });

  it("a failure that may have gone out says to send again; any other keeps its reason", () => {
    const t = (key: string, vars?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
    const unsure = "Couldn't confirm it was sent. Send again: it won't go twice.";
    expect(sendErrorText(new ApiError("/x", 502, "FICTIONAL proxy", null), t)).toBe(unsure);
    expect(sendErrorText(new ApiError("/x", 504, "FICTIONAL slow", null), t)).toBe(unsure);
    expect(sendErrorText(new TypeError("Failed to fetch"), t)).toBe(unsure);
    expect(sendErrorText(new ApiError("/x", 503, "FICTIONAL host down", "agent_host_down"), t)).toBe("Not sent: FICTIONAL host down");
    expect(sendErrorText(new ApiError("/x", 400, "FICTIONAL bad", "invalid_id"), t, true)).toBe("FICTIONAL bad");
  });

  // a POST held open until the test lets it answer
  const held = () => {
    const calls: unknown[] = [];
    let answer: (response: Response) => void = () => undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { answer = resolve; });
    }) as typeof fetch;
    return { calls, resolve: () => answer(new Response(JSON.stringify({ queued: false }), { status: 200, headers: { "content-type": "application/json" } })) };
  };

  it("a pick made while a send is on its way is kept for the next one", async () => {
    choose("desk", "s1", { model: { id: "fictional/model-a" } });
    const post = held();
    const sent = sendHost("desk", { session: "s1", text: "FICTIONAL hello" }, NONE);
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" } });
    post.resolve();
    await sent;
    expect(post.calls.map(withoutId)).toEqual([{ session: "s1", text: "FICTIONAL hello", model: { id: "fictional/model-a" } }]);
    expect(chosenFor("desk", "s1")).toEqual({ model: { id: "fictional/model-b", effort: "high" } });
  });

  it("the composer's draft is kept per chat and let go by the send that carried it, screen or not", async () => {
    expect(readHostDraft("desk", "s1")).toBe("");
    keepHostDraft("desk", "s1", "FICTIONAL draft");
    expect(readHostDraft("desk", "s1")).toBe("FICTIONAL draft");
    expect(readHostDraft("desk", "s2")).toBe("");
    // a failed send keeps it
    record(503, { error: { code: "agent_host_down", message: "down" } });
    await expect(sendHost("desk", { session: "s1", text: "FICTIONAL draft" }, NONE)).rejects.toThrow();
    expect(readHostDraft("desk", "s1")).toBe("FICTIONAL draft");
    // the chat left while the send is on its way (no screen clears anything): the sent words do not come back
    const post = held();
    const sent = sendHost("desk", { session: "s1", text: "FICTIONAL draft" }, NONE);
    post.resolve();
    await sent;
    expect(readHostDraft("desk", "s1")).toBe("");
    expect(session.has("herdr-web-ui:host-chat-draft:desk:s1")).toBe(false);
  });

  it("words typed while a send is on its way stay in the draft", async () => {
    keepHostDraft("desk", "s1", "FICTIONAL first");
    const post = held();
    const sent = sendHost("desk", { session: "s1", text: "FICTIONAL first" }, NONE);
    keepHostDraft("desk", "s1", "FICTIONAL first and more");
    post.resolve();
    await sent;
    expect(readHostDraft("desk", "s1")).toBe("FICTIONAL first and more");
  });
});

describe("the new chat's folders", () => {
  it("folderChoices dedupes, orders by newest chat, caps at 8, drops null", () => {
    const at = (session: string, cwd: string | null, ageMs: number): HostChatRow => ({ ...row(session, "idle", ageMs), cwd });
    const rows = [
      at("a", "/tmp/fictional/old", 9 * DAY),
      at("b", "/tmp/fictional/new", 1000),
      at("c", null, 0),
      at("d", "/tmp/fictional/old", 2000),
      at("e", "/tmp/fictional/new", 5 * DAY),
      ...Array.from({ length: 9 }, (_, i) => at(`f${i}`, `/tmp/fictional/f${i}`, (i + 1) * DAY)),
    ];
    expect(folderChoices(rows)).toEqual(["/tmp/fictional/new", "/tmp/fictional/old", "/tmp/fictional/f0", "/tmp/fictional/f1", "/tmp/fictional/f2", "/tmp/fictional/f3", "/tmp/fictional/f4", "/tmp/fictional/f5"]);
    expect(folderChoices([at("x", null, 0)])).toEqual([]);
  });

  it("sessionForFolder: the newest chat in the folder, else the PC's newest, else none", () => {
    const at = (session: string, cwd: string | null, ageMs: number): HostChatRow => ({ ...row(session, "idle", ageMs), cwd });
    const rows = [at("old-in", "/tmp/fictional/a", 3 * DAY), at("new-in", "/tmp/fictional/a", DAY), at("newest", "/tmp/fictional/b", 1000)];
    expect(sessionForFolder(rows, "/tmp/fictional/a")).toBe("new-in");
    expect(sessionForFolder(rows, "/tmp/fictional/elsewhere")).toBe("newest");
    expect(sessionForFolder([], "/tmp/fictional/a")).toBeNull();
  });
});

describe("the picker's model groups", () => {
  it("groups by the id's provider, the host's own models first as Copilot (provider null)", () => {
    const model = (id: string) => ({ id, name: id, provider: "copilotcli", efforts: null, context: null });
    const groups = groupModels([model("fictional/model-a"), model("own-1"), model("other/model-c"), model("fictional/model-b"), model("own-2")]);
    expect(groups.map((group) => [group.provider, group.models.map((each) => each.id)])).toEqual([
      [null, ["own-1", "own-2"]],
      ["fictional", ["fictional/model-a", "fictional/model-b"]],
      ["other", ["other/model-c"]],
    ]);
    expect(groupModels([model("fictional/model-a")]).map((group) => group.provider)).toEqual(["fictional"]);
  });
});

describe("the pushes", () => {
  it("a host chat event is taken before the pane bookkeeping and goes to the listeners of a known PC only", () => {
    const heard: string[] = [];
    const stop = onHostChatMessage((machineId, message) => { heard.push(`${machineId} ${message.type}`); });
    try {
      const known = (id: string) => id === "desk";
      const changed = { type: "machine-message", machine_id: "desk", message: { type: "host-chat-changed", session: "s1" } } as const;
      expect(takeHostChatEvent(changed, known)).toBe(true);
      expect(takeHostChatEvent({ ...changed, machine_id: "gone" }, known)).toBe(true);
      expect(takeHostChatEvent({ type: "machine-message", machine_id: "desk", message: { type: "host-chat-state", host: { state: "starting" } } }, known)).toBe(true);
      expect(heard).toEqual(["desk host-chat-changed", "desk host-chat-state"]);
      // anything else is the stream's own
      expect(takeHostChatEvent({ type: "machine-message", machine_id: "desk", message: { type: "session-changed" } as never }, known)).toBe(false);
      expect(takeHostChatEvent({ type: "machines", machines: [] }, known)).toBe(false);
    } finally { stop(); }
  });

  it("App.tsx's event stream hands host chat events over before it invalidates the pane snapshots", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const handler = app.slice(app.indexOf('new EventSource("/api/machines/events")'));
    const taken = handler.indexOf("if (takeHostChatEvent(");
    const invalidated = handler.indexOf("snapshotRequests.current.invalidate()");
    expect(taken).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(taken);
    expect(handler.slice(taken, handler.indexOf("\n", taken))).toContain(") return;");
  });
});

async function until(ready: () => boolean, ms = 2_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out");
}

describe("each PC's group (HostPcs)", () => {
  const realFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let page: EventTarget & { visibilityState: string };
  beforeEach(() => {
    page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const CONNECTED = { state: "connected", signed_in: true, protocol: "1.0.0" } as const;
  /** Each PC answers state and chats as `answer` says at the time of the call; every URL is kept. */
  const serve = (answer: (machine: string, route: string) => { status: number; body: unknown }) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const [, machine, route] = url.match(/^\/api\/machines\/([^/]+)\/host-chats\/(.*)$/) ?? [];
      const { status, body } = answer(machine!, route!);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return urls;
  };
  const ok = (route: string) => ({ status: 200, body: route === "state" ? { host: CONNECTED } : { chats: [row("c1", "idle", 0)] } });

  it("a 502 on a PC's first read shows no group; a later success shows it", async () => {
    let failing = true;
    serve((_, route) => failing ? { status: 502, body: { error: { code: "bad_gateway", message: "FICTIONAL proxy" } } } : ok(route));
    const pcs = new HostPcs();
    const stop = pcs.listen();
    try {
      pcs.setRoster(["desk"]);
      await pcs.idle();
      expect(pcs.get().has("desk")).toBe(false);
      // a 504 and a network failure are no "on" either
      serve(() => ({ status: 504, body: { error: { code: "timeout", message: "FICTIONAL slow" } } }));
      pcs.resume();
      await pcs.idle();
      expect(pcs.get().has("desk")).toBe(false);
      failing = false;
      serve((_, route) => failing ? { status: 502, body: {} } : ok(route));
      noteHostChatStreamOpen();
      await until(() => pcs.get().has("desk"));
      expect(pcs.get().get("desk")).toEqual({ host: CONNECTED, chats: [row("c1", "idle", 0)] });
      // shown, a transient failure keeps what it shows
      serve(() => ({ status: 502, body: { error: { code: "bad_gateway", message: "FICTIONAL proxy" } } }));
      pcs.resume();
      await pcs.idle();
      expect(pcs.get().get("desk")?.chats.map((r) => r.session)).toEqual(["c1"]);
    } finally { stop(); }
  });

  it("a host that is down (503 agent_host_down) gets a group; host_chats_off gets none and is not asked again until the roster changes", async () => {
    serve((machine, route) => machine === "desk"
      ? route === "state" ? { status: 200, body: { host: { state: "no_server" } } } : { status: 503, body: { error: { code: "agent_host_down", message: "down" }, host: { state: "no_server" } } }
      : { status: 404, body: { error: { code: "host_chats_off", message: "off" } } });
    const pcs = new HostPcs();
    pcs.setRoster(["desk", "laptop"]);
    await until(() => pcs.get().has("desk"));
    expect(pcs.get().get("desk")).toEqual({ host: { state: "no_server" }, chats: [], stale: true });
    // the state read failing with the host down still makes the group
    const urls = serve((machine) => machine === "desk" ? { status: 503, body: { error: { code: "agent_host_down", message: "down" }, host: { state: "starting" } } } : { status: 404, body: { error: { code: "host_chats_off", message: "off" } } });
    pcs.setRoster(["desk", "laptop"]);
    await pcs.idle();
    expect(pcs.get().has("desk")).toBe(true);
    expect(pcs.get().has("laptop")).toBe(false);
    urls.length = 0;
    pcs.resume();
    await pcs.idle();
    expect(urls.some((url) => url.includes("/laptop/"))).toBe(false);
  });

  it("reads every PC's list again when the page is shown again and when the event stream reopens", async () => {
    const urls = serve((_, route) => ok(route));
    const pcs = new HostPcs();
    const stop = pcs.listen();
    try {
      pcs.setRoster(["desk"]);
      await until(() => pcs.get().has("desk"));
      urls.length = 0;
      // hidden: nothing
      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
      await pcs.idle();
      expect(urls).toEqual([]);
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
      await until(() => urls.length === 2);
      expect(urls.sort()).toEqual(["/api/machines/desk/host-chats/chats", "/api/machines/desk/host-chats/state"]);
      urls.length = 0;
      noteHostChatStreamOpen();
      await until(() => urls.length === 2);
      // a list push reads it too; one chat's change does not
      urls.length = 0;
      noteHostChatMessage("desk", { type: "host-chat-changed", session: "c1" });
      await pcs.idle();
      expect(urls).toEqual([]);
      noteHostChatMessage("desk", { type: "host-chat-changed", session: null });
      await until(() => urls.length === 2);
    } finally { stop(); }
    // stopped: resumes read nothing
    urls.length = 0;
    noteHostChatStreamOpen();
    page.dispatchEvent(new Event("visibilitychange"));
    await pcs.idle();
    expect(urls).toEqual([]);
  });
});

describe("a chat's actions (rename, read, done, delete)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const CONNECTED = { state: "connected", signed_in: true, protocol: "1.0.0" } as const;
  /** The PC's list and state; each POST answers `post` (a status) and is kept. */
  const serve = (rows: () => HostChatRow[], post: () => number) => {
    const posts: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        const status = post();
        return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: { code: "agent_host_failed", message: "FICTIONAL failed" } }), { status, headers: { "content-type": "application/json" } });
      }
      const body = url.endsWith("/state") ? { host: CONNECTED } : { chats: rows() };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return posts;
  };

  it("posts each action to its route with the session", async () => {
    const posts = serve(() => [], () => 200);
    await renameHostChat("desk", "c1", "FICTIONAL new name");
    await markHostChatRead("desk", "c1", false);
    await archiveHostChat("desk", "c1", true);
    await deleteHostChat("desk", "c1");
    expect(posts).toEqual([
      { url: "/api/machines/desk/host-chats/chat/rename", body: { session: "c1", title: "FICTIONAL new name" } },
      { url: "/api/machines/desk/host-chats/chat/read", body: { session: "c1", read: false } },
      { url: "/api/machines/desk/host-chats/chat/archive", body: { session: "c1", archived: true } },
      { url: "/api/machines/desk/host-chats/chat/delete", body: { session: "c1" } },
    ]);
  });

  it("mark as unread shows at once, and a refusal puts the row back as it was", async () => {
    const listed = [{ ...row("c1", "idle", 0), unread: false }, row("c2", "idle", 1000)];
    let status = 200;
    const posts = serve(() => listed, () => status);
    const pcs = new HostPcs();
    pcs.setRoster(["desk"]);
    await until(() => pcs.get().has("desk"));
    const unread = (): boolean | undefined => pcs.get().get("desk")?.chats.find((r) => r.session === "c1")?.unread;
    let pending = pcs.setRead("desk", "c1", false);
    // optimistic: the row says unread before the bridge has answered
    expect(unread()).toBe(true);
    await pending;
    expect(unread()).toBe(true);
    expect(posts.map((p) => p.body)).toEqual([{ session: "c1", read: false }]);
    // refused: back to read, and the failure goes to the caller (its toast)
    listed[0] = { ...listed[0]!, unread: true };
    status = 502;
    pending = pcs.setRead("desk", "c1", true);
    expect(unread()).toBe(false);
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(unread()).toBe(true);
  });

  it("rename shows at once; done and delete show once the bridge has them, and a read that lags keeps them", async () => {
    let status = 200;
    serve(() => [row("c1", "idle", 0), row("c2", "idle", 1000)], () => status);
    const pcs = new HostPcs();
    pcs.setRoster(["desk"]);
    await until(() => pcs.get().has("desk"));
    const chats = () => pcs.get().get("desk")!.chats;
    await pcs.setArchived("desk", "c1", true);
    expect(chats().find((r) => r.session === "c1")?.archived).toBe(true);
    await pcs.rename("desk", "c1", "FICTIONAL renamed");
    expect(chats().find((r) => r.session === "c1")?.title).toBe("FICTIONAL renamed");
    // done and delete wait for the bridge: a refusal leaves the row (and the open chat) as it was
    status = 502;
    const gone = pcs.remove("desk", "c2");
    expect(chats().map((r) => r.session).sort()).toEqual(["c1", "c2"]);
    await expect(gone).rejects.toBeInstanceOf(ApiError);
    expect(chats().map((r) => r.session).sort()).toEqual(["c1", "c2"]);
    await expect(pcs.setArchived("desk", "c2", true)).rejects.toBeInstanceOf(ApiError);
    expect(chats().find((r) => r.session === "c2")?.archived).toBe(false);
    status = 200;
    const going = pcs.remove("desk", "c2");
    expect(chats().map((r) => r.session).sort()).toEqual(["c1", "c2"]);
    await going;
    expect(chats().map((r) => r.session)).toEqual(["c1"]);
    // a read that has not caught up yet does not bring it back
    pcs.resume();
    await pcs.idle();
    expect(chats().map((r) => r.session)).toEqual(["c1"]);
    expect(chats().find((r) => r.session === "c1")?.title).toBe("FICTIONAL renamed");
  });
});

describe("openHostChatClosed: the open chat is let go only on a positive signal", () => {
  const row = (over: Partial<HostChatRow> = {}): HostChatRow => ({ session: "s", title: "FICTIONAL", status: "idle", modified_at: "2026-01-01T00:00:00.000Z", cwd: "/tmp/fictional-repo", unread: false, archived: false, ...over });
  const up = { state: "connected", signed_in: true, protocol: "1.0.0" } as const;
  it("archived in a listed row closes it", () => {
    expect(openHostChatClosed({ host: up, chats: [row({ archived: true })] }, "s")).toBe(true);
  });
  it("gone from a list read while the host is connected closes it", () => {
    expect(openHostChatClosed({ host: up, chats: [row({ session: "other" })] }, "s")).toBe(true);
  });
  it("host_goes_503_keeps_open_chat: a down host's empty list says nothing", () => {
    expect(openHostChatClosed({ host: { state: "no_server" }, chats: [] }, "s")).toBe(false);
    expect(openHostChatClosed({ host: { state: "waiting" }, chats: [] }, "s")).toBe(false);
  });
  it("a PC no longer listed (left the roster, or host_chats_off) says nothing", () => {
    expect(openHostChatClosed(undefined, "s")).toBe(false);
  });
  it("a connected host whose list read failed (stale) says nothing", () => {
    expect(openHostChatClosed({ host: up, chats: [], stale: true }, "s")).toBe(false);
  });
  it("a PC whose state is not read yet says nothing", () => {
    expect(openHostChatClosed({ host: null, chats: [] }, "s")).toBe(false);
  });
  it("a live listed row stays open", () => {
    expect(openHostChatClosed({ host: up, chats: [row()] }, "s")).toBe(false);
  });
});

describe("HostPcs: a pushed host state is not a list", () => {
  it("state_push_before_list_is_stale: the group shows the pushed state with stale set until its list reads", () => {
    const pcs = new HostPcs();
    pcs.setRoster([]);
    pcs.setRoster(["desk"]);
    pcs.refresh("desk", { state: "connected", signed_in: true, protocol: "1.0.0" });
    expect(pcs.get().get("desk")).toMatchObject({ host: { state: "connected" }, stale: true });
    expect(openHostChatClosed(pcs.get().get("desk"), "fictional-open")).toBe(false);
  });
});

describe("the header's connection chip on a host chat", () => {
  const pc = (host: HostPc["host"], stale = false): HostPc => ({ host, chats: [], ...(stale ? { stale: true as const } : {}) });
  const up = { state: "connected", signed_in: true, protocol: "1.0.0" } as const;
  it("host_chat_header_dot_tracks_its_host: live while its PC's host is connected; a read still loading or failed says so in the chat, not here", () => {
    expect(hostChatLive(pc(up))).toBe(true);
    expect(hostChatLive(pc({ state: "no_server" }))).toBe(false);
    expect(hostChatLive(pc(up, true))).toBe(false);
    expect(hostChatLive(pc(null))).toBe(false);
    expect(hostChatLive(undefined)).toBe(false);
  });
});

describe("what a host chat waits on (VS Code's persistent progress)", () => {
  const words = (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), key);
  const read = (extra: Partial<HostChatRead>): HostChatRead => ({
    session: "s", title: "t", status: "working", turns: [], cursor: null, prompt: null, model: null, agent: null, busy: true, pending: [], commands: [],
    background: { subagents: 0, commands: 0 }, confirmations: 0, context: null, message_ids: [], signature: "x", ...extra,
  });
  const question = { kind: "question" } as unknown as HostChatRead["prompt"];
  it("an open question comes first", () => {
    expect(hostStatusLine(read({ prompt: question, confirmations: 2, background: { subagents: 1, commands: 1 } }), words)).toBe("Waiting for your response");
  });
  it("then pending confirmations, one or more", () => {
    expect(hostStatusLine(read({ confirmations: 1, background: { subagents: 1, commands: 0 } }), words)).toBe("1 confirmation pending");
    expect(hostStatusLine(read({ confirmations: 3 }), words)).toBe("3 confirmations pending");
  });
  it("then background work, as VS Code words it", () => {
    expect(hostStatusLine(read({ background: { subagents: 1, commands: 0 } }), words)).toBe("1 subagent running");
    expect(hostStatusLine(read({ background: { subagents: 2, commands: 0 } }), words)).toBe("2 subagents running");
    expect(hostStatusLine(read({ background: { subagents: 0, commands: 1 } }), words)).toBe("1 background command running");
    expect(hostStatusLine(read({ background: { subagents: 0, commands: 4 } }), words)).toBe("4 background commands running");
    expect(hostStatusLine(read({ background: { subagents: 2, commands: 1 } }), words)).toBe("2 subagents and 1 background command running");
  });
  it("else nothing: the app's working word stands", () => {
    expect(hostStatusLine(read({}), words)).toBeNull();
    // a bridge from before these fields
    const { background: _b, confirmations: _c, context: _x, ...older } = read({});
    expect(hostStatusLine(older as HostChatRead, words)).toBeNull();
  });
});

describe("the context meter", () => {
  it("context_meter_formats: percent · used / limit, in K and M", () => {
    expect(contextMeter({ currentTokens: 84000, tokenLimit: 200000 })).toEqual({ percent: 42, label: "42% · 84K / 200K" });
    expect(contextMeter({ currentTokens: 1500, tokenLimit: 1000000 })).toEqual({ percent: 0, label: "0% · 1.5K / 1M" });
    expect(contextMeter({ currentTokens: 850, tokenLimit: 128000 })).toEqual({ percent: 1, label: "1% · 850 / 128K" });
    // over the window (a long tool output before compaction): said as it is, the bar full
    expect(contextMeter({ currentTokens: 210000, tokenLimit: 200000 })).toEqual({ percent: 100, label: "105% · 210K / 200K" });
  });
  it("context_meter_null_on_bad_usage", () => {
    expect(contextMeter(null)).toBeNull();
    expect(contextMeter({ currentTokens: 5, tokenLimit: 0 })).toBeNull();
    expect(contextMeter({ currentTokens: Number.NaN, tokenLimit: 10 })).toBeNull();
  });
});

describe("an open chat is read", () => {
  const row = (extra: Partial<HostChatRow>): HostChatRow => ({ session: "s", title: "t", status: "idle", modified_at: "2026-01-01T00:00:00.000Z", cwd: "/w", unread: true, archived: false, ...extra } as HostChatRow);
  it("opening_unread_chat_marks_read: opened (nothing seen before) unread and not working", () => {
    expect(readsOnView(undefined, row({}))).toBe(true);
    expect(readsOnView(undefined, row({ status: "asks" }))).toBe(true);
  });
  it("its turn ends while it is on screen: read", () => {
    expect(readsOnView(row({ status: "working", unread: false }), row({ status: "idle" }))).toBe(true);
    expect(readsOnView(row({ status: "working", unread: false }), row({ status: "asks" }))).toBe(true);
  });
  it("marked unread by the user while open: it stays unread; nothing else reads it", () => {
    expect(readsOnView(row({ unread: false }), row({}))).toBe(false);
    expect(readsOnView(row({}), row({}))).toBe(false);
    expect(readsOnView(undefined, row({ status: "working" }))).toBe(false);
    expect(readsOnView(undefined, row({ unread: false }))).toBe(false);
    expect(readsOnView(undefined, undefined)).toBe(false);
  });
});
