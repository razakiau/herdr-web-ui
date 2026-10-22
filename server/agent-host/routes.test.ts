import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChatState, SessionModelInfo, SessionState, SessionSummary, StateAction, ToolCallResult, Turn } from "@microsoft/agent-host-protocol";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { HostChatRead, AgentHostState } from "../../shared/host-chats.ts";
import { descriptorPath, type BridgeDescriptor } from "../bridge.ts";
import { createServer } from "../index.ts";
import { handleMachineRequest } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { AgentHostConnection, AgentHostError } from "./connection.ts";
import { fakeAgentHost, reducedChat, toolCallActions, type FakeAgentHost, type FakeAgentHostSeed } from "./fake-host.ts";
import { LEASE_MS, STOP_AND_SEND_WAIT_MS, hostChatsRoute, type LeaseClock, type AgentHost } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-agent-host-routes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (ready()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const get = (path: string) => new Request(`http://127.0.0.1${path}`);

/** A host that only has a state: every other call fails the test. */
function stub(state: () => AgentHostState): AgentHost {
  const no = (): never => { throw new Error("the stub host has only a state"); };
  return { state, mirror: no, summaries: no, chat: no, watch: no, watching: no, request: no, dispatch: no };
}

// ─── Against a fake agent host, through a real AgentHostConnection ─────────────

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionUri = (n: number) => `copilotcli:/${uuid(n)}`;
const chatUri = (n: number) => `ahp-chat://default/${Buffer.from(sessionUri(n)).toString("base64")}`;
const AT = "2026-01-01T00:00:00.000Z";
const REPORT = "file:///tmp/fictional/agents/Report.agent.md";

const MODEL: SessionModelInfo = {
  id: "fictional/model-a", provider: "copilotcli", name: "Fictional Model A",
  configSchema: { type: "object", properties: { thinkingLevel: { type: "string", title: "Thinking Level", enum: ["low", "medium", "high"] } } },
};

const summary = (n: number): SessionSummary => ({
  resource: sessionUri(n), provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, createdAt: AT, modifiedAt: `2026-01-01T00:00:0${n}.000Z`,
  workingDirectories: ["file:///tmp/fictional-repo"], defaultChat: chatUri(n),
});

const sessionState = (n: number): SessionState => ({
  provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, lifecycle: "ready", activeClients: [],
  chats: [{ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT }], defaultChat: chatUri(n),
  workingDirectories: ["file:///tmp/fictional-repo"],
  customizations: [{ id: "dir", type: "directory", name: "agents", uri: "file:///tmp/fictional/agents", enabled: true, contents: "agent", writable: false, children: [
    { id: "Report", type: "agent", name: "Report", uri: REPORT, enabled: true, description: "FICTIONAL writes a report" },
  ] }],
} as unknown as SessionState);

const user = (text: string) => ({ text, origin: { kind: "user" } });
const turn = (id: string, text: string): Turn => ({
  id, startedAt: AT, state: "complete", usage: undefined, message: user(text), responseParts: [{ kind: "markdown", id: `${id}-m`, content: `FICTIONAL reply to ${text}` }],
} as unknown as Turn);
const active = (responseParts: unknown[] = []) => ({ id: "turn-live", startedAt: AT, message: user("FICTIONAL working"), usage: undefined, responseParts });
const chatState = (n: number, overrides: Record<string, unknown> = {}): ChatState =>
  ({ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT, turns: [], ...overrides } as unknown as ChatState);

const COLOR = { id: "q-color", kind: "single-select", title: "Color", message: "FICTIONAL which color?", required: true, allowFreeformInput: true, options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] };
const SIZE = { id: "q-size", kind: "text", title: "Size", message: "FICTIONAL what size?", required: true };
const asking = (questions: unknown[]) => chatState(1, { status: 24, activeTurn: active([{ kind: "inputRequest", request: { id: "req-1", questions } }]) });

/** A manual clock for the watch lease. */
function manualClock(): LeaseClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    setTimeout(run, ms) { next += 1; timers.set(next, { at: now + ms, run }); return next; },
    clearTimeout(handle) { timers.delete(handle as number); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
  };
}

interface Rig { fake: FakeAgentHost; conn: AgentHostConnection; clock: ReturnType<typeof manualClock>; entries: string }

/** Every route call in this file goes through here: its response never carries the host's token. */
const tokens: string[] = [];
async function call(rig: { conn: AgentHost; clock: LeaseClock }, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const request = body === undefined
    ? get(path)
    : new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await hostChatsRoute(request, new URL(request.url).pathname, rig.conn, rig.clock)!;
  const text = await response.text();
  for (const token of tokens) expect(text).not.toContain(token);
  return { status: response.status, json: JSON.parse(text) };
}

function homeWithRegistry(): { home: string; env: Record<string, string>; entries: string } {
  const home = temp();
  const config = join(home, "cfg");
  const entries = join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  return { home, env: { XDG_CONFIG_HOME: config }, entries };
}

// Stands in for the reconnect backoff (1 s, 2 s, 4 s …), as in connection.test.ts.
const quick = (ms: number) => Bun.sleep(Math.min(ms, 10));

function connectionAt(home: string, env: Record<string, string>): AgentHostConnection {
  const conn = new AgentHostConnection({ home, env, platform: "linux", startHost: false, onChange: () => {}, clientId: "herdr-web-0000test", deps: { sleep: quick } });
  cleanups.push(() => conn.stop());
  conn.start();
  return conn;
}

async function rig(overrides: Partial<FakeAgentHostSeed> = {}): Promise<Rig> {
  const { home, env, entries } = homeWithRegistry();
  const fake = await fakeAgentHost({
    sessions: [summary(1), summary(2)],
    states: { [sessionUri(1)]: sessionState(1), [sessionUri(2)]: sessionState(2) },
    chats: { [chatUri(1)]: chatState(1), [chatUri(2)]: chatState(2) },
    models: [MODEL],
    entryDir: entries,
    ...overrides,
  });
  cleanups.push(() => fake.stop());
  tokens.push(fake.token);
  const conn = connectionAt(home, env);
  await until("the connection", () => conn.state().state === "connected");
  return { fake, conn, clock: manualClock(), entries };
}

const actions = (fake: FakeAgentHost, type: string): Array<{ channel: string; action: unknown }> => fake.dispatched.filter((entry) => entry.action.type === type);
const only = (fake: FakeAgentHost, type: string): Record<string, any> => {
  const found = actions(fake, type);
  expect(found.length).toBe(1);
  return found[0]!.action as Record<string, any>;
};

describe("host chat routes", () => {
  it("the test preload clears HERDR_WEB_AGENT_HOST and HERDR_WEB_AGENT_HOST_START, so no test server reaches this PC's agent host", () => {
    // scripts/test-herdr.ts: every createServer without agentHost reads these, and a developer's
    // shell may export them on the very PC whose VS Code agent host the feature talks to
    expect(process.env["HERDR_WEB_AGENT_HOST"]).toBeUndefined();
    expect(process.env["HERDR_WEB_AGENT_HOST_START"]).toBeUndefined();
  });

  it("with HERDR_WEB_AGENT_HOST unset every /api/host-chats route is 404 host_chats_off and no connection starts", async () => {
    const previous = process.env["HERDR_WEB_AGENT_HOST"];
    delete process.env["HERDR_WEB_AGENT_HOST"];
    try {
      const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
      cleanups.push(() => server.stop());
      for (const path of ["state", "chats", "chat/send", "anything/else"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/host-chats/${path}`);
        const body = await response.json() as { error: { code: string } };
        expect({ path, status: response.status, code: body.error.code }).toEqual({ path, status: 404, code: "host_chats_off" });
      }
    } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_AGENT_HOST"]; else process.env["HERDR_WEB_AGENT_HOST"] = previous;
    }
    // the route itself, with no host: the same answer, and nothing outside /api/host-chats/ is taken
    const off = await hostChatsRoute(get("/api/host-chats/state"), "/api/host-chats/state", null)!;
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("host_chats_off");
    expect(hostChatsRoute(get("/api/session"), "/api/session", null)).toBeNull();
    expect(hostChatsRoute(get("/api/host-chats"), "/api/host-chats", null)).toBeNull();
  });

  it("old_vscode_path_is_404", async () => {
    // the old prefix is gone, not aliased: the route leaves it to the server's own 404
    const host = stub(() => ({ state: "connected", signed_in: true, protocol: "1.0.0" }));
    for (const path of ["/api/vscode/state", "/api/vscode/chats", "/api/vscode/chat/send"]) {
      expect(hostChatsRoute(get(path), path, host)).toBeNull();
      expect(hostChatsRoute(get(path), path, null)).toBeNull();
    }
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    cleanups.push(() => server.stop());
    const response = await fetch(`http://127.0.0.1:${server.port}/api/vscode/state`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "unknown endpoint /api/vscode/state" } });
  });

  it("with agentHost enabled /api/host-chats/state answers the connection's state", async () => {
    let current: AgentHostState = { state: "connected", signed_in: true, protocol: "1.0.0" };
    const host = stub(() => current);
    const response = await hostChatsRoute(get("/api/host-chats/state"), "/api/host-chats/state", host)!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
    current = { state: "waiting" };
    expect(await (await hostChatsRoute(get("/api/host-chats/state"), "/api/host-chats/state", host)!).json()).toEqual({ host: { state: "waiting" } });
    const posted = await hostChatsRoute(new Request("http://127.0.0.1/api/host-chats/state", { method: "POST" }), "/api/host-chats/state", host)!;
    expect(posted.status).toBe(400);
    expect(((await posted.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
    const unknown = await hostChatsRoute(get("/api/host-chats/nothing"), "/api/host-chats/nothing", host)!;
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("a server with agentHost on serves its connection's state, pushes host-chat-state over the WebSocket, and stops it on stop", async () => {
    const home = temp();
    const config = join(home, "cfg");
    const entries = join(config, "Code", "agent-host", "local-endpoint", "entries");
    // the macOS registry dir too, so either platform finds the fake host under this home
    const mac = join(home, "Library", "Application Support", "Code", "agent-host", "local-endpoint", "entries");
    mkdirSync(entries, { recursive: true });
    mkdirSync(mac, { recursive: true });
    const fake = await fakeAgentHost({ sessions: [], states: {}, chats: {}, models: [], entryDir: process.platform === "darwin" ? mac : entries });
    cleanups.push(() => fake.stop());
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null,
      agentHost: { enabled: true, startHost: false, home, env: { XDG_CONFIG_HOME: config } },
    });
    let stopped = false;
    cleanups.push(() => { if (!stopped) server.stop(); });
    const seen: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => ws.close());
    ws.addEventListener("message", (event) => { seen.push(JSON.parse(String(event.data)) as ServerMessage); });
    await until("the host-chat-state frame", () => seen.some((m) => m.type === "host-chat-state" && m.host.state === "connected"));
    expect(seen).toContainEqual({ type: "host-chat-changed", session: null });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/host-chats/state`);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ host: { state: "connected", signed_in: false, protocol: "1.0.0" } });
    expect(text).not.toContain(fake.token);
    expect(fake.peers()).toBe(1);
    server.stop();
    stopped = true;
    // the connection goes with the server: the fake host sees its socket close
    await until("the connection to close", () => fake.peers() === 0);
  });
});

describe("host chat routes behind a token", () => {
  it("the bridge token is admitted on /api/host-chats/*, directly and through the machine proxy; no token is refused", async () => {
    const { home, env, entries } = homeWithRegistry();
    const mac = join(home, "Library", "Application Support", "Code", "agent-host", "local-endpoint", "entries");
    mkdirSync(mac, { recursive: true });
    const fake = await fakeAgentHost({ sessions: [summary(1)], states: { [sessionUri(1)]: sessionState(1) }, chats: { [chatUri(1)]: chatState(1) }, models: [MODEL], entryDir: process.platform === "darwin" ? mac : entries });
    cleanups.push(() => fake.stop());
    // a bridge whose browsers need a token of their own; the connection server holds only the bridge token
    const bridge = createServer({
      port: 0, hostname: "127.0.0.1", token: "FICTIONAL-browser-token", machines: false, registerBridge: true, stateDir: temp(), tailscaleOwner: null, herdrProfiles: async () => [],
      agentHost: { enabled: true, startHost: false, home, env },
    });
    cleanups.push(() => bridge.stop());
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    expect(registered.token).not.toBe("FICTIONAL-browser-token");
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const hostState = async () => (await (await fetch(`${endpoint}/api/host-chats/state`, { headers: { authorization: `Bearer ${registered.token}` } })).json() as { host: AgentHostState }).host.state;
    for (const deadline = Date.now() + 5_000; await hostState() !== "connected";) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the bridge's host");
      await Bun.sleep(10);
    }
    expect((await fetch(`${endpoint}/api/host-chats/state`)).status).toBe(401);
    expect((await fetch(`${endpoint}/api/host-chats/chats`, { headers: { authorization: "Bearer FICTIONAL-wrong" } })).status).toBe(401);
    const direct = await fetch(`${endpoint}/api/host-chats/chats`, { headers: { authorization: `Bearer ${registered.token}` } });
    expect(direct.status).toBe(200);
    expect(((await direct.json()) as { chats: { session: string }[] }).chats.map((row) => row.session)).toEqual([sessionUri(1)]);
    // the connection server's proxy carries the bridge token, GET and POST
    const manager = { endpoint: (id: string) => id === "host-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const state = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/host-remote/host-chats/state"), manager);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
    const watched = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/host-remote/host-chats/chat/watch", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ session: sessionUri(1) }),
    }), manager);
    expect({ status: watched.status, body: await watched.json() }).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("the agent host on shutdown", () => {
  it("a connection whose stop fails is logged by the error's name, and is no unhandled rejection", async () => {
    const { home, env } = homeWithRegistry();
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null,
      agentHost: { enabled: true, startHost: false, home, env },
    });
    const realStop = AgentHostConnection.prototype.stop;
    const warned: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    const warn = console.warn;
    process.on("unhandledRejection", onUnhandled);
    AgentHostConnection.prototype.stop = async function () { await realStop.call(this); throw new RangeError("FICTIONAL secret"); };
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      server.stop();
      await until("the log line", () => warned.some((line) => line.startsWith("agent-host: stop failed")));
      // fixed wait: one turn of the event loop, for an unhandled rejection to be reported if there is one
      await Bun.sleep(0);
    } finally {
      AgentHostConnection.prototype.stop = realStop;
      console.warn = warn;
      process.off("unhandledRejection", onUnhandled);
    }
    expect(warned.filter((line) => line.startsWith("agent-host:"))).toEqual(["agent-host: stop failed (RangeError)"]);
    expect(unhandled).toEqual([]);
  });
});

describe("host chat read and write routes", () => {
  it("lists the chats and reads one, with its models and its session's agents", async () => {
    const r = await rig();
    const chats = await call(r, "/api/host-chats/chats");
    expect(chats.json.chats.map((row: { session: string }) => row.session)).toEqual([sessionUri(2), sessionUri(1)]);
    expect(chats.json.chats[0]).toEqual({ session: sessionUri(2), title: "FICTIONAL_chat_2", status: "idle", modified_at: "2026-01-01T00:00:02.000Z", cwd: "/tmp/fictional-repo", unread: true, archived: false });
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ session: sessionUri(1), title: "FICTIONAL_chat_1", status: "idle", turns: [], cursor: null, prompt: null, busy: false });
    const models = await call(r, `/api/host-chats/models?session=${encodeURIComponent(sessionUri(1))}`);
    expect(models.json).toEqual({
      models: [{ id: "fictional/model-a", name: "Fictional Model A", provider: "copilotcli", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] }, context: null, group: "fictional", multiplier: null, warning: null }],
      agents: [{ uri: REPORT, name: "Report", description: "FICTIONAL writes a report" }],
    });
    expect((await call(r, "/api/host-chats/models")).json.agents).toEqual([]);
  });

  it("send on an idle chat dispatches one turnStarted with model and agent on the message", async () => {
    const r = await rig();
    const sent = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL hello", model: { id: "fictional/model-a", effort: "high" }, agent: REPORT });
    expect(sent).toEqual({ status: 200, json: { queued: false } });
    await until("the turn to arrive", () => actions(r.fake, "chat/turnStarted").length > 0);
    const started = only(r.fake, "chat/turnStarted");
    expect(actions(r.fake, "chat/turnStarted")[0]!.channel).toBe(chatUri(1));
    expect(started["message"]).toEqual({ text: "FICTIONAL hello", origin: { kind: "user" }, model: { id: "fictional/model-a", config: { thinkingLevel: "high" } }, agent: { uri: REPORT } });
    expect(started["turnId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(started["startedAt"]))).toBe(false);
    // the model choice also goes to the chat's shared draft
    await until("the draft", () => actions(r.fake, "chat/draftChanged").length > 0);
    expect(only(r.fake, "chat/draftChanged")["draft"]["model"]).toEqual({ id: "fictional/model-a", config: { thinkingLevel: "high" } });
    expect(actions(r.fake, "chat/pendingMessageSet")).toEqual([]);
  });

  it("agent null omits agent", async () => {
    const r = await rig();
    expect((await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL plain", agent: null })).json).toEqual({ queued: false });
    await until("the turn to arrive", () => actions(r.fake, "chat/turnStarted").length > 0);
    const message = only(r.fake, "chat/turnStarted")["message"];
    expect("agent" in message).toBe(false);
    expect("model" in message).toBe(false);
    expect(actions(r.fake, "chat/draftChanged")).toEqual([]);
  });

  it("send on a busy chat queues and starts no turn", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active() }), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL later" })).json).toEqual({ queued: true });
    await until("the queued message", () => actions(r.fake, "chat/pendingMessageSet").length > 0);
    const queued = only(r.fake, "chat/pendingMessageSet");
    expect(queued).toMatchObject({ kind: "queued", message: { text: "FICTIONAL later", origin: { kind: "user" } } });
    expect(queued["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.busy).toBe(true);
  });

  it("a send's id is its turn's id, and the same id sent again (its answer lost) dispatches nothing", async () => {
    const r = await rig();
    const id = crypto.randomUUID();
    const body = { id, session: sessionUri(1), text: "FICTIONAL once" };
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: false });
    await until("the turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === id);
    expect(only(r.fake, "chat/turnStarted")["turnId"]).toBe(id);
    // the retry, while the turn runs and once it is a past turn
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: false });
    r.fake.push(chatUri(1), { type: "chat/turnComplete", turnId: id, duration: 10 } as unknown as StateAction);
    await until("the turn to end", () => r.conn.chat(sessionUri(1))?.turns.some((turn) => turn.id === id) === true);
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: false });
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
    // an id that is there but no UUID is refused before anything goes
    for (const bad of ["", "FICTIONAL-not-a-uuid", 42]) {
      const refused = await call(r, "/api/host-chats/chat/send", { ...body, id: bad });
      expect({ bad, status: refused.status, code: refused.json.error.code }).toEqual({ bad, status: 400, code: "invalid_id" });
    }
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
  });

  it("a queued send's id is its pending message's, and the same id again queues nothing", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active() }), [chatUri(2)]: chatState(2) } });
    const id = crypto.randomUUID();
    const body = { id, session: sessionUri(1), text: "FICTIONAL later" };
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: true });
    await until("the queued message", () => (r.conn.chat(sessionUri(1))?.queuedMessages ?? []).some((pending) => pending.id === id));
    expect(only(r.fake, "chat/pendingMessageSet")["id"]).toBe(id);
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: true });
    // the running turn ends and the queued one starts under the host's own turn id: not pending any more
    r.fake.push(chatUri(1), { type: "chat/turnComplete", turnId: "turn-live", duration: 10 } as unknown as StateAction);
    r.fake.push(chatUri(1), { type: "chat/turnStarted", turnId: "turn-host", startedAt: AT, message: user("FICTIONAL later"), queuedMessageId: id } as unknown as StateAction);
    await until("the queued message to start", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === "turn-host" && (r.conn.chat(sessionUri(1))?.queuedMessages ?? []).length === 0);
    expect((await call(r, "/api/host-chats/chat/send", body)).json).toEqual({ queued: false });
    expect(actions(r.fake, "chat/pendingMessageSet").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted").length).toBe(0);
  });

  it("the mirror alone stops a repeat: a chat that has the id (sent by another bridge) dispatches nothing", async () => {
    const id = crypto.randomUUID();
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { turns: [turn(id, "FICTIONAL sent elsewhere")] }), [chatUri(2)]: chatState(2, { status: 8, activeTurn: active(), queuedMessages: [{ id: uuid(77), message: user("FICTIONAL waiting") }] }) } });
    expect((await call(r, "/api/host-chats/chat/send", { id, session: sessionUri(1), text: "FICTIONAL sent elsewhere" })).json).toEqual({ queued: false });
    expect((await call(r, "/api/host-chats/chat/send", { id: uuid(77), session: sessionUri(2), text: "FICTIONAL waiting" })).json).toEqual({ queued: true });
    expect(r.fake.dispatched.filter((entry) => entry.action.type !== "session/activeClientSet")).toEqual([]);
  });

  it("a model choice writes draft.model and keeps the other client's draft text", async () => {
    const draft = { text: "FICTIONAL half-typed", origin: { kind: "user" }, attachments: [{ type: "simple", label: "FICTIONAL note" }] };
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { draft }), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/host-chats/chat/draft", { session: sessionUri(1), model: { id: "fictional/model-a", effort: "low" } })).json).toEqual({ ok: true });
    await until("the draft", () => actions(r.fake, "chat/draftChanged").length > 0);
    const written = only(r.fake, "chat/draftChanged")["draft"];
    expect(written.text).toBe("FICTIONAL half-typed");
    expect(written.attachments).toEqual(draft.attachments);
    expect(written.model).toEqual({ id: "fictional/model-a", config: { thinkingLevel: "low" } });
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    // the read says the draft's model while no turn names one
    await until("the draft to come back", () => r.conn.chat(sessionUri(1))?.draft?.model !== undefined);
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.model).toEqual({ id: "fictional/model-a", effort: "low" });
    expect((await call(r, "/api/host-chats/chat/draft", { session: sessionUri(1) })).status).toBe(400);
  });

  it("a free answer goes as freeformValues on a selected answer", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR]), [chatUri(2)]: chatState(2) } });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    expect(read.prompt).toMatchObject({ id: "req-1:q-color", kind: "question", custom_option_index: 2, host: { request_id: "req-1", question_id: "q-color" } });
    expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: [""], text: "FICTIONAL teal" })).json).toEqual({ ok: true });
    await until("the answer", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({
      type: "chat/inputCompleted", requestId: "req-1", response: "accept",
      answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["FICTIONAL teal"] } } },
    });
  });

  it("a question that leaves allowFreeformInput unset takes a typed answer, as VS Code's does; false refuses it", async () => {
    const { allowFreeformInput: _, ...unset } = COLOR;
    const r = await rig({ chats: { [chatUri(1)]: asking([unset]), [chatUri(2)]: chatState(2) } });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    expect(read.prompt).toMatchObject({ custom_option_index: 2, host: { option_ids: ["red", "blue", ""] } });
    const posted = await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: [""], text: "FICTIONAL teal" });
    expect(posted.json).toEqual({ ok: true });
    await until("the answer", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted").answers).toEqual({ "q-color": { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["FICTIONAL teal"] } } });
    const closed = await rig({ chats: { [chatUri(1)]: asking([{ ...COLOR, allowFreeformInput: false }]), [chatUri(2)]: chatState(2) } });
    await call(closed, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    const refused = await call(closed, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: [""], text: "FICTIONAL teal" });
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 400, code: "missing_answer" });
  });

  it("a subagent's own chat reads through the chat route once its parent is read, and gives the parent's row its model and times", async () => {
    const worker = "ahp-chat://default/fictional-worker";
    const subagent = { type: "subagent", resource: worker, title: "Explore", agentName: "explore", description: "FICTIONAL find the config" };
    const parent = reducedChat([
      { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: { ...user("FICTIONAL do it"), model: { id: "fictional/model-a" } } } as StateAction,
      ...toolCallActions("turn-1", { toolCallId: "c3", toolName: "task", displayName: "Task", invocationMessage: "FICTIONAL delegating" }, { success: true, pastTenseMessage: "FICTIONAL delegated", content: [subagent] } as ToolCallResult),
      { type: "chat/turnComplete", turnId: "turn-1", duration: 400_000 } as StateAction,
    ], chatState(1));
    const workerChat = reducedChat([
      { type: "chat/turnStarted", turnId: "w-1", startedAt: "2026-01-01T00:00:01.000Z", message: { ...user("FICTIONAL find the config"), model: { id: "fictional/model-b" } } } as StateAction,
      { type: "chat/responsePart", turnId: "w-1", part: { kind: "markdown", id: "m", content: "FICTIONAL found it" } } as StateAction,
      { type: "chat/turnComplete", turnId: "w-1", duration: 343_000 } as StateAction,
    ], chatState(3, { resource: worker }));
    const r = await rig({ chats: { [chatUri(1)]: parent, [chatUri(2)]: chatState(2), [worker]: workerChat } });
    const path = (session: string) => `/api/host-chats/chat?session=${encodeURIComponent(session)}`;
    // not a chat of any session read so far: missing, as any unknown chat
    expect((await call(r, path(worker))).json.error.code).toBe("host_chat_missing");
    const read = (await call(r, path(sessionUri(1)))).json as HostChatRead;
    expect(read.turns[1]!.parts[0]).toEqual({
      kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: "fictional/model-b",
      started: "2026-01-01T00:00:01.000Z", ended: "2026-01-01T00:05:44.000Z", status: "done", chat: worker,
    });
    const own = await call(r, path(worker));
    expect(own.status).toBe(200);
    expect((own.json as HostChatRead).turns.map((each) => each.parts)).toEqual([[{ kind: "text", text: "FICTIONAL find the config" }], [{ kind: "text", text: "FICTIONAL found it" }]]);
    // read only: nothing is sent into a subagent's chat
    const sent = await call(r, "/api/host-chats/chat/send", { session: worker, text: "FICTIONAL hi", id: uuid(77) });
    expect({ status: sent.status, code: sent.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
  });

  /** A parent chat whose turn started `n` subagents, worker-0 oldest, and their worker chats. */
  const manySubagents = (n: number) => {
    const workers = Array.from({ length: n }, (_, i) => `ahp-chat://default/fictional-worker-${i}`);
    const parent = reducedChat([
      { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: user("FICTIONAL fan out") } as StateAction,
      ...workers.flatMap((resource, i) => toolCallActions("turn-1", { toolCallId: `c${i}`, toolName: "task", displayName: "Task", invocationMessage: "FICTIONAL delegating" },
        { success: true, pastTenseMessage: "FICTIONAL delegated", content: [{ type: "subagent", resource, title: "Explore", agentName: "explore", description: `FICTIONAL task ${i}` }] } as ToolCallResult)),
      { type: "chat/turnComplete", turnId: "turn-1", duration: 1_000 } as StateAction,
    ], chatState(1));
    const chats = Object.fromEntries(workers.map((resource, i) => [resource, reducedChat([
      { type: "chat/turnStarted", turnId: `w-${i}`, startedAt: AT, message: user(`FICTIONAL task ${i}`) } as StateAction,
      { type: "chat/turnComplete", turnId: `w-${i}`, duration: 1_000 } as StateAction,
    ], chatState(3, { resource }))]));
    return { workers, parent, chats };
  };
  /** The rig's connection, its worker-chat subscribes counted by chat. */
  const counting = (conn: AgentHostConnection) => {
    const watched: string[] = [];
    const host: AgentHost = {
      state: () => conn.state(), mirror: () => conn.mirror(), summaries: () => conn.summaries(), chat: (s) => conn.chat(s),
      watch: (s) => conn.watch(s), watching: (s) => conn.watching(s), request: (method, params) => conn.request(method, params),
      dispatch: (channel, action) => conn.dispatch(channel, action),
      watchChat: (uri, session) => { watched.push(uri); return conn.watchChat(uri, session); },
      watchingChat: (uri) => conn.watchingChat(uri), chatAt: (uri) => conn.chatAt(uri),
    };
    return { host, watched };
  };
  const chatPath = (session: string) => `/api/host-chats/chat?session=${encodeURIComponent(session)}`;

  it("a read subscribes its newest 20 subagent chats, and an older one still reads when its row opens", async () => {
    const { workers, parent, chats } = manySubagents(21);
    const r = await rig({ chats: { [chatUri(1)]: parent, [chatUri(2)]: chatState(2), ...chats } });
    const { host, watched } = counting(r.conn);
    const rr = { conn: host, clock: r.clock };
    expect((await call(rr, chatPath(sessionUri(1)))).status).toBe(200);
    expect(watched.length).toBe(20);
    expect(watched).not.toContain(workers[0]);
    expect(new Set(watched)).toEqual(new Set(workers.slice(1)));
    // the oldest is known, so it reads, subscribing then
    const oldest = await call(rr, chatPath(workers[0]!));
    expect(oldest.status).toBe(200);
    expect((oldest.json as HostChatRead).turns[0]!.parts).toEqual([{ kind: "text", text: "FICTIONAL task 0" }]);
    expect(watched.length).toBe(21);
    expect(r.conn.watchingChat(workers[0]!)).toBe(true);
  });

  it("a subagent named by a session URI (VS Code 1.142+) reads through that session's chat, and its parent reads", async () => {
    const worker = "copilotcli:/fictional-1/subagent/toolu_FICTIONAL";
    const inner = "ahp-chat://default/fictional-worker-session-chat";
    const parent = reducedChat([
      { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: user("FICTIONAL fan out") } as StateAction,
      ...toolCallActions("turn-1", { toolCallId: "c0", toolName: "task", displayName: "Task", invocationMessage: "FICTIONAL delegating" },
        { success: true, pastTenseMessage: "FICTIONAL delegated", content: [{ type: "subagent", resource: worker, title: "Explore", agentName: "explore", description: "FICTIONAL task" }] } as ToolCallResult),
      { type: "chat/turnComplete", turnId: "turn-1", duration: 1_000 } as StateAction,
    ], chatState(1));
    const workerChat = reducedChat([
      { type: "chat/turnStarted", turnId: "w-0", startedAt: AT, message: user("FICTIONAL worker task") } as StateAction,
      { type: "chat/turnComplete", turnId: "w-0", duration: 2_000 } as StateAction,
    ], chatState(3, { resource: inner }));
    const workerSession = { provider: "subagent", title: "Explore", status: 1, lifecycle: "ready", activeClients: [],
      chats: [{ resource: inner, title: "", status: 1, modifiedAt: AT }], defaultChat: inner } as unknown as SessionState;
    const r = await rig({ states: { [sessionUri(1)]: sessionState(1), [sessionUri(2)]: sessionState(2), [worker]: workerSession }, chats: { [chatUri(1)]: parent, [chatUri(2)]: chatState(2), [inner]: workerChat } });
    const read = await call(r, chatPath(sessionUri(1)));
    expect(read.status).toBe(200);
    const row = (read.json as HostChatRead).turns.flatMap((turn) => turn.parts).find((part) => part.kind === "subagent") as { ended: string | null; chat: string };
    expect(row.chat).toBe(worker);
    expect(row.ended).toBe(new Date(Date.parse(AT) + 2_000).toISOString());
    const own = await call(r, chatPath(worker));
    expect(own.status).toBe(200);
    expect((own.json as HostChatRead).turns[0]!.parts).toEqual([{ kind: "text", text: "FICTIONAL worker task" }]);
  });

  it("an expired lease releases its worker watches, and the session forgets its worker chats", async () => {
    const { workers, parent, chats } = manySubagents(2);
    const r = await rig({ chats: { [chatUri(1)]: parent, [chatUri(2)]: chatState(2), ...chats } });
    await call(r, chatPath(sessionUri(1)));
    expect(workers.map((uri) => r.conn.watchingChat(uri))).toEqual([true, true]);
    r.clock.advance(LEASE_MS + 1);
    await until("the worker watches to go", () => workers.every((uri) => !r.conn.watchingChat(uri)));
    expect(r.conn.watching(sessionUri(1))).toBe(false);
    // no longer remembered: a worker read without its parent read again is missing
    expect((await call(r, chatPath(workers[0]!))).json.error.code).toBe("host_chat_missing");
    // the parent's next read finds them again
    await call(r, chatPath(sessionUri(1)));
    expect((await call(r, chatPath(workers[0]!))).status).toBe(200);
  });

  it("a worker chat stops reading once its parent session is no longer known", async () => {
    const { workers, parent, chats } = manySubagents(1);
    const r = await rig({ chats: { [chatUri(1)]: parent, [chatUri(2)]: chatState(2), ...chats } });
    // the host as the routes see it, with the parent hidden on request (gone from the list and the mirror)
    let hidden = false;
    const { host } = counting(r.conn);
    const hiding: AgentHost = {
      ...host,
      summaries: () => r.conn.summaries().filter((summary) => !hidden || summary.resource !== sessionUri(1)),
      mirror: () => ({ root: r.conn.mirror().root, getSession: (uri: string) => hidden && uri === sessionUri(1) ? undefined : r.conn.mirror().getSession(uri) }),
    };
    const rr = { conn: hiding, clock: r.clock };
    await call(rr, chatPath(sessionUri(1)));
    expect((await call(rr, chatPath(workers[0]!))).status).toBe(200);
    hidden = true;
    // still remembered as the session's, still subscribed: refused all the same, as the session is
    expect(r.conn.watchingChat(workers[0]!)).toBe(true);
    const gone = await call(rr, chatPath(workers[0]!));
    expect({ status: gone.status, code: gone.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
    for (const path of [`/api/host-chats/tool-output?session=${encodeURIComponent(workers[0]!)}&ref=x`, `/api/host-chats/image?session=${encodeURIComponent(workers[0]!)}&ref=x:0`]) {
      expect((await call(rr, path)).json.error.code).toBe("host_chat_missing");
    }
  });

  it("a form's answers go together, in one inputCompleted: the phone pages through it, the host hears nothing until Submit", async () => {
    for (const required of [true, false, undefined]) {
      const flagged = (question: Record<string, unknown>) => { const { required: _, ...rest } = question; return required === undefined ? rest : { ...rest, required }; };
      const r = await rig({ chats: { [chatUri(1)]: asking([flagged(COLOR), flagged(SIZE)]), [chatUri(2)]: chatState(2) } });
      const read = ((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead).prompt!;
      expect({ required, id: read.id, form: read.form?.length }).toEqual({ required, id: "req-1:form", form: 2 });
      expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", answers: { "q-color": { option_ids: ["blue"] }, "q-size": { text: "FICTIONAL large" } } })).json).toEqual({ ok: true });
      await until("the form", () => actions(r.fake, "chat/inputCompleted").length > 0);
      expect({ required, done: only(r.fake, "chat/inputCompleted") }).toEqual({ required, done: {
        type: "chat/inputCompleted", requestId: "req-1", response: "accept",
        answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "blue" } }, "q-size": { state: "submitted", value: { kind: "text", value: "FICTIONAL large" } } },
      } });
      expect(actions(r.fake, "chat/inputAnswerChanged")).toEqual([]);
      // the form is answered: a second Submit finds no request
      expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", answers: {} })).status).toBe(409);
    }
  });

  it("a form is read whole and answered in one go: every answer completes it at once, an optional one left empty as skipped", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR, { ...SIZE, required: false }]), [chatUri(2)]: chatState(2) } });
    const read = ((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead).prompt!;
    expect(read.form?.map((question) => [question.title, question.required, question.custom_option_index])).toEqual([["Color", true, 2], ["Size", false, 0]]);
    expect(read.host).toMatchObject({ request_id: "req-1", form: [{ question_id: "q-color", option_ids: ["red", "blue", ""] }, { question_id: "q-size", option_ids: [""] }] });
    // a required question with no answer is refused, and nothing reaches the host
    const missing = await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", answers: { "q-size": { text: "FICTIONAL large" } } });
    expect({ status: missing.status, code: missing.json.error.code }).toEqual({ status: 400, code: "missing_answer" });
    expect(actions(r.fake, "chat/inputCompleted")).toEqual([]);
    expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", answers: { "q-color": { option_ids: ["blue"] }, "q-size": null } })).json).toEqual({ ok: true });
    await until("the form", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({ type: "chat/inputCompleted", requestId: "req-1", response: "accept",
      answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "blue" } }, "q-size": { state: "skipped" } } });
    expect(actions(r.fake, "chat/inputAnswerChanged")).toEqual([]);
  });

  it("skip declines with no answers", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR, SIZE]), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", skip: true })).json).toEqual({ ok: true });
    await until("the decline", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({ type: "chat/inputCompleted", requestId: "req-1", response: "decline" });
    expect((await call(r, "/api/host-chats/chat/answer", { session: sessionUri(1), request_id: "req-gone", question_id: "q-color", option_ids: ["red"] })).status).toBe(409);
  });

  it("confirm approve says user-action; deny says denied", async () => {
    const pending = (n: number) => chatState(n, { status: 24, activeTurn: active([{ kind: "toolCall", toolCall: {
      status: "pending-confirmation", toolCallId: `call-${n}`, toolName: "bash", displayName: "Run in terminal", invocationMessage: "Run `ls`", toolInput: "ls",
    } }]) });
    const r = await rig({ chats: { [chatUri(1)]: pending(1), [chatUri(2)]: pending(2) } });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    expect(read.prompt).toMatchObject({ kind: "approval", host: { tool_call_id: "call-1", turn_id: "turn-live" } });
    expect((await call(r, "/api/host-chats/chat/confirm", { session: sessionUri(1), turn_id: "turn-live", tool_call_id: "call-1", approved: true })).json).toEqual({ ok: true });
    expect((await call(r, "/api/host-chats/chat/confirm", { session: sessionUri(2), turn_id: "turn-live", tool_call_id: "call-2", approved: false })).json).toEqual({ ok: true });
    await until("both confirmations", () => actions(r.fake, "chat/toolCallConfirmed").length === 2);
    expect(actions(r.fake, "chat/toolCallConfirmed")).toEqual([
      { channel: chatUri(1), action: { type: "chat/toolCallConfirmed", turnId: "turn-live", toolCallId: "call-1", approved: true, confirmed: "user-action" } as unknown as StateAction },
      { channel: chatUri(2), action: { type: "chat/toolCallConfirmed", turnId: "turn-live", toolCallId: "call-2", approved: false, reason: "denied" } as unknown as StateAction },
    ]);
    expect((await call(r, "/api/host-chats/chat/confirm", { session: sessionUri(1), turn_id: "turn-live", tool_call_id: "call-404", approved: true })).status).toBe(409);
  });

  it("new chat creates with isolation folder and the cwd as a file URI, then sends", async () => {
    const r = await rig();
    const made = await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL start here", model: { id: "fictional/model-a", effort: "medium" }, agent: null });
    expect(made.status).toBe(200);
    expect(made.json.session).toMatch(/^copilotcli:\/[0-9a-f-]{36}$/);
    const created = r.fake.requests.filter((entry) => entry.method === "createSession");
    expect(created.length).toBe(1);
    expect(created[0]!.params).toMatchObject({ channel: made.json.session, provider: "copilotcli", workingDirectories: ["file:///tmp/fictional-repo"], config: { isolation: "folder" } });
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length > 0);
    const first = actions(r.fake, "chat/turnStarted");
    expect(first.length).toBe(1);
    expect(first[0]!.channel).toBe(`ahp-chat://default/${Buffer.from(made.json.session).toString("base64")}`);
    expect((first[0]!.action as unknown as { message: unknown }).message).toEqual({ text: "FICTIONAL start here", origin: { kind: "user" }, model: { id: "fictional/model-a", config: { thinkingLevel: "medium" } } });
    expect((await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "fictional-relative", text: "x" })).status).toBe(400);
  });

  it("a new chat without text is made empty (VS Code's New Chat), its composer works, and nothing is sent", async () => {
    const r = await rig();
    const made = await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo" });
    expect(made.status).toBe(200);
    const session = made.json.session as string;
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    // the empty chat reads, takes its config and models, as any chat
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(session)}`);
    expect(read.status).toBe(200);
    expect(read.json.turns).toEqual([]);
    expect((await call(r, `/api/host-chats/models?session=${encodeURIComponent(session)}`)).status).toBe(200);
    // its first message starts its first turn
    expect((await call(r, "/api/host-chats/chat/send", { session, id: crypto.randomUUID(), text: "FICTIONAL first words" })).status).toBe(200);
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length === 1);
  });

  it("an empty chat the bridge made goes when no phone keeps it open; one that got a message stays", async () => {
    const r = await rig();
    const left = (await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo" })).json.session as string;
    const used = (await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo" })).json.session as string;
    await call(r, "/api/host-chats/chat/send", { session: used, id: crypto.randomUUID(), text: "FICTIONAL kept" });
    await until("the turn", () => actions(r.fake, "chat/turnStarted").length === 1);
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession")).toEqual([]);
    r.clock.advance(LEASE_MS + 1);
    await until("the empty one disposed", () => r.fake.requests.some((entry) => entry.method === "disposeSession"));
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession").map((entry) => (entry.params as Record<string, unknown>)["channel"])).toEqual([left]);
  });

  it("an empty chat's own leave goes at once (chat/discard); a chat with turns, or one not made empty here, is refused", async () => {
    const r = await rig();
    const empty = (await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo" })).json.session as string;
    expect(await call(r, "/api/host-chats/chat/discard", { session: empty })).toEqual({ status: 200, json: { discarded: true } });
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession").map((entry) => (entry.params as Record<string, unknown>)["channel"])).toEqual([empty]);
    // a listed chat (not made empty by this bridge) is never discarded
    expect(await call(r, "/api/host-chats/chat/discard", { session: sessionUri(1) })).toEqual({ status: 200, json: { discarded: false } });
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession").length).toBe(1);
  });

  it("a new chat's id names its session; the same id again makes nothing and sends nothing", async () => {
    const r = await rig();
    const id = crypto.randomUUID();
    const body = { id, cwd: "/tmp/fictional-repo", text: "FICTIONAL start once" };
    const made = await call(r, "/api/host-chats/chat/new", body);
    expect(made).toEqual({ status: 200, json: { session: `copilotcli:/${id}` } });
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length === 1);
    expect(only(r.fake, "chat/turnStarted")["turnId"]).toBe(id);
    expect(await call(r, "/api/host-chats/chat/new", body)).toEqual({ status: 200, json: { session: `copilotcli:/${id}` } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
    for (const bad of ["", "FICTIONAL-not-a-uuid", 42]) {
      const refused = await call(r, "/api/host-chats/chat/new", { ...body, id: bad });
      expect({ bad, status: refused.status, code: refused.json.error.code }).toEqual({ bad, status: 400, code: "invalid_id" });
    }
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(1);
  });

  it("a send or new chat without an id (an older phone) goes once, under an id the bridge mints", async () => {
    const r = await rig();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(await call(r, "/api/host-chats/chat/send", { session: sessionUri(1), text: "FICTIONAL no id" })).toEqual({ status: 200, json: { queued: false } });
    await until("the turn", () => actions(r.fake, "chat/turnStarted").length === 1);
    const turnId = only(r.fake, "chat/turnStarted")["turnId"] as string;
    expect(turnId).toMatch(UUID);
    expect(r.conn.chat(sessionUri(1))?.activeTurn?.id).toBe(turnId);
    const made = await call(r, "/api/host-chats/chat/new", { cwd: "/tmp/fictional-repo", text: "FICTIONAL no id either" });
    expect(made.status).toBe(200);
    expect(made.json.session).toMatch(/^copilotcli:\/[0-9a-f-]{36}$/);
    expect(made.json.session.slice("copilotcli:/".length)).toMatch(UUID);
    await until("the new chat's turn", () => actions(r.fake, "chat/turnStarted").length === 2);
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(1);
    // two without an id are two: nothing ties them together
    expect((await call(r, "/api/host-chats/chat/new", { cwd: "/tmp/fictional-repo", text: "FICTIONAL no id either" })).json.session).not.toBe(made.json.session);
  });

  it("a read lists the ids the chat holds its messages under: turns, the running one and the pending ones", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, turns: [turn("t1", "FICTIONAL done")], activeTurn: active(), queuedMessages: [{ id: uuid(77), message: user("FICTIONAL waiting") }] }), [chatUri(2)]: chatState(2) } });
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.message_ids).toEqual(["t1", "turn-live", uuid(77)]);
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(2))}`)).json.message_ids).toEqual([]);
  });

  it("a new chat asked again whose first message never went answers sent: false, and sends nothing", async () => {
    const id = crypto.randomUUID();
    const session = `copilotcli:/${id}`;
    const chat = `ahp-chat://default/${Buffer.from(session).toString("base64")}`;
    // the host made it (the phone's first answer was lost) and it has no turn
    const r = await rig({
      sessions: [summary(1), { ...summary(2), resource: session, defaultChat: chat }],
      states: { [sessionUri(1)]: sessionState(1), [session]: { ...sessionState(2), defaultChat: chat, chats: [{ resource: chat, title: "", status: 1, modifiedAt: AT }] } as SessionState },
      chats: { [chatUri(1)]: chatState(1), [chat]: { ...chatState(2), resource: chat } as ChatState },
    });
    expect(await call(r, "/api/host-chats/chat/new", { id, cwd: "/tmp/fictional-repo", text: "FICTIONAL kept" })).toEqual({ status: 200, json: { session, sent: false } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession")).toEqual([]);
    expect(r.fake.dispatched.filter((entry) => entry.action.type !== "session/activeClientSet")).toEqual([]);
  });

  it("before=<cursor> asks fetchTurns with it and returns older turns once", async () => {
    const r = await rig({
      chats: { [chatUri(1)]: chatState(1, { turns: [turn("t3", "FICTIONAL third")], turnsNextCursor: "page-2" }), [chatUri(2)]: chatState(2) },
      // the older page overlaps the newest turn: it must not show twice
      older: { [chatUri(1)]: { turns: [turn("t1", "FICTIONAL first"), turn("t2", "FICTIONAL second"), turn("t3", "FICTIONAL third")] } },
    });
    const path = `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`;
    const first = (await call(r, path)).json as HostChatRead;
    expect(first.cursor).toBe("page-2");
    expect(first.turns.filter((t) => t.role === "user").map((t) => t.parts[0])).toEqual([{ kind: "text", text: "FICTIONAL third" }]);
    const older = (await call(r, `${path}&before=page-2`)).json as HostChatRead;
    expect(r.fake.requests.filter((entry) => entry.method === "fetchTurns").map((entry) => entry.params)).toEqual([{ channel: chatUri(1), cursor: "page-2" }]);
    const users = older.turns.filter((t) => t.role === "user").map((t) => (t.parts[0] as { text: string }).text);
    expect(users).toEqual(["FICTIONAL first", "FICTIONAL second", "FICTIONAL third"]);
    expect(new Set(users).size).toBe(users.length);
    expect(older.cursor).toBeNull();
    expect(older.signature).not.toBe(first.signature);
  });

  it("an unknown session is 404 host_chat_missing; a disconnected host is 503 agent_host_down", async () => {
    const r = await rig();
    const unknown = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(9))}`);
    expect({ status: unknown.status, code: unknown.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
    const send = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(9), text: "FICTIONAL nobody" });
    expect({ status: send.status, code: send.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
    // no host in this home's registry, and starting one is off: the connection waits
    const { home, env } = homeWithRegistry();
    const down = { conn: connectionAt(home, env), clock: manualClock() };
    await until("the connection to wait", () => down.conn.state().state === "waiting");
    for (const [path, body] of [
      ["/api/host-chats/chats", undefined],
      [`/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`, undefined],
      ["/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL nobody home" }],
      ["/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL nobody home" }],
      ["/api/host-chats/models", undefined],
    ] as const) {
      const answer = await call(down, path, body);
      expect({ path, status: answer.status, code: answer.json.error.code, host: answer.json.host }).toEqual({ path, status: 503, code: "agent_host_down", host: { state: "waiting" } });
    }
  });

  it("a session of another provider is unknown to every chat route, whatever its id", async () => {
    const other = "claude:/fictional-other";
    const r = await rig({
      sessions: [summary(1), { ...summary(2), resource: other, provider: "claude" }],
      states: { [sessionUri(1)]: sessionState(1), [other]: { ...sessionState(2), provider: "claude" } as SessionState },
    });
    const q = `session=${encodeURIComponent(other)}`;
    for (const [path, body] of [
      [`/api/host-chats/chat?${q}`, undefined], [`/api/host-chats/models?${q}`, undefined],
      ["/api/host-chats/chat/watch", { session: other }], ["/api/host-chats/chat/send", { id: crypto.randomUUID(), session: other, text: "FICTIONAL elsewhere" }],
      ["/api/host-chats/chat/answer", { session: other, request_id: "req-1", question_id: "q-color", option_ids: ["red"] }],
      ["/api/host-chats/chat/confirm", { session: other, turn_id: "t", tool_call_id: "c", approved: true }],
      ["/api/host-chats/chat/draft", { session: other, model: { id: "fictional/model-a" } }],
      [`/api/host-chats/image?${q}&ref=c1:0`, undefined], [`/api/host-chats/tool-output?${q}&ref=c1`, undefined],
    ] as const) {
      const answer = await call(r, path, body);
      expect({ path, status: answer.status, code: answer.json.error?.code }).toEqual({ path, status: 404, code: "host_chat_missing" });
    }
    expect(r.fake.requests.filter((entry) => entry.method === "subscribe" && (entry.params as { channel: string }).channel === other)).toEqual([]);
    expect(r.fake.dispatched.filter((entry) => entry.channel !== "ahp-root://")).toEqual([]);
    // the Copilot CLI session beside it still answers
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).status).toBe(200);
  });

  it("a new chat whose first message fails after creation answers its session with sent: false", async () => {
    const r = await rig();
    // the real connection, but every dispatch fails: createSession and the watch succeed, the send does not
    const conn = r.conn;
    const noSend: AgentHost = {
      state: () => conn.state(), mirror: () => conn.mirror(), summaries: () => conn.summaries(), chat: (s) => conn.chat(s),
      watch: (s) => conn.watch(s), watching: (s) => conn.watching(s), request: (method, params) => conn.request(method, params),
      dispatch: () => { throw new AgentHostError("not_connected"); },
    };
    const made = await call({ conn: noSend, clock: r.clock }, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL lost?" });
    expect(made.status).toBe(200);
    expect(made.json).toEqual({ session: expect.stringMatching(/^copilotcli:\/[0-9a-f-]{36}$/), sent: false });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").map((entry) => (entry.params as { channel: string }).channel)).toEqual([made.json.session]);
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    // the watch failing after creation says the same
    const noWatch: AgentHost = { ...noSend, dispatch: (channel, action) => conn.dispatch(channel, action), watch: () => Promise.reject(new AgentHostError("timeout")) };
    const second = await call({ conn: noWatch, clock: manualClock() }, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL lost again?" });
    expect(second).toEqual({ status: 200, json: { session: expect.stringMatching(/^copilotcli:\//), sent: false } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(2);
    // a new chat that sends answers its session alone
    const sent = await call(r, "/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL sent" });
    expect(Object.keys(sent.json)).toEqual(["session"]);
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length === 1);
  });

  it("a watch lease keeps the chat subscribed and its expiry unsubscribes", async () => {
    const r = await rig();
    const unsubscribed = () => r.fake.requests.filter((entry) => entry.method === "unsubscribe").map((entry) => (entry.params as { channel: string }).channel);
    expect((await call(r, "/api/host-chats/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
    expect(r.conn.chat(sessionUri(1))).toBeDefined();
    r.clock.advance(60_000);
    expect((await call(r, "/api/host-chats/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
    r.clock.advance(60_000);
    // 120 s after the first take, 60 s after the renewal: still held
    expect(r.conn.chat(sessionUri(1))).toBeDefined();
    expect(unsubscribed()).toEqual([]);
    expect(LEASE_MS).toBe(90_000);
    r.clock.advance(31_000);
    await until("the unsubscribe", () => unsubscribed().includes(chatUri(1)));
    expect(unsubscribed()).toContain(sessionUri(1));
    expect(r.conn.chat(sessionUri(1))).toBeUndefined();
    // a read takes the lease again
    expect((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).status).toBe(200);
    expect(r.conn.chat(sessionUri(1))).toBeDefined();
  });

  it("a resubscribe that fails after a reconnect drops the watch, and the next read subscribes again", async () => {
    const r = await rig();
    const path = `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`;
    expect((await call(r, path)).status).toBe(200);
    // the host restarts, and the new one fails the first resubscribe of this session
    await r.fake.stop();
    await until("the drop", () => r.conn.state().state !== "connected");
    const entries = r.entries;
    const second = await fakeAgentHost({
      sessions: [summary(1), summary(2)], states: { [sessionUri(1)]: sessionState(1), [sessionUri(2)]: sessionState(2) },
      chats: { [chatUri(1)]: chatState(1), [chatUri(2)]: chatState(2) }, models: [MODEL], entryDir: entries, failSubscribes: { [sessionUri(1)]: 1 },
    });
    cleanups.push(() => second.stop());
    tokens.push(second.token);
    await until("reconnected", () => r.conn.state().state === "connected");
    const subscribes = () => second.requests.filter((entry) => entry.method === "subscribe" && (entry.params as { channel: string }).channel === sessionUri(1)).length;
    await until("the failed resubscribe", () => subscribes() === 1 && !r.conn.watching(sessionUri(1)));
    // the phone's lease is still held: its renewal (or next read) subscribes again and reads the chat
    expect((await call(r, "/api/host-chats/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
    expect(subscribes()).toBe(2);
    const read = await call(r, path);
    expect({ status: read.status, session: read.json.session }).toEqual({ status: 200, session: sessionUri(1) });
    // nothing was re-sent: only the watch's active-client mark
    expect(second.dispatched.map((entry) => String(entry.action.type))).toEqual(["session/activeClientSet"]);
  });

  it("rename dispatches session/titleChanged on the session's channel, as VS Code's renameSession does, and the list and the chat's read show the new title", async () => {
    const r = await rig();
    expect(await call(r, "/api/host-chats/chat/rename", { session: sessionUri(1), title: "  FICTIONAL renamed  " })).toEqual({ status: 200, json: { ok: true } });
    await until("the title action", () => actions(r.fake, "session/titleChanged").length > 0);
    expect(actions(r.fake, "session/titleChanged")).toEqual([{ channel: sessionUri(1), action: { type: "session/titleChanged", title: "FICTIONAL renamed" } }]);
    // the host leaves the chat's own title as it was: the read names the chat by its session's, as the list does
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.json.title).toBe("FICTIONAL renamed");
    await until("the list to follow", () => r.conn.summaries().find((s) => s.resource === sessionUri(1))?.title === "FICTIONAL renamed");
    const row = (await call(r, "/api/host-chats/chats")).json.chats.find((each: { session: string }) => each.session === sessionUri(1));
    expect(row.title).toBe("FICTIONAL renamed");
  });

  it("rename_empty_title_400", async () => {
    const r = await rig();
    for (const title of ["", "   ", undefined, 7]) {
      const answer = await call(r, "/api/host-chats/chat/rename", { session: sessionUri(1), title });
      expect({ title, status: answer.status, code: answer.json.error.code }).toEqual({ title, status: 400, code: "missing_title" });
    }
    expect(actions(r.fake, "session/titleChanged")).toEqual([]);
  });

  it("read dispatches chat/isReadChanged on the chat's channel, and the row's unread follows both ways", async () => {
    const r = await rig();
    const row = async () => (await call(r, "/api/host-chats/chats")).json.chats.find((each: { session: string }) => each.session === sessionUri(1));
    expect((await row()).unread).toBe(true);
    expect(await call(r, "/api/host-chats/chat/read", { session: sessionUri(1), read: true })).toEqual({ status: 200, json: { ok: true } });
    await until("read", () => (r.conn.summaries().find((s) => s.resource === sessionUri(1))!.status & 32) !== 0);
    expect((await row()).unread).toBe(false);
    expect(await call(r, "/api/host-chats/chat/read", { session: sessionUri(1), read: false })).toEqual({ status: 200, json: { ok: true } });
    await until("unread", () => (r.conn.summaries().find((s) => s.resource === sessionUri(1))!.status & 32) === 0);
    expect((await row()).unread).toBe(true);
    expect(actions(r.fake, "chat/isReadChanged")).toEqual([
      { channel: chatUri(1), action: { type: "chat/isReadChanged", isRead: true } },
      { channel: chatUri(1), action: { type: "chat/isReadChanged", isRead: false } },
    ]);
    const bad = await call(r, "/api/host-chats/chat/read", { session: sessionUri(1), read: "yes" });
    expect({ status: bad.status, code: bad.json.error.code }).toEqual({ status: 400, code: "invalid_read" });
  });

  it("archive dispatches session/isArchivedChanged on the session (the host refuses it on a default chat), and the row's archived follows both ways", async () => {
    const r = await rig();
    const row = async () => (await call(r, "/api/host-chats/chats")).json.chats.find((each: { session: string }) => each.session === sessionUri(1));
    expect(await call(r, "/api/host-chats/chat/archive", { session: sessionUri(1), archived: true })).toEqual({ status: 200, json: { ok: true } });
    await until("archived", () => (r.conn.summaries().find((s) => s.resource === sessionUri(1))!.status & 64) !== 0);
    expect((await row()).archived).toBe(true);
    expect(await call(r, "/api/host-chats/chat/archive", { session: sessionUri(1), archived: false })).toEqual({ status: 200, json: { ok: true } });
    await until("restored", () => (r.conn.summaries().find((s) => s.resource === sessionUri(1))!.status & 64) === 0);
    expect((await row()).archived).toBe(false);
    expect(actions(r.fake, "session/isArchivedChanged")).toEqual([
      { channel: sessionUri(1), action: { type: "session/isArchivedChanged", isArchived: true } },
      { channel: sessionUri(1), action: { type: "session/isArchivedChanged", isArchived: false } },
    ]);
    const bad = await call(r, "/api/host-chats/chat/archive", { session: sessionUri(1) });
    expect({ status: bad.status, code: bad.json.error.code }).toEqual({ status: 400, code: "invalid_archived" });
  });

  it("delete asks the host to disposeSession, cancels nothing on an idle chat, and the chat leaves the list", async () => {
    const r = await rig();
    expect(await call(r, "/api/host-chats/chat/delete", { session: sessionUri(1) })).toEqual({ status: 200, json: { ok: true } });
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession").map((entry) => entry.params)).toEqual([{ channel: sessionUri(1) }]);
    expect(actions(r.fake, "chat/turnCancelled")).toEqual([]);
    await until("the list to drop it", () => !r.conn.summaries().some((s) => s.resource === sessionUri(1)));
    expect((await call(r, "/api/host-chats/chats")).json.chats.map((row: { session: string }) => row.session)).toEqual([sessionUri(2)]);
    // it is gone: a second delete finds nothing
    const again = await call(r, "/api/host-chats/chat/delete", { session: sessionUri(1) });
    expect({ status: again.status, code: again.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
  });

  it("delete still disposes a listed chat whose session the host will not open (an old chat), and it leaves the list", async () => {
    const r = await rig({ failSubscribes: { [sessionUri(1)]: 99 } });
    expect(await call(r, "/api/host-chats/chat/delete", { session: sessionUri(1) })).toEqual({ status: 200, json: { ok: true } });
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession").map((entry) => entry.params)).toEqual([{ channel: sessionUri(1) }]);
    await until("the list to drop it", () => !r.conn.summaries().some((s) => s.resource === sessionUri(1)));
  });

  it("delete_running_chat_cancels_first", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active() }), [chatUri(2)]: chatState(2) } });
    expect(await call(r, "/api/host-chats/chat/delete", { session: sessionUri(1) })).toEqual({ status: 200, json: { ok: true } });
    expect(actions(r.fake, "chat/turnCancelled")).toEqual([{ channel: chatUri(1), action: { type: "chat/turnCancelled", turnId: "turn-live", duration: 0 } }]);
    // the cancel is on the wire before the dispose
    const order = r.fake.requests.map((entry) => entry.method === "dispatchAction" ? String((entry.params as { action: { type: string } }).action.type) : entry.method)
      .filter((each) => each === "chat/turnCancelled" || each === "disposeSession");
    expect(order).toEqual(["chat/turnCancelled", "disposeSession"]);
  });

  it("the session actions take only a known Copilot session, and answer 503 with the host down", async () => {
    const other = "claude:/fictional-other";
    const r = await rig({
      sessions: [summary(1), { ...summary(2), resource: other, provider: "claude" }],
      states: { [sessionUri(1)]: sessionState(1), [other]: { ...sessionState(2), provider: "claude" } as SessionState },
    });
    const bodies = (session: string) => [
      ["/api/host-chats/chat/rename", { session, title: "FICTIONAL x" }], ["/api/host-chats/chat/read", { session, read: true }],
      ["/api/host-chats/chat/archive", { session, archived: true }], ["/api/host-chats/chat/delete", { session }],
    ] as const;
    for (const session of [other, sessionUri(9)]) {
      for (const [path, body] of bodies(session)) {
        const answer = await call(r, path, body);
        expect({ path, session, status: answer.status, code: answer.json.error?.code }).toEqual({ path, session, status: 404, code: "host_chat_missing" });
      }
    }
    for (const [path] of bodies("")) {
      const answer = await call(r, path, {});
      expect({ path, status: answer.status, code: answer.json.error?.code }).toEqual({ path, status: 400, code: "missing_session" });
    }
    expect(r.fake.dispatched.filter((entry) => entry.channel !== "ahp-root://" && entry.action.type !== "session/activeClientSet")).toEqual([]);
    expect(r.fake.requests.filter((entry) => entry.method === "disposeSession")).toEqual([]);
    const { home, env } = homeWithRegistry();
    const down = { conn: connectionAt(home, env), clock: manualClock() };
    await until("the connection to wait", () => down.conn.state().state === "waiting");
    for (const [path, body] of bodies(sessionUri(1))) {
      const answer = await call(down, path, body);
      expect({ path, status: answer.status, code: answer.json.error.code }).toEqual({ path, status: 503, code: "agent_host_down" });
    }
  });

  it("no route response carries the host's token", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR]), [chatUri(2)]: chatState(2, { status: 8, activeTurn: active() }) } });
    const s = sessionUri(1);
    // `call` asserts every body against every fake host's token; this walks each route, ok and refused
    const seen: number[] = [];
    for (const [path, body] of [
      ["/api/host-chats/state", undefined], ["/api/host-chats/chats", undefined], [`/api/host-chats/chat?session=${encodeURIComponent(s)}`, undefined],
      [`/api/host-chats/chat?session=${encodeURIComponent(s)}&before=nope`, undefined], [`/api/host-chats/models?session=${encodeURIComponent(s)}`, undefined],
      ["/api/host-chats/chat/watch", { session: s }], ["/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(2), text: "FICTIONAL q" }],
      ["/api/host-chats/chat/answer", { session: s, request_id: "req-1", question_id: "q-color", option_ids: ["red"] }],
      ["/api/host-chats/chat/confirm", { session: s, turn_id: "x", tool_call_id: "y", approved: true }],
      ["/api/host-chats/chat/draft", { session: s, model: { id: "fictional/model-a" } }],
      ["/api/host-chats/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL new" }],
      ["/api/host-chats/chat/send", { id: crypto.randomUUID(), session: "copilotcli:/nope", text: "x" }], ["/api/host-chats/nothing", undefined],
    ] as const) seen.push((await call(r, path, body)).status);
    expect(tokens).toContain(r.fake.token);
    expect(seen.length).toBe(13);
  });
});

// ─── Images and tool output ──────────────────────────────────────────────────

/** A route call whose answer may be bytes: the raw response, still never carrying the host's token. */
async function fetchRaw(rig: { conn: AgentHost; clock: LeaseClock }, path: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
  const response = await hostChatsRoute(get(path), new URL(`http://127.0.0.1${path}`).pathname, rig.conn, rig.clock)!;
  const bytes = Buffer.from(await response.arrayBuffer());
  for (const token of tokens) expect(bytes.toString("latin1")).not.toContain(token);
  return { status: response.status, type: response.headers.get("content-type"), bytes };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xfe, 0xff]);
const LONG_OUTPUT = `FICTIONAL ${"line of output\n".repeat(600)}`;
const withResults = (): ChatState => {
  const result = (content: unknown[]) => ({ success: true, pastTenseMessage: "FICTIONAL done", content }) as ToolCallResult;
  const call = (toolCallId: string) => ({ toolCallId, toolName: "screenshot", displayName: "Screenshot", invocationMessage: "FICTIONAL shooting" });
  return reducedChat([
    { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: user("FICTIONAL look") } as StateAction,
    ...toolCallActions("turn-1", call("c1"), result([{ type: "embeddedResource", data: PNG_BYTES.toString("base64"), contentType: "image/png" }])),
    ...toolCallActions("turn-1", call("c2"), result([{ type: "text", text: LONG_OUTPUT }])),
    { type: "chat/turnComplete", turnId: "turn-1", duration: 1000 } as StateAction,
  ], chatState(1));
};
const imagePath = (ref: string, n = 1) => `/api/host-chats/image?session=${encodeURIComponent(sessionUri(n))}&ref=${encodeURIComponent(ref)}`;

describe("host chat send modes: steer, queue, stop and send", () => {
  const busy = (overrides: Record<string, unknown> = {}) => rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active(), ...overrides }), [chatUri(2)]: chatState(2) } });
  const sendAs = (r: Rig, mode: string, text: string, id: string = crypto.randomUUID()) =>
    call(r, "/api/host-chats/chat/send", { id, session: sessionUri(1), text, mode });

  it("steer_sets_steering_pending", async () => {
    const r = await busy();
    const id = crypto.randomUUID();
    expect(await sendAs(r, "steer", "FICTIONAL steer", id)).toEqual({ status: 200, json: { queued: true } });
    await until("the steering message", () => r.conn.chat(sessionUri(1))?.steeringMessage?.id === id);
    expect(only(r.fake, "chat/pendingMessageSet")).toMatchObject({ kind: "steering", id, message: { text: "FICTIONAL steer" } });
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
  });

  it("queue_sets_queued", async () => {
    const r = await busy();
    expect((await sendAs(r, "queue", "FICTIONAL later")).json).toEqual({ queued: true });
    await until("the queued message", () => actions(r.fake, "chat/pendingMessageSet").length > 0);
    expect(only(r.fake, "chat/pendingMessageSet")).toMatchObject({ kind: "queued", message: { text: "FICTIONAL later" } });
  });

  it("send while busy queues, as before; steer or queue on an idle chat starts a turn", async () => {
    const r = await busy();
    expect((await sendAs(r, "send", "FICTIONAL plain")).json).toEqual({ queued: true });
    await until("the queued message", () => actions(r.fake, "chat/pendingMessageSet").length > 0);
    expect(only(r.fake, "chat/pendingMessageSet")["kind"]).toBe("queued");
    const idle = await rig();
    for (const mode of ["steer", "queue", "stop_and_send"]) {
      expect((await call(idle, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(2), text: `FICTIONAL ${mode}`, mode })).json).toEqual({ queued: false });
      await until(`the ${mode} turn`, () => idle.conn.chat(sessionUri(2))?.activeTurn !== undefined);
      idle.fake.push(chatUri(2), { type: "chat/turnComplete", turnId: idle.conn.chat(sessionUri(2))!.activeTurn!.id, duration: 1 } as unknown as StateAction);
      await until(`the ${mode} turn to end`, () => idle.conn.chat(sessionUri(2))?.activeTurn === undefined);
    }
    expect(actions(idle.fake, "chat/turnStarted").length).toBe(3);
    expect(actions(idle.fake, "chat/pendingMessageSet")).toEqual([]);
  });

  it("second_steer_joins_the_first: one steering message holds both texts in order, under the first id", async () => {
    const first = uuid(41);
    const r = await busy({ steeringMessage: { id: first, message: user("FICTIONAL first") } });
    const second = await sendAs(r, "steer", "FICTIONAL second");
    expect(second).toEqual({ status: 200, json: { queued: true, joined: true } });
    await until("the joined steer", () => r.conn.chat(sessionUri(1))?.steeringMessage?.message.text === "FICTIONAL first\n\nFICTIONAL second");
    expect(only(r.fake, "chat/pendingMessageSet")).toMatchObject({ kind: "steering", id: first, message: { text: "FICTIONAL first\n\nFICTIONAL second" } });
  });

  it("second_steer_keeps_the_first_steers_attachments, then its own", async () => {
    const shot = { type: "embeddedResource", label: "shot.png", displayKind: "image", data: "AAAA", contentType: "image/png" };
    const r = await busy({ steeringMessage: { id: uuid(43), message: { ...user("FICTIONAL look"), attachments: [shot] } } });
    expect((await sendAs(r, "steer", "FICTIONAL and this")).json).toEqual({ queued: true, joined: true });
    await until("the joined steer", () => actions(r.fake, "chat/pendingMessageSet").length > 0);
    expect(only(r.fake, "chat/pendingMessageSet")["message"]["attachments"]).toEqual([shot]);
  });

  it("stop_and_send_waits_for_turn_end: cancels, then starts a turn with the text; queued messages stay queued", async () => {
    const queued = { id: uuid(42), message: user("FICTIONAL waiting") };
    const r = await busy({ queuedMessages: [queued] });
    const id = crypto.randomUUID();
    const pending = sendAs(r, "stop_and_send", "FICTIONAL instead", id);
    await until("the cancel", () => actions(r.fake, "chat/turnCancelled").length > 0);
    expect(only(r.fake, "chat/turnCancelled")).toMatchObject({ turnId: "turn-live" });
    // the host ends the turn on the cancel (the fake's reducer did, on the dispatched action)
    expect((await pending).json).toEqual({ queued: false });
    await until("the new turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === id);
    expect(only(r.fake, "chat/turnStarted")).toMatchObject({ turnId: id, message: { text: "FICTIONAL instead" } });
    expect(r.conn.chat(sessionUri(1))?.queuedMessages).toEqual([queued] as unknown as NonNullable<ChatState["queuedMessages"]>);
  });

  it("stop_and_send_times_out_10s_without_sending", async () => {
    const r = await busy();
    // a host that never ends the turn: its cancel is swallowed
    const dispatch = r.conn.dispatch.bind(r.conn);
    let cancelled = 0;
    (r.conn as { dispatch: AgentHost["dispatch"] }).dispatch = (channel, action) => { if (action.type === "chat/turnCancelled") cancelled += 1; else dispatch(channel, action); };
    const pending = call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL never", mode: "stop_and_send" });
    let settled = false;
    void pending.then(() => { settled = true; });
    await until("the cancel", () => cancelled === 1);
    r.clock.advance(STOP_AND_SEND_WAIT_MS - 1);
    // fixed wait: proving the answer does not come before the deadline (nothing arrives)
    await Bun.sleep(50);
    expect(settled).toBe(false);
    r.clock.advance(1);
    const answer = await pending;
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("turn_still_running");
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    expect(actions(r.fake, "chat/pendingMessageSet")).toEqual([]);
  });

  it("same_id_twice_dispatches_once for each mode", async () => {
    for (const mode of ["send", "steer", "queue"]) {
      const r = await busy();
      const id = crypto.randomUUID();
      expect((await sendAs(r, mode, `FICTIONAL ${mode}`, id)).json).toMatchObject({ queued: true });
      await until(`the ${mode} message`, () => actions(r.fake, "chat/pendingMessageSet").length > 0);
      expect((await sendAs(r, mode, `FICTIONAL ${mode}`, id)).json).toMatchObject({ queued: true });
      expect({ mode, sets: actions(r.fake, "chat/pendingMessageSet").length }).toEqual({ mode, sets: 1 });
    }
    const r = await busy();
    const id = crypto.randomUUID();
    expect((await sendAs(r, "stop_and_send", "FICTIONAL once", id)).json).toEqual({ queued: false });
    await until("the new turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === id);
    expect((await sendAs(r, "stop_and_send", "FICTIONAL once", id)).json).toEqual({ queued: false });
    expect(actions(r.fake, "chat/turnCancelled").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
  });

  it("an unknown mode is refused before anything goes", async () => {
    const r = await busy();
    const refused = await sendAs(r, "FICTIONAL-mode", "FICTIONAL x");
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 400, code: "invalid_mode" });
    expect(actions(r.fake, "chat/pendingMessageSet")).toEqual([]);
  });

  it("stop cancels the running turn, and does nothing on an idle chat", async () => {
    const r = await busy();
    expect(await call(r, "/api/host-chats/chat/stop", { session: sessionUri(1) })).toEqual({ status: 200, json: { ok: true } });
    await until("the cancel", () => actions(r.fake, "chat/turnCancelled").length > 0);
    expect(only(r.fake, "chat/turnCancelled")).toMatchObject({ type: "chat/turnCancelled", turnId: "turn-live" });
    expect(await call(r, "/api/host-chats/chat/stop", { session: sessionUri(2) })).toEqual({ status: 200, json: { ok: true } });
    expect(actions(r.fake, "chat/turnCancelled").length).toBe(1);
  });

  it("resume tries the latest turn again when it stopped at a resumable error, and refuses anything else", async () => {
    const errored = (resumable: boolean) => ({ id: "turn-bad", startedAt: "2026-01-01T00:00:00.000Z", duration: 10, state: "error", usage: undefined, message: user("FICTIONAL go"),
      responseParts: [{ kind: "error", ...(resumable ? { resumable: true } : {}), error: { errorType: "query", message: "FICTIONAL 502" } }] });
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { turns: [errored(true)] }), [chatUri(2)]: chatState(2, { turns: [errored(false)] }) } });
    expect(await call(r, "/api/host-chats/chat/resume", { session: sessionUri(1) })).toEqual({ status: 200, json: { ok: true } });
    await until("the resume", () => actions(r.fake, "chat/turnResume").length > 0);
    expect(only(r.fake, "chat/turnResume")).toEqual({ type: "chat/turnResume", turnId: "turn-bad" });
    const refused = await call(r, "/api/host-chats/chat/resume", { session: sessionUri(2) });
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 409, code: "not_resumable" });
    expect(actions(r.fake, "chat/turnResume").length).toBe(1);
  });

  it("pending/remove takes a steering or queued message off by its id, and refuses one the chat does not hold", async () => {
    const r = await busy({ steeringMessage: { id: uuid(43), message: user("FICTIONAL steer") }, queuedMessages: [{ id: uuid(44), message: user("FICTIONAL queued") }] });
    expect(await call(r, "/api/host-chats/chat/pending/remove", { session: sessionUri(1), id: uuid(44) })).toEqual({ status: 200, json: { ok: true } });
    expect(await call(r, "/api/host-chats/chat/pending/remove", { session: sessionUri(1), id: uuid(43) })).toEqual({ status: 200, json: { ok: true } });
    await until("both removals", () => actions(r.fake, "chat/pendingMessageRemoved").length === 2);
    expect(actions(r.fake, "chat/pendingMessageRemoved").map((entry) => entry.action)).toEqual([
      { type: "chat/pendingMessageRemoved", kind: "queued", id: uuid(44) }, { type: "chat/pendingMessageRemoved", kind: "steering", id: uuid(43) },
    ]);
    await until("both gone", () => r.conn.chat(sessionUri(1))?.steeringMessage === undefined && (r.conn.chat(sessionUri(1))?.queuedMessages ?? []).length === 0);
    const gone = await call(r, "/api/host-chats/chat/pending/remove", { session: sessionUri(1), id: uuid(45) });
    expect({ status: gone.status, code: gone.json.error.code }).toEqual({ status: 409, code: "pending_gone" });
  });

  it("background/stop sends VS Code's stop for a stoppable shell, and refuses work that is not or is gone", async () => {
    const shell = (id: string, stoppable: boolean) => ({ kind: "shell", id, label: "FICTIONAL server", command: "npm run dev", startedAt: AT, ...(stoppable ? { _meta: { "vscode.stopBackgroundWork": true } } : {}) });
    const r = await busy({ backgroundWork: [shell("shell:1", true), shell("shell:2", false)] });
    expect(await call(r, "/api/host-chats/chat/background/stop", { session: sessionUri(1), id: "shell:1" })).toEqual({ status: 200, json: { stopped: true } });
    expect(r.fake.requests.filter((each) => each.method === "vscode/stopBackgroundWork").map((each) => each.params)).toEqual([{ chat: chatUri(1), id: "shell:1" }]);
    for (const id of ["shell:2", "shell:9"]) {
      const refused = await call(r, "/api/host-chats/chat/background/stop", { session: sessionUri(1), id });
      expect({ id, status: refused.status, code: refused.json.error.code }).toEqual({ id, status: 409, code: "not_stoppable" });
    }
    const bare = await call(r, "/api/host-chats/chat/background/stop", { session: sessionUri(1) });
    expect({ status: bare.status, code: bare.json.error.code }).toEqual({ status: 400, code: "missing_id" });
  });

  it("a read lists the session's / commands: its enabled skills, prompts and agents", async () => {
    const r = await rig();
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.json.commands).toEqual([{ name: "Report", description: "FICTIONAL writes a report", kind: "agent" }]);
  });

  it("a read adds the skills the host completes for \"/\" on the session (a plugin's skills are only there)", async () => {
    const skill = (name: string, description?: string) => ({ insertText: `/${name} `, rangeStart: 0, rangeEnd: 1, attachment: { type: "simple", label: name, _meta: { command: name, isSkill: true, ...(description ? { description } : {}) } } });
    const r = await rig({ completions: { [sessionUri(1)]: [
      { insertText: "/compact ", rangeStart: 0, rangeEnd: 1, attachment: { type: "simple", label: "compact", _meta: { command: "compact", description: "FICTIONAL compact" } } },
      skill("fictional-plugin:brainstorm", "FICTIONAL brainstorm"), skill("Report"), skill("fictional-bare"),
    ] } });
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.json.commands).toEqual([
      { name: "Report", description: "FICTIONAL writes a report", kind: "agent" },
      { name: "fictional-plugin:brainstorm", description: "FICTIONAL brainstorm", kind: "skill" },
      { name: "fictional-bare", description: "", kind: "skill" },
    ]);
    const asked = r.fake.requests.filter((each) => each.method === "completions").map((each) => each.params as Record<string, unknown>);
    expect(asked[0]).toMatchObject({ kind: "userMessage", channel: sessionUri(1), text: "/", offset: 1 });
    await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(r.fake.requests.filter((each) => each.method === "completions").length).toBe(1);
  });

  it("a new chat, whose runtime has not started (no skills in its completions), lists the newest chat's skills until it has its own", async () => {
    const skill = (name: string) => ({ insertText: `/${name} `, rangeStart: 0, rangeEnd: 1, attachment: { type: "simple", label: name, _meta: { command: name, isSkill: true } } });
    const builtIn = { insertText: "/compact ", rangeStart: 0, rangeEnd: 1, attachment: { type: "simple", label: "compact", _meta: { command: "compact" } } };
    const completions: Record<string, unknown[]> = { [sessionUri(1)]: [builtIn], [sessionUri(2)]: [builtIn, skill("fictional-plugin:brainstorm")] };
    const r = await rig({ sessions: [summary(1), summary(2)], completions });
    const names = async () => ((await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.commands as Array<{ name: string }>).map((each) => each.name);
    expect(await names()).toContain("fictional-plugin:brainstorm");
    // borrowed, not kept: once its own runtime lists skills, the next read has its own
    completions[sessionUri(1)] = [builtIn, skill("fictional-own")];
    const own = await names();
    expect(own).toContain("fictional-own");
    expect(own).not.toContain("fictional-plugin:brainstorm");
  });

  it("files lists the chat's folder for @, and refuses a session it does not know", async () => {
    const folder = temp();
    mkdirSync(join(folder, "src"), { recursive: true });
    await Bun.write(join(folder, "src", "fictional-build.ts"), "x");
    await Bun.write(join(folder, "README.md"), "x");
    const where = (n: number) => ({ ...summary(n), workingDirectories: [`file://${folder}`] });
    const r = await rig({ sessions: [where(1), summary(2)] });
    const found = await call(r, `/api/host-chats/files?session=${encodeURIComponent(sessionUri(1))}&q=build&limit=5`);
    expect(found).toEqual({ status: 200, json: { files: ["src/fictional-build.ts"] } });
    const missing = await call(r, `/api/host-chats/files?session=${encodeURIComponent(sessionUri(9))}&q=x`);
    expect({ status: missing.status, code: missing.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
  });

  it("a read lists the pending messages, steering first, in the chat's order", async () => {
    const r = await busy({ steeringMessage: { id: uuid(46), message: user("FICTIONAL steer") }, queuedMessages: [{ id: uuid(47), message: user("FICTIONAL q1") }, { id: uuid(48), message: user("FICTIONAL q2") }] });
    const read = await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.json.pending).toEqual([
      { id: uuid(46), kind: "steering", text: "FICTIONAL steer" }, { id: uuid(47), kind: "queued", text: "FICTIONAL q1" }, { id: uuid(48), kind: "queued", text: "FICTIONAL q2" },
    ]);
  });
});

describe("host chat session config: mode and permissions", () => {
  // the live shape (the Mac's agent host, 2026-10-18): mode and autoApprove with labels, the
  // approval modes this host offers, and the one in effect
  const CONFIG = {
    schema: { type: "object", properties: {
      mode: { type: "string", title: "Agent Mode", enum: ["interactive", "plan", "autopilot"], enumLabels: ["Interactive", "Plan", "Autopilot"], sessionMutable: true },
      autoApprove: { type: "string", title: "Approvals", enum: ["default", "assisted", "autoApprove"], enumLabels: ["Manual permissions", "Assisted permissions", "Allow all"], sessionMutable: true },
      availableApprovalModes: { type: "array", title: "Available Permissions" },
      isolation: { type: "string", title: "Isolation", enum: ["folder"], sessionMutable: false },
    } },
    values: { mode: "interactive", autoApprove: "default", availableApprovalModes: ["default", "assisted", "autoApprove"], isolation: "folder" },
  };
  const configured = () => rig({ states: { [sessionUri(1)]: { ...sessionState(1), config: CONFIG } as unknown as SessionState, [sessionUri(2)]: sessionState(2) } });

  it("config_reads_live_values", async () => {
    const r = await configured();
    const read = await call(r, `/api/host-chats/session/config?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read).toEqual({ status: 200, json: { mode: "interactive", approvals: "default", modes: ["interactive", "plan", "autopilot"], approvalModes: ["default", "assisted", "autoApprove"] } });
    // a session whose host sends no config: nothing to pick
    expect((await call(r, `/api/host-chats/session/config?session=${encodeURIComponent(sessionUri(2))}`)).json).toEqual({ mode: null, approvals: null, modes: [], approvalModes: [] });
  });

  it("config_change_merges: dispatches only the changed key, and the read follows", async () => {
    const r = await configured();
    expect(await call(r, "/api/host-chats/session/config", { session: sessionUri(1), mode: "plan" })).toEqual({ status: 200, json: { ok: true } });
    await until("the config change", () => actions(r.fake, "session/configChanged").length > 0);
    expect(actions(r.fake, "session/configChanged")).toEqual([{ channel: sessionUri(1), action: { type: "session/configChanged", config: { mode: "plan" } } }]);
    await until("the mirror", () => (r.conn.mirror().getSession(sessionUri(1)) as { config?: { values: Record<string, unknown> } } | undefined)?.config?.values["mode"] === "plan");
    expect((await call(r, `/api/host-chats/session/config?session=${encodeURIComponent(sessionUri(1))}`)).json).toMatchObject({ mode: "plan", approvals: "default" });
    expect(await call(r, "/api/host-chats/session/config", { session: sessionUri(1), approvals: "autoApprove" })).toEqual({ status: 200, json: { ok: true } });
    await until("the second change", () => actions(r.fake, "session/configChanged").length === 2);
    expect(actions(r.fake, "session/configChanged")[1]!.action).toEqual({ type: "session/configChanged", config: { autoApprove: "autoApprove" } });
  });

  it("config_unknown_mode_400, an approval mode this host does not offer is 400, and nothing goes", async () => {
    const r = await configured();
    for (const [body, code] of [[{ mode: "FICTIONAL" }, "invalid_mode"], [{ approvals: "yolo" }, "invalid_approvals"], [{}, "missing_config"]] as const) {
      const refused = await call(r, "/api/host-chats/session/config", { session: sessionUri(1), ...body });
      expect({ code, status: refused.status, got: refused.json.error.code }).toEqual({ code, status: 400, got: code });
    }
    expect(actions(r.fake, "session/configChanged")).toEqual([]);
  });
});

describe("host chat attachments", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const inFolder = async () => {
    const folder = temp();
    const where = (n: number) => ({ ...summary(n), workingDirectories: [`file://${folder}`] });
    const noFolder = { ...summary(2), workingDirectories: [] };
    return { folder, r: await rig({ sessions: [where(1), noFolder] }) };
  };

  it("upload_writes_into_chat_folder: under <cwd>/.herdr-web-ui/, and the answer gives its path", async () => {
    const { folder, r } = await inFolder();
    const up = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "shot.png", media_type: "image/png", data: PNG });
    expect(up.status).toBe(200);
    expect(up.json.path.startsWith(join(folder, ".herdr-web-ui") + "/")).toBe(true);
    expect(readFileSync(up.json.path).toString("base64")).toBe(PNG);
    const text = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "notes.txt", media_type: "text/plain", data: Buffer.from("FICTIONAL").toString("base64") });
    expect(text.json.path).toMatch(/\/notes-[^/]+\.txt$/);
  });

  it("upload_without_folder_409, an unknown session 404, a bad body 400", async () => {
    const { r } = await inFolder();
    const none = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(2), name: "shot.png", media_type: "image/png", data: PNG });
    expect({ status: none.status, code: none.json.error.code }).toEqual({ status: 409, code: "no_folder" });
    const unknown = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(9), name: "shot.png", media_type: "image/png", data: PNG });
    expect(unknown.status).toBe(404);
    const bad = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "shot.png", media_type: "image/png" });
    expect({ status: bad.status, code: bad.json.error.code }).toEqual({ status: 400, code: "invalid_upload" });
  });

  it("upload_limit_is_the_panes: a file over it is 413 image_too_large with its reason, a 20 MiB one is stored whole", async () => {
    const { r } = await inFolder();
    const over = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "big.zip", media_type: "application/zip", data: Buffer.alloc(40 * 1024 * 1024, 1).toString("base64") });
    expect({ status: over.status, code: over.json.error.code }).toEqual({ status: 413, code: "image_too_large" });
    const whole = Buffer.alloc(20 * 1024 * 1024, 7);
    const kept = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "big.zip", media_type: "application/zip", data: whole.toString("base64") });
    expect(kept.status).toBe(200);
    expect(readFileSync(kept.json.path).byteLength).toBe(whole.byteLength);
  });

  it("a chat whose folder is gone or cannot be written takes no file, and says which: nothing is made", async () => {
    const { folder, r } = await inFolder();
    rmSync(folder, { recursive: true, force: true });
    const gone = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "shot.png", media_type: "image/png", data: PNG });
    expect({ status: gone.status, code: gone.json.error.code }).toEqual({ status: 409, code: "no_folder" });
    expect(existsSync(folder)).toBe(false);
    mkdirSync(folder);
    chmodSync(folder, 0o500);
    try {
      const locked = await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "shot.png", media_type: "image/png", data: PNG });
      expect({ status: locked.status, code: locked.json.error.code }).toEqual({ status: 409, code: "folder_not_writable" });
    } finally { chmodSync(folder, 0o700); }
  });

  it("an image picked with @ over the attachment limit is refused before it is read", async () => {
    const { folder, r } = await inFolder();
    writeFileSync(join(folder, "huge.png"), "");
    truncateSync(join(folder, "huge.png"), MAX_ATTACHMENT_BYTES + 1);
    const refused = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL x", attachments: [{ path: "huge.png" }] });
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 413, code: "image_too_large" });
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
  });

  it("send_image_attachment_is_embedded and send_file_attachment_is_resource", async () => {
    const { r } = await inFolder();
    const image = (await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "shot.png", media_type: "image/png", data: PNG })).json.path as string;
    const file = (await call(r, "/api/host-chats/chat/upload", { session: sessionUri(1), name: "notes.txt", media_type: "text/plain", data: Buffer.from("FICTIONAL").toString("base64") })).json.path as string;
    const sent = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL look",
      attachments: [{ path: image, media_type: "image/png", name: "shot.png" }, { path: file, media_type: "text/plain", name: "notes.txt" }] });
    expect(sent.status).toBe(200);
    await until("the turn", () => actions(r.fake, "chat/turnStarted").length > 0);
    expect(only(r.fake, "chat/turnStarted")["message"]["attachments"]).toEqual([
      { type: "embeddedResource", label: "shot.png", displayKind: "image", data: PNG, contentType: "image/png" },
      { type: "resource", label: "notes.txt", displayKind: "document", uri: `file://${file}`, contentType: "text/plain" },
    ]);
  });

  it("a file of the chat's folder (an @ pick) goes by its path, relative or not; an image there is embedded", async () => {
    const { folder, r } = await inFolder();
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "main.ts"), "FICTIONAL");
    writeFileSync(join(folder, "logo.png"), Buffer.from(PNG, "base64"));
    const sent = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL read",
      attachments: [{ path: "src/main.ts" }, { path: join(folder, "logo.png") }] });
    expect(sent.status).toBe(200);
    await until("the turn", () => actions(r.fake, "chat/turnStarted").length > 0);
    expect(only(r.fake, "chat/turnStarted")["message"]["attachments"]).toEqual([
      { type: "resource", label: "main.ts", displayKind: "document", uri: `file://${realpathSync(join(folder, "src", "main.ts"))}` },
      { type: "embeddedResource", label: "logo.png", displayKind: "image", data: PNG, contentType: "image/png" },
    ]);
  });

  it("an attachment outside the chat's folder, or one that is gone, is refused and nothing is sent", async () => {
    const { folder, r } = await inFolder();
    const elsewhere = temp();
    writeFileSync(join(elsewhere, "secret.png"), Buffer.from(PNG, "base64"));
    symlinkSync(join(elsewhere, "secret.png"), join(folder, "link.png"));
    for (const path of ["/etc/hosts", join(folder, "link.png"), "link.png", `../${basename(elsewhere)}/secret.png`, join(folder, "..", basename(elsewhere), "secret.png"), "gone.png", 7]) {
      const refused = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL x", attachments: [{ path, media_type: "image/png" }] });
      expect({ path, status: refused.status, code: refused.json.error.code }).toEqual({ path, status: 400, code: "invalid_attachment" });
    }
    // a chat with no folder takes no attachment at all
    const none = await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(2), text: "FICTIONAL x", attachments: [{ path: "/etc/hosts" }] });
    expect({ status: none.status, code: none.json.error.code }).toEqual({ status: 400, code: "invalid_attachment" });
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
  });
});

describe("host chat image and tool-output routes", () => {
  it("image_route_serves_png_bytes", async () => {
    const r = await rig({ chats: { [chatUri(1)]: withResults(), [chatUri(2)]: chatState(2) } });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    // the transcript carries a ref, never the bytes
    expect(JSON.stringify(read)).not.toContain(PNG_BYTES.toString("base64"));
    const image = read.turns[1]!.parts.flatMap((part) => (part.kind === "tool" ? part.images ?? [] : []))[0]!;
    expect(image).toEqual({ media_type: "image/png", ref: "c1:0" });
    const served = await fetchRaw(r, imagePath(image.ref));
    expect(served.status).toBe(200);
    expect(served.type).toBe("image/png");
    expect(served.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("an answer's uploaded picture is served from the chat's .herdr-web-ui, and nothing else is", async () => {
    const folder = realpathSync(temp());
    mkdirSync(join(folder, ".herdr-web-ui"));
    writeFileSync(join(folder, ".herdr-web-ui", "paste-1.png"), PNG_BYTES);
    writeFileSync(join(folder, ".herdr-web-ui", "paste-2.png"), PNG_BYTES);
    writeFileSync(join(folder, "secret.png"), PNG_BYTES);
    symlinkSync(join(folder, "secret.png"), join(folder, ".herdr-web-ui", "link.png"));
    const answered = (out: string): ChatState => reducedChat([
      { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: user("FICTIONAL ask") } as StateAction,
      ...toolCallActions("turn-1", { toolCallId: "a1", toolName: "ask_user", displayName: "ask_user", invocationMessage: "ask_user", toolInput: JSON.stringify({ message: "FICTIONAL look?" }) },
        { success: true, pastTenseMessage: "Ask User", content: [{ type: "text", text: out }] } as ToolCallResult),
      { type: "chat/turnComplete", turnId: "turn-1", duration: 1000 } as StateAction,
    ], chatState(1));
    const r = await rig({
      sessions: [{ ...summary(1), workingDirectories: [`file://${folder}`] }, summary(2)],
      chats: { [chatUri(1)]: answered(`User responded:\nnotes: @${folder}/.herdr-web-ui/paste-1.png @${folder}/.herdr-web-ui/link.png`), [chatUri(2)]: chatState(2) },
    });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    expect(read.turns[1]!.parts[0]).toMatchObject({ kind: "question", custom: null, images: [{ ref: "answer:paste-1.png" }, { ref: "answer:link.png" }] });
    const shown = await fetchRaw(r, imagePath("answer:paste-1.png"));
    expect({ status: shown.status, type: shown.type, same: shown.bytes.equals(PNG_BYTES) }).toEqual({ status: 200, type: "image/png", same: true });
    // in the folder but named by no answer; a link out of it; a path; the folder's own file
    for (const ref of ["answer:paste-2.png", "answer:link.png", "answer:../secret.png", "answer:secret.png"]) {
      expect({ ref, status: (await fetchRaw(r, imagePath(ref))).status }).toEqual({ ref, status: 404 });
    }
  });

  it("image_route_unknown_ref_404", async () => {
    const r = await rig({ chats: { [chatUri(1)]: withResults(), [chatUri(2)]: chatState(2) } });
    for (const ref of ["c1:1", "c9:0", "c1", "c2:0", "c1:-1", "c1:", "c1:0x0", "c1:00", "c1: 0"]) {
      const answer = await call(r, imagePath(ref));
      expect({ ref, status: answer.status, code: answer.json.error.code }).toEqual({ ref, status: 404, code: "not_found" });
    }
    const missing = await call(r, imagePath("c1:0", 9));
    expect({ status: missing.status, code: missing.json.error.code }).toEqual({ status: 404, code: "host_chat_missing" });
    const bare = await call(r, `/api/host-chats/image?session=${encodeURIComponent(sessionUri(1))}`);
    expect({ status: bare.status, code: bare.json.error.code }).toEqual({ status: 400, code: "missing_ref" });
  });

  it("a cut tool output is served whole by its output_ref", async () => {
    const r = await rig({ chats: { [chatUri(1)]: withResults(), [chatUri(2)]: chatState(2) } });
    const read = (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;
    const cut = read.turns[1]!.parts.find((part) => part.kind === "tool" && part.output_ref !== undefined);
    expect(cut).toMatchObject({ output_ref: "c2", output_size: LONG_OUTPUT.length });
    const path = (ref: string) => `/api/host-chats/tool-output?session=${encodeURIComponent(sessionUri(1))}&ref=${encodeURIComponent(ref)}`;
    expect(await call(r, path("c2"))).toEqual({ status: 200, json: { output: LONG_OUTPUT } });
    const unknown = await call(r, path("c9"));
    expect({ status: unknown.status, code: unknown.json.error.code }).toEqual({ status: 404, code: "not_found" });
  });
});

describe("host chat checkpoints: Restore Checkpoint, Start Over and Redo (VS Code's)", () => {
  const A = "file:///tmp/fictional-repo/a.ts", B = "file:///tmp/fictional-repo/b.ts";
  const ref = (name: string) => `session-db:/tmp/fictional-repo/${name}?FICTIONAL`;
  /** a finished turn whose one tool call made these file edits */
  const editing = (id: string, text: string, edits: unknown[]): Turn => ({
    ...turn(id, text),
    responseParts: [{ kind: "toolCall", toolCall: {
      toolCallId: `${id}-call`, toolName: "edit", displayName: "Edit", status: "completed", invocationMessage: "Editing", confirmed: "not-needed",
      success: true, pastTenseMessage: "Edited", content: edits.map((edit) => ({ type: "fileEdit", ...(edit as object) })),
    } }, { kind: "markdown", id: `${id}-m`, content: `FICTIONAL done ${text}` }],
  } as unknown as Turn);
  // t1 edits a (v0 -> v1); t2 edits a (v1 -> v2) and creates b; t3 has no edits
  const turns = [
    editing("t1", "FICTIONAL one", [{ before: { uri: A, content: { uri: ref("a@0") } }, after: { uri: A, content: { uri: ref("a@1") } }, diff: { added: 1, removed: 1 } }]),
    editing("t2", "FICTIONAL two", [
      { before: { uri: A, content: { uri: ref("a@1") } }, after: { uri: A, content: { uri: ref("a@2") } }, diff: { added: 2, removed: 0 } },
      { after: { uri: B, content: { uri: ref("b@1") } }, diff: { added: 3, removed: 0 } },
    ]),
    turn("t3", "FICTIONAL three"),
  ];
  const files = { [ref("a@0")]: "a0", [ref("a@1")]: "a1", [ref("a@2")]: "a2", [ref("b@1")]: "b1", [A]: "a2", [B]: "b1" };
  const restoring = (overrides: Record<string, unknown> = {}) => rig({ files, chats: { [chatUri(1)]: chatState(1, { turns, ...overrides }), [chatUri(2)]: chatState(2) } });
  const read = async (r: Rig) => (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as HostChatRead;

  it("an edit's diff is its two sides as the host kept them, by the ref its part names", async () => {
    const r = await restoring();
    const diff = (ref: string) => call(r, `/api/host-chats/edit-diff?session=${encodeURIComponent(sessionUri(1))}&ref=${encodeURIComponent(ref)}`);
    const parts = (await read(r)).turns.flatMap((each) => each.parts).flatMap((part) => part.kind === "tool" ? part.edits ?? [] : []);
    expect(parts.map((edit) => [edit.ref, edit.kind])).toEqual([["t1-call:0", "edit"], ["t2-call:0", "edit"], ["t2-call:1", "create"]]);
    // the second turn's edit of a: what the file was after the first turn, and after this call
    expect(await diff("t2-call:0")).toEqual({ status: 200, json: { path: "/tmp/fictional-repo/a.ts", kind: "edit", before: "a1", after: "a2" } });
    expect(await diff("t2-call:1")).toEqual({ status: 200, json: { path: "/tmp/fictional-repo/b.ts", kind: "create", before: null, after: "b1" } });
    for (const ref of ["t2-call:2", "t9-call:0", "t2-call", "t2-call:01"]) {
      const answer = await diff(ref);
      expect({ ref, status: answer.status, code: answer.json.error.code }).toEqual({ ref, status: 404, code: "not_found" });
    }
  });

  it("an edit side the host no longer holds, or that is not text, says so instead of failing the diff", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]).toString("latin1");
    const r = await rig({ files: { ...files, [ref("a@1")]: binary }, chats: { [chatUri(1)]: chatState(1, { turns }), [chatUri(2)]: chatState(2) } });
    r.fake.files.delete(ref("a@0"));
    const diff = (key: string) => call(r, `/api/host-chats/edit-diff?session=${encodeURIComponent(sessionUri(1))}&ref=${encodeURIComponent(key)}`);
    expect(await diff("t1-call:0")).toEqual({ status: 200, json: { path: "/tmp/fictional-repo/a.ts", kind: "edit", before: null, after: null, unavailable: true } });
    expect(await diff("t2-call:0")).toEqual({ status: 200, json: { path: "/tmp/fictional-repo/a.ts", kind: "edit", before: null, after: null, binary: true } });
  });

  it("a read names each turn's checkpoint and the files its edits touched", async () => {
    const r = await restoring();
    const got = await read(r);
    expect(got.checkpoints).toEqual([
      { turn: "t1", files: [{ path: "/tmp/fictional-repo/a.ts", added: 1, removed: 1 }] },
      { turn: "t2", files: [{ path: "/tmp/fictional-repo/a.ts", added: 2, removed: 0 }, { path: "/tmp/fictional-repo/b.ts", added: 3, removed: 0 }] },
      { turn: "t3", files: [] },
    ]);
    expect(got.restored).toBeNull();
  });

  it("restore undoes that turn and every later one, newest first: a created file goes, an edited one is as before", async () => {
    const r = await restoring();
    const done = await call(r, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t2" });
    expect(done).toEqual({ status: 200, json: { files: 2 } });
    expect(r.fake.files.get(A)).toBe("a1");
    expect(r.fake.files.has(B)).toBe(false);
    expect((await read(r)).restored).toEqual({ turn: "t2", files: 2 });
    // nothing is truncated until the next send
    expect(actions(r.fake, "chat/truncated")).toEqual([]);
  });

  it("Start Over (the first turn) undoes every edit; Redo puts them all back, oldest first", async () => {
    const r = await restoring();
    expect((await call(r, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t1" })).json).toEqual({ files: 2 });
    expect(r.fake.files.get(A)).toBe("a0");
    expect(r.fake.files.has(B)).toBe(false);
    expect(await call(r, "/api/host-chats/chat/checkpoint/redo", { session: sessionUri(1) })).toEqual({ status: 200, json: { files: 2 } });
    expect(r.fake.files.get(A)).toBe("a2");
    expect(r.fake.files.get(B)).toBe("b1");
    expect((await read(r)).restored).toBeNull();
  });

  it("the send after a restore truncates to the turn before it, then starts the new turn", async () => {
    const r = await restoring();
    await call(r, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t2" });
    const id = crypto.randomUUID();
    expect((await call(r, "/api/host-chats/chat/send", { id, session: sessionUri(1), text: "FICTIONAL instead" })).json).toEqual({ queued: false });
    await until("the new turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === id);
    const kinds = r.fake.dispatched.map((entry): string => entry.action.type).filter((type) => type === "chat/truncated" || type === "chat/turnStarted");
    expect(kinds).toEqual(["chat/truncated", "chat/turnStarted"]);
    expect(only(r.fake, "chat/truncated")).toEqual({ type: "chat/truncated", turnId: "t1" });
    expect(r.conn.chat(sessionUri(1))?.turns.map((each) => each.id)).toEqual(["t1"]);
    expect((await read(r)).restored).toBeNull();
  });

  it("the send after Start Over clears every turn (no turnId)", async () => {
    const r = await restoring();
    await call(r, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t1" });
    await call(r, "/api/host-chats/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL afresh" });
    await until("the truncate", () => actions(r.fake, "chat/truncated").length > 0);
    expect(only(r.fake, "chat/truncated")).toEqual({ type: "chat/truncated" });
  });

  it("refuses while a turn runs, and an unknown turn", async () => {
    const busy = await restoring({ status: 8, activeTurn: active() });
    const refused = await call(busy, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t2" });
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 409, code: "turn_running" });
    expect(busy.fake.files.get(A)).toBe("a2");
    const r = await restoring();
    const unknown = await call(r, "/api/host-chats/chat/checkpoint/restore", { session: sessionUri(1), turn: "t9" });
    expect({ status: unknown.status, code: unknown.json.error.code }).toEqual({ status: 404, code: "unknown_turn" });
    const none = await call(r, "/api/host-chats/chat/checkpoint/redo", { session: sessionUri(1) });
    expect({ status: none.status, code: none.json.error.code }).toEqual({ status: 409, code: "nothing_to_redo" });
  });
});

describe("host chat forks: VS Code's Fork Conversation", () => {
  const turns = [turn("t1", "FICTIONAL one"), turn("t2", "FICTIONAL two"), turn("t3", "FICTIONAL three")];
  const forking = (overrides: Partial<FakeAgentHostSeed> = {}) => rig({ chats: { [chatUri(1)]: chatState(1, { turns }), [chatUri(2)]: chatState(2) }, ...overrides });
  const forkUri = (id: string) => `ahp-chat://${id}/${Buffer.from(sessionUri(1)).toString("base64")}`;
  const fork = async (r: Rig, at = "t3", id = uuid(77)) => call(r, "/api/host-chats/chat/fork", { session: sessionUri(1), turn: at, id });
  const rows = async (r: Rig) => (await call(r, "/api/host-chats/chats")).json.chats as Array<Record<string, unknown>>;
  const read = async (r: Rig, session: string) => (await call(r, `/api/host-chats/chat?session=${encodeURIComponent(session)}`)).json as HostChatRead;
  const asked = (got: HostChatRead) => got.turns.filter((each) => each.role === "user").length;
  const on = async (r: Rig, type: string, n = 1) => { await until(type, () => actions(r.fake, type).length >= n); return actions(r.fake, type).map((each) => each.channel); };

  it("forks before the request: createChat on the session with the turn before it, and answers the fork's chat URI, listed beside its session", async () => {
    const r = await forking();
    const done = await fork(r);
    expect(done).toEqual({ status: 200, json: { session: forkUri(uuid(77)) } });
    const asked = r.fake.requests.filter((each) => each.method === "createChat");
    expect(asked.map((each) => each.params)).toEqual([{ channel: sessionUri(1), chat: forkUri(uuid(77)), source: { kind: "fork", chat: chatUri(1), turnId: "t2" } }]);
    const row = (await rows(r)).find((each) => each["session"] === forkUri(uuid(77)));
    expect(row).toEqual({ session: forkUri(uuid(77)), title: "FICTIONAL fork of FICTIONAL_chat_1", status: "idle", modified_at: "2026-01-01T00:00:01.000Z", cwd: "/tmp/fictional-repo", unread: true, archived: false, fork_of: sessionUri(1) });
    expect((await rows(r)).filter((each) => each["session"] === sessionUri(1))).toHaveLength(1);
  });

  it("the fork reads its own turns; the source chat keeps all of its", async () => {
    const r = await forking();
    const forked = (await fork(r)).json.session as string;
    const got = await read(r, forked);
    expect({ session: got.session, title: got.title, asked: asked(got) }).toEqual({ session: forked, title: "FICTIONAL fork of FICTIONAL_chat_1", asked: 2 });
    expect(asked(await read(r, sessionUri(1)))).toBe(3);
  });

  it("a send on the fork starts its turn on the fork's chat channel, never the source's", async () => {
    const r = await forking();
    const forked = (await fork(r)).json.session as string;
    const id = crypto.randomUUID();
    expect((await call(r, "/api/host-chats/chat/send", { id, session: forked, text: "FICTIONAL other way" })).json).toEqual({ queued: false });
    expect(await on(r, "chat/turnStarted")).toEqual([forked]);
    await until("the fork's turn", () => r.conn.chat(forked)?.activeTurn?.id === id);
    expect(r.conn.chat(sessionUri(1))?.activeTurn).toBeUndefined();
  });

  it("rename, read and archive on a fork go on its chat's channel; the session's own title and flags stay", async () => {
    const r = await forking();
    const forked = (await fork(r)).json.session as string;
    await call(r, "/api/host-chats/chat/rename", { session: forked, title: "FICTIONAL the other road" });
    expect(await on(r, "session/titleChanged")).toEqual([forked]);
    await call(r, "/api/host-chats/chat/read", { session: forked, read: true });
    await call(r, "/api/host-chats/chat/archive", { session: forked, archived: true });
    expect(await on(r, "chat/isArchivedChanged")).toEqual([forked]);
    expect(actions(r.fake, "session/isArchivedChanged")).toEqual([]);
    await until("the catalog", () => (r.conn.summaries()[0]!.chats ?? []).some((each) => each.title === "FICTIONAL the other road" && ((each.status ?? 0) & 64) !== 0));
    const listed = await rows(r);
    expect(listed.find((each) => each["session"] === forked)).toMatchObject({ title: "FICTIONAL the other road", unread: false, archived: true });
    expect(listed.find((each) => each["session"] === sessionUri(1))).toMatchObject({ title: "FICTIONAL_chat_1", archived: false });
  });

  it("delete on a fork disposes that chat alone (disposeChat); its session stays", async () => {
    const r = await forking();
    const forked = (await fork(r)).json.session as string;
    expect(await call(r, "/api/host-chats/chat/delete", { session: forked })).toEqual({ status: 200, json: { ok: true } });
    expect(r.fake.requests.filter((each) => each.method === "disposeChat" || each.method === "disposeSession").map((each) => [each.method, each.params])).toEqual([["disposeChat", { channel: forked }]]);
    await until("the catalog", () => !(r.conn.summaries()[0]!.chats ?? []).some((each) => each.resource === forked));
    expect((await rows(r)).map((each) => each["session"])).not.toContain(forked);
    expect(asked(await read(r, sessionUri(1)))).toBe(3);
  });

  it("the same id again makes no second fork; the first turn, an unknown turn and an agent that does not fork are refused", async () => {
    const r = await forking();
    await fork(r);
    expect((await fork(r)).json).toEqual({ session: forkUri(uuid(77)) });
    expect(r.fake.requests.filter((each) => each.method === "createChat")).toHaveLength(1);
    const first = await fork(r, "t1", uuid(78));
    expect({ status: first.status, code: first.json.error.code }).toEqual({ status: 409, code: "first_turn" });
    const unknown = await fork(r, "t9", uuid(79));
    expect({ status: unknown.status, code: unknown.json.error.code }).toEqual({ status: 404, code: "unknown_turn" });
    const plain = await forking({ capabilities: {} });
    const refused = await fork(plain);
    expect({ status: refused.status, code: refused.json.error.code }).toEqual({ status: 409, code: "fork_unsupported" });
    expect(plain.fake.requests.filter((each) => each.method === "createChat")).toHaveLength(0);
  });

  it("a hidden chat and a tool's are not listed", async () => {
    const hidden = { ...summary(1), chats: [
      { resource: chatUri(1), title: "FICTIONAL_chat_1", status: 33, origin: { kind: "user" } },
      { resource: forkUri("h"), title: "FICTIONAL hidden", status: 33, interactivity: "hidden", origin: { kind: "fork", chat: chatUri(1), turnId: "t1" } },
      { resource: forkUri("t"), title: "FICTIONAL tool", status: 33, origin: { kind: "tool" } },
    ] } as unknown as SessionSummary;
    const r = await forking({ sessions: [hidden, summary(2)] });
    expect((await rows(r)).map((each) => each["session"])).toEqual([sessionUri(2), sessionUri(1)]);
  });
});
