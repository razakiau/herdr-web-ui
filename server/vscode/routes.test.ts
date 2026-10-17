import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionModelInfo, SessionState, SessionSummary, StateAction, Turn } from "@microsoft/agent-host-protocol";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { VscodeChatRead, VscodeHostState } from "../../shared/vscode.ts";
import { descriptorPath, type BridgeDescriptor } from "../bridge.ts";
import { createServer } from "../index.ts";
import { handleMachineRequest } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { VscodeConnection, VscodeError } from "./connection.ts";
import { fakeAgentHost, type FakeAgentHost, type FakeAgentHostSeed } from "./fake-host.ts";
import { LEASE_MS, vscodeRoute, type LeaseClock, type VscodeHost } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-vscode-routes-"));
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
function stub(state: () => VscodeHostState): VscodeHost {
  const no = (): never => { throw new Error("the stub host has only a state"); };
  return { state, mirror: no, summaries: no, chat: no, watch: no, watching: no, request: no, dispatch: no };
}

// ─── Against a fake agent host, through a real VscodeConnection ─────────────

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

interface Rig { fake: FakeAgentHost; conn: VscodeConnection; clock: ReturnType<typeof manualClock>; entries: string }

/** Every route call in this file goes through here: its response never carries the host's token. */
const tokens: string[] = [];
async function call(rig: { conn: VscodeHost; clock: LeaseClock }, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const request = body === undefined
    ? get(path)
    : new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await vscodeRoute(request, new URL(request.url).pathname, rig.conn, rig.clock)!;
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

function connectionAt(home: string, env: Record<string, string>): VscodeConnection {
  const conn = new VscodeConnection({ home, env, platform: "linux", startHost: false, onChange: () => {}, clientId: "herdr-web-0000test", deps: { sleep: quick } });
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

const actions = (fake: FakeAgentHost, type: string) => fake.dispatched.filter((entry) => entry.action.type === type);
const only = (fake: FakeAgentHost, type: string): Record<string, any> => {
  const found = actions(fake, type);
  expect(found.length).toBe(1);
  return found[0]!.action as Record<string, any>;
};

describe("VS Code routes", () => {
  it("the test preload clears HERDR_WEB_AGENT_HOST and HERDR_WEB_AGENT_HOST_START, so no test server reaches this PC's agent host", () => {
    // scripts/test-herdr.ts: every createServer without agentHost reads these, and a developer's
    // shell may export them on the very PC whose VS Code agent host the feature talks to
    expect(process.env["HERDR_WEB_AGENT_HOST"]).toBeUndefined();
    expect(process.env["HERDR_WEB_AGENT_HOST_START"]).toBeUndefined();
  });

  it("with HERDR_WEB_AGENT_HOST unset every /api/vscode route is 404 vscode_off and no connection starts", async () => {
    const previous = process.env["HERDR_WEB_AGENT_HOST"];
    delete process.env["HERDR_WEB_AGENT_HOST"];
    try {
      const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
      cleanups.push(() => server.stop());
      for (const path of ["state", "chats", "chat/send", "anything/else"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/vscode/${path}`);
        const body = await response.json() as { error: { code: string } };
        expect({ path, status: response.status, code: body.error.code }).toEqual({ path, status: 404, code: "vscode_off" });
      }
    } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_AGENT_HOST"]; else process.env["HERDR_WEB_AGENT_HOST"] = previous;
    }
    // the route itself, with no host: the same answer, and nothing outside /api/vscode/ is taken
    const off = await vscodeRoute(get("/api/vscode/state"), "/api/vscode/state", null)!;
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("vscode_off");
    expect(vscodeRoute(get("/api/session"), "/api/session", null)).toBeNull();
    expect(vscodeRoute(get("/api/vscode"), "/api/vscode", null)).toBeNull();
  });

  it("with agentHost enabled /api/vscode/state answers the connection's state", async () => {
    let current: VscodeHostState = { state: "connected", signed_in: true, protocol: "1.0.0" };
    const host = stub(() => current);
    const response = await vscodeRoute(get("/api/vscode/state"), "/api/vscode/state", host)!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
    current = { state: "waiting" };
    expect(await (await vscodeRoute(get("/api/vscode/state"), "/api/vscode/state", host)!).json()).toEqual({ host: { state: "waiting" } });
    const posted = await vscodeRoute(new Request("http://127.0.0.1/api/vscode/state", { method: "POST" }), "/api/vscode/state", host)!;
    expect(posted.status).toBe(400);
    expect(((await posted.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
    const unknown = await vscodeRoute(get("/api/vscode/nothing"), "/api/vscode/nothing", host)!;
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("a server with agentHost on serves its connection's state, pushes vscode-host over the WebSocket, and stops it on stop", async () => {
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
    await until("the vscode-host frame", () => seen.some((m) => m.type === "vscode-host" && m.host.state === "connected"));
    expect(seen).toContainEqual({ type: "vscode-chat-changed", session: null });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/vscode/state`);
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

describe("VS Code routes behind a token", () => {
  it("the bridge token is admitted on /api/vscode/*, directly and through the machine proxy; no token is refused", async () => {
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
    const hostState = async () => (await (await fetch(`${endpoint}/api/vscode/state`, { headers: { authorization: `Bearer ${registered.token}` } })).json() as { host: VscodeHostState }).host.state;
    for (const deadline = Date.now() + 5_000; await hostState() !== "connected";) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the bridge's host");
      await Bun.sleep(10);
    }
    expect((await fetch(`${endpoint}/api/vscode/state`)).status).toBe(401);
    expect((await fetch(`${endpoint}/api/vscode/chats`, { headers: { authorization: "Bearer FICTIONAL-wrong" } })).status).toBe(401);
    const direct = await fetch(`${endpoint}/api/vscode/chats`, { headers: { authorization: `Bearer ${registered.token}` } });
    expect(direct.status).toBe(200);
    expect(((await direct.json()) as { chats: { session: string }[] }).chats.map((row) => row.session)).toEqual([sessionUri(1)]);
    // the connection server's proxy carries the bridge token, GET and POST
    const manager = { endpoint: (id: string) => id === "vscode-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const state = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/vscode-remote/vscode/state"), manager);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
    const watched = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/vscode-remote/vscode/chat/watch", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ session: sessionUri(1) }),
    }), manager);
    expect({ status: watched.status, body: await watched.json() }).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("VS Code on shutdown", () => {
  it("a connection whose stop fails is logged by the error's name, and is no unhandled rejection", async () => {
    const { home, env } = homeWithRegistry();
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null,
      agentHost: { enabled: true, startHost: false, home, env },
    });
    const realStop = VscodeConnection.prototype.stop;
    const warned: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    const warn = console.warn;
    process.on("unhandledRejection", onUnhandled);
    VscodeConnection.prototype.stop = async function () { await realStop.call(this); throw new RangeError("FICTIONAL secret"); };
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      server.stop();
      await until("the log line", () => warned.some((line) => line.startsWith("vscode: stop failed")));
      // fixed wait: one turn of the event loop, for an unhandled rejection to be reported if there is one
      await Bun.sleep(0);
    } finally {
      VscodeConnection.prototype.stop = realStop;
      console.warn = warn;
      process.off("unhandledRejection", onUnhandled);
    }
    expect(warned.filter((line) => line.startsWith("vscode:"))).toEqual(["vscode: stop failed (RangeError)"]);
    expect(unhandled).toEqual([]);
  });
});

describe("VS Code chat routes", () => {
  it("lists the chats and reads one, with its models and its session's agents", async () => {
    const r = await rig();
    const chats = await call(r, "/api/vscode/chats");
    expect(chats.json.chats.map((row: { session: string }) => row.session)).toEqual([sessionUri(2), sessionUri(1)]);
    expect(chats.json.chats[0]).toEqual({ session: sessionUri(2), title: "FICTIONAL_chat_2", status: "idle", modified_at: "2026-01-01T00:00:02.000Z", cwd: "/tmp/fictional-repo" });
    const read = await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ session: sessionUri(1), title: "FICTIONAL_chat_1", status: "idle", turns: [], cursor: null, prompt: null, busy: false });
    const models = await call(r, `/api/vscode/models?session=${encodeURIComponent(sessionUri(1))}`);
    expect(models.json).toEqual({
      models: [{ id: "fictional/model-a", name: "Fictional Model A", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] } }],
      agents: [{ uri: REPORT, name: "Report", description: "FICTIONAL writes a report" }],
    });
    expect((await call(r, "/api/vscode/models")).json.agents).toEqual([]);
  });

  it("send on an idle chat dispatches one turnStarted with model and agent on the message", async () => {
    const r = await rig();
    const sent = await call(r, "/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL hello", model: { id: "fictional/model-a", effort: "high" }, agent: REPORT });
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
    expect((await call(r, "/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL plain", agent: null })).json).toEqual({ queued: false });
    await until("the turn to arrive", () => actions(r.fake, "chat/turnStarted").length > 0);
    const message = only(r.fake, "chat/turnStarted")["message"];
    expect("agent" in message).toBe(false);
    expect("model" in message).toBe(false);
    expect(actions(r.fake, "chat/draftChanged")).toEqual([]);
  });

  it("send on a busy chat queues and starts no turn", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active() }), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL later" })).json).toEqual({ queued: true });
    await until("the queued message", () => actions(r.fake, "chat/pendingMessageSet").length > 0);
    const queued = only(r.fake, "chat/pendingMessageSet");
    expect(queued).toMatchObject({ kind: "queued", message: { text: "FICTIONAL later", origin: { kind: "user" } } });
    expect(queued["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    expect((await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.busy).toBe(true);
  });

  it("a send's id is its turn's id, and the same id sent again (its answer lost) dispatches nothing", async () => {
    const r = await rig();
    const id = crypto.randomUUID();
    const body = { id, session: sessionUri(1), text: "FICTIONAL once" };
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: false });
    await until("the turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === id);
    expect(only(r.fake, "chat/turnStarted")["turnId"]).toBe(id);
    // the retry, while the turn runs and once it is a past turn
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: false });
    r.fake.push(chatUri(1), { type: "chat/turnComplete", turnId: id, duration: 10 } as unknown as StateAction);
    await until("the turn to end", () => r.conn.chat(sessionUri(1))?.turns.some((turn) => turn.id === id) === true);
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: false });
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
    // an id that is no UUID is refused before anything goes
    for (const bad of [undefined, "", "FICTIONAL-not-a-uuid", 42]) {
      const refused = await call(r, "/api/vscode/chat/send", { ...body, id: bad });
      expect({ bad, status: refused.status, code: refused.json.error.code }).toEqual({ bad, status: 400, code: "invalid_id" });
    }
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
  });

  it("a queued send's id is its pending message's, and the same id again queues nothing", async () => {
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { status: 8, activeTurn: active() }), [chatUri(2)]: chatState(2) } });
    const id = crypto.randomUUID();
    const body = { id, session: sessionUri(1), text: "FICTIONAL later" };
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: true });
    await until("the queued message", () => (r.conn.chat(sessionUri(1))?.queuedMessages ?? []).some((pending) => pending.id === id));
    expect(only(r.fake, "chat/pendingMessageSet")["id"]).toBe(id);
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: true });
    // the running turn ends and the queued one starts under the host's own turn id: not pending any more
    r.fake.push(chatUri(1), { type: "chat/turnComplete", turnId: "turn-live", duration: 10 } as unknown as StateAction);
    r.fake.push(chatUri(1), { type: "chat/turnStarted", turnId: "turn-host", startedAt: AT, message: user("FICTIONAL later"), queuedMessageId: id } as unknown as StateAction);
    await until("the queued message to start", () => r.conn.chat(sessionUri(1))?.activeTurn?.id === "turn-host" && (r.conn.chat(sessionUri(1))?.queuedMessages ?? []).length === 0);
    expect((await call(r, "/api/vscode/chat/send", body)).json).toEqual({ queued: false });
    expect(actions(r.fake, "chat/pendingMessageSet").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted").length).toBe(0);
  });

  it("the mirror alone stops a repeat: a chat that has the id (sent by another bridge) dispatches nothing", async () => {
    const id = crypto.randomUUID();
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { turns: [turn(id, "FICTIONAL sent elsewhere")] }), [chatUri(2)]: chatState(2, { status: 8, activeTurn: active(), queuedMessages: [{ id: uuid(77), message: user("FICTIONAL waiting") }] }) } });
    expect((await call(r, "/api/vscode/chat/send", { id, session: sessionUri(1), text: "FICTIONAL sent elsewhere" })).json).toEqual({ queued: false });
    expect((await call(r, "/api/vscode/chat/send", { id: uuid(77), session: sessionUri(2), text: "FICTIONAL waiting" })).json).toEqual({ queued: true });
    expect(r.fake.dispatched.filter((entry) => entry.action.type !== "session/activeClientSet")).toEqual([]);
  });

  it("a model choice writes draft.model and keeps the other client's draft text", async () => {
    const draft = { text: "FICTIONAL half-typed", origin: { kind: "user" }, attachments: [{ type: "simple", label: "FICTIONAL note" }] };
    const r = await rig({ chats: { [chatUri(1)]: chatState(1, { draft }), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/vscode/chat/draft", { session: sessionUri(1), model: { id: "fictional/model-a", effort: "low" } })).json).toEqual({ ok: true });
    await until("the draft", () => actions(r.fake, "chat/draftChanged").length > 0);
    const written = only(r.fake, "chat/draftChanged")["draft"];
    expect(written.text).toBe("FICTIONAL half-typed");
    expect(written.attachments).toEqual(draft.attachments);
    expect(written.model).toEqual({ id: "fictional/model-a", config: { thinkingLevel: "low" } });
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    // the read says the draft's model while no turn names one
    await until("the draft to come back", () => r.conn.chat(sessionUri(1))?.draft?.model !== undefined);
    expect((await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).json.model).toEqual({ id: "fictional/model-a", effort: "low" });
    expect((await call(r, "/api/vscode/chat/draft", { session: sessionUri(1) })).status).toBe(400);
  });

  it("a free answer goes as freeformValues on a selected answer", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR]), [chatUri(2)]: chatState(2) } });
    const read = (await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as VscodeChatRead;
    expect(read.prompt).toMatchObject({ id: "req-1:q-color", kind: "question", custom_option_index: 2, vscode: { request_id: "req-1", question_id: "q-color" } });
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: [""], text: "FICTIONAL teal" })).json).toEqual({ ok: true });
    await until("the answer", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({
      type: "chat/inputCompleted", requestId: "req-1", response: "accept",
      answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["FICTIONAL teal"] } } },
    });
  });

  it("a two-question form answers step one with inputAnswerChanged and completes on step two with both answers", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR, SIZE]), [chatUri(2)]: chatState(2) } });
    const path = `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`;
    expect((await call(r, path)).json.prompt.id).toBe("req-1:q-color");
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: ["blue"] })).json).toEqual({ ok: true });
    await until("step one", () => actions(r.fake, "chat/inputAnswerChanged").length > 0);
    const blue = { state: "submitted", value: { kind: "selected", value: "blue" } };
    expect(only(r.fake, "chat/inputAnswerChanged")).toEqual({ type: "chat/inputAnswerChanged", requestId: "req-1", questionId: "q-color", answer: blue });
    expect(actions(r.fake, "chat/inputCompleted")).toEqual([]);
    await until("the card to move on", () => r.conn.chat(sessionUri(1))?.activeTurn?.responseParts.some((part) => part.kind === "inputRequest" && part.request.answers?.["q-color"] !== undefined) === true);
    const second = (await call(r, path)).json as VscodeChatRead;
    expect(second.prompt?.id).toBe("req-1:q-size");
    expect(second.prompt?.steps).toEqual([{ label: "Color", answered: true, current: false }, { label: "Size", answered: false, current: true }]);
    // an answer to the step already done is refused, not sent
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: ["red"] })).status).toBe(409);
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-size", text: "FICTIONAL large" })).json).toEqual({ ok: true });
    await until("the form to complete", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({
      type: "chat/inputCompleted", requestId: "req-1", response: "accept",
      answers: { "q-color": blue, "q-size": { state: "submitted", value: { kind: "text", value: "FICTIONAL large" } } },
    });
    expect(actions(r.fake, "chat/inputAnswerChanged").length).toBe(1);
  });

  it("a form whose questions are not required (false or unset) still shows every step: answering one leaves the request open on the next", async () => {
    for (const required of [false, undefined]) {
      const optional = (question: Record<string, unknown>) => { const { required: _, ...rest } = question; return required === undefined ? rest : { ...rest, required }; };
      const r = await rig({ chats: { [chatUri(1)]: asking([optional(COLOR), optional(SIZE)]), [chatUri(2)]: chatState(2) } });
      const path = `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`;
      expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", option_ids: ["red"] })).json).toEqual({ ok: true });
      await until("step one", () => actions(r.fake, "chat/inputAnswerChanged").length > 0);
      expect({ required, completed: actions(r.fake, "chat/inputCompleted") }).toEqual({ required, completed: [] });
      await until("the card to move on", () => r.conn.chat(sessionUri(1))?.activeTurn?.responseParts.some((part) => part.kind === "inputRequest" && part.request.answers?.["q-color"] !== undefined) === true);
      expect({ required, prompt: ((await call(r, path)).json as VscodeChatRead).prompt?.id }).toEqual({ required, prompt: "req-1:q-size" });
      // the last unanswered one completes the form, with both answers
      expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-size", text: "FICTIONAL small" })).json).toEqual({ ok: true });
      await until("the form", () => actions(r.fake, "chat/inputCompleted").length > 0);
      expect(Object.keys(only(r.fake, "chat/inputCompleted")["answers"]).sort()).toEqual(["q-color", "q-size"]);
    }
  });

  it("skip declines with no answers", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR, SIZE]), [chatUri(2)]: chatState(2) } });
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-1", question_id: "q-color", skip: true })).json).toEqual({ ok: true });
    await until("the decline", () => actions(r.fake, "chat/inputCompleted").length > 0);
    expect(only(r.fake, "chat/inputCompleted")).toEqual({ type: "chat/inputCompleted", requestId: "req-1", response: "decline" });
    expect((await call(r, "/api/vscode/chat/answer", { session: sessionUri(1), request_id: "req-gone", question_id: "q-color", option_ids: ["red"] })).status).toBe(409);
  });

  it("confirm approve says user-action; deny says denied", async () => {
    const pending = (n: number) => chatState(n, { status: 24, activeTurn: active([{ kind: "toolCall", toolCall: {
      status: "pending-confirmation", toolCallId: `call-${n}`, toolName: "bash", displayName: "Run in terminal", invocationMessage: "Run `ls`", toolInput: "ls",
    } }]) });
    const r = await rig({ chats: { [chatUri(1)]: pending(1), [chatUri(2)]: pending(2) } });
    const read = (await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).json as VscodeChatRead;
    expect(read.prompt).toMatchObject({ kind: "approval", vscode: { tool_call_id: "call-1", turn_id: "turn-live" } });
    expect((await call(r, "/api/vscode/chat/confirm", { session: sessionUri(1), turn_id: "turn-live", tool_call_id: "call-1", approved: true })).json).toEqual({ ok: true });
    expect((await call(r, "/api/vscode/chat/confirm", { session: sessionUri(2), turn_id: "turn-live", tool_call_id: "call-2", approved: false })).json).toEqual({ ok: true });
    await until("both confirmations", () => actions(r.fake, "chat/toolCallConfirmed").length === 2);
    expect(actions(r.fake, "chat/toolCallConfirmed")).toEqual([
      { channel: chatUri(1), action: { type: "chat/toolCallConfirmed", turnId: "turn-live", toolCallId: "call-1", approved: true, confirmed: "user-action" } as unknown as StateAction },
      { channel: chatUri(2), action: { type: "chat/toolCallConfirmed", turnId: "turn-live", toolCallId: "call-2", approved: false, reason: "denied" } as unknown as StateAction },
    ]);
    expect((await call(r, "/api/vscode/chat/confirm", { session: sessionUri(1), turn_id: "turn-live", tool_call_id: "call-404", approved: true })).status).toBe(409);
  });

  it("new chat creates with isolation folder and the cwd as a file URI, then sends", async () => {
    const r = await rig();
    const made = await call(r, "/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL start here", model: { id: "fictional/model-a", effort: "medium" }, agent: null });
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
    expect((await call(r, "/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "fictional-relative", text: "x" })).status).toBe(400);
  });

  it("a new chat's id names its session; the same id again makes nothing and sends nothing", async () => {
    const r = await rig();
    const id = crypto.randomUUID();
    const body = { id, cwd: "/tmp/fictional-repo", text: "FICTIONAL start once" };
    const made = await call(r, "/api/vscode/chat/new", body);
    expect(made).toEqual({ status: 200, json: { session: `copilotcli:/${id}` } });
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length === 1);
    expect(only(r.fake, "chat/turnStarted")["turnId"]).toBe(id);
    expect(await call(r, "/api/vscode/chat/new", body)).toEqual({ status: 200, json: { session: `copilotcli:/${id}` } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(1);
    expect(actions(r.fake, "chat/turnStarted").length).toBe(1);
    expect((await call(r, "/api/vscode/chat/new", { ...body, id: "FICTIONAL" })).json.error.code).toBe("invalid_id");
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
    expect(await call(r, "/api/vscode/chat/new", { id, cwd: "/tmp/fictional-repo", text: "FICTIONAL kept" })).toEqual({ status: 200, json: { session, sent: false } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession")).toEqual([]);
    expect(r.fake.dispatched.filter((entry) => entry.action.type !== "session/activeClientSet")).toEqual([]);
  });

  it("before=<cursor> asks fetchTurns with it and returns older turns once", async () => {
    const r = await rig({
      chats: { [chatUri(1)]: chatState(1, { turns: [turn("t3", "FICTIONAL third")], turnsNextCursor: "page-2" }), [chatUri(2)]: chatState(2) },
      // the older page overlaps the newest turn: it must not show twice
      older: { [chatUri(1)]: { turns: [turn("t1", "FICTIONAL first"), turn("t2", "FICTIONAL second"), turn("t3", "FICTIONAL third")] } },
    });
    const path = `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`;
    const first = (await call(r, path)).json as VscodeChatRead;
    expect(first.cursor).toBe("page-2");
    expect(first.turns.filter((t) => t.role === "user").map((t) => t.parts[0])).toEqual([{ kind: "text", text: "FICTIONAL third" }]);
    const older = (await call(r, `${path}&before=page-2`)).json as VscodeChatRead;
    expect(r.fake.requests.filter((entry) => entry.method === "fetchTurns").map((entry) => entry.params)).toEqual([{ channel: chatUri(1), cursor: "page-2" }]);
    const users = older.turns.filter((t) => t.role === "user").map((t) => (t.parts[0] as { text: string }).text);
    expect(users).toEqual(["FICTIONAL first", "FICTIONAL second", "FICTIONAL third"]);
    expect(new Set(users).size).toBe(users.length);
    expect(older.cursor).toBeNull();
    expect(older.signature).not.toBe(first.signature);
  });

  it("an unknown session is 404 vscode_chat_missing; a disconnected host is 503 vscode_host", async () => {
    const r = await rig();
    const unknown = await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(9))}`);
    expect({ status: unknown.status, code: unknown.json.error.code }).toEqual({ status: 404, code: "vscode_chat_missing" });
    const send = await call(r, "/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(9), text: "FICTIONAL nobody" });
    expect({ status: send.status, code: send.json.error.code }).toEqual({ status: 404, code: "vscode_chat_missing" });
    // no host in this home's registry, and starting one is off: the connection waits
    const { home, env } = homeWithRegistry();
    const down = { conn: connectionAt(home, env), clock: manualClock() };
    await until("the connection to wait", () => down.conn.state().state === "waiting");
    for (const [path, body] of [
      ["/api/vscode/chats", undefined],
      [`/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`, undefined],
      ["/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(1), text: "FICTIONAL nobody home" }],
      ["/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL nobody home" }],
      ["/api/vscode/models", undefined],
    ] as const) {
      const answer = await call(down, path, body);
      expect({ path, status: answer.status, code: answer.json.error.code, host: answer.json.host }).toEqual({ path, status: 503, code: "vscode_host", host: { state: "waiting" } });
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
      [`/api/vscode/chat?${q}`, undefined], [`/api/vscode/models?${q}`, undefined],
      ["/api/vscode/chat/watch", { session: other }], ["/api/vscode/chat/send", { id: crypto.randomUUID(), session: other, text: "FICTIONAL elsewhere" }],
      ["/api/vscode/chat/answer", { session: other, request_id: "req-1", question_id: "q-color", option_ids: ["red"] }],
      ["/api/vscode/chat/confirm", { session: other, turn_id: "t", tool_call_id: "c", approved: true }],
      ["/api/vscode/chat/draft", { session: other, model: { id: "fictional/model-a" } }],
    ] as const) {
      const answer = await call(r, path, body);
      expect({ path, status: answer.status, code: answer.json.error?.code }).toEqual({ path, status: 404, code: "vscode_chat_missing" });
    }
    expect(r.fake.requests.filter((entry) => entry.method === "subscribe" && (entry.params as { channel: string }).channel === other)).toEqual([]);
    expect(r.fake.dispatched.filter((entry) => entry.channel !== "ahp-root://")).toEqual([]);
    // the Copilot CLI session beside it still answers
    expect((await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).status).toBe(200);
  });

  it("a new chat whose first message fails after creation answers its session with sent: false", async () => {
    const r = await rig();
    // the real connection, but every dispatch fails: createSession and the watch succeed, the send does not
    const conn = r.conn;
    const noSend: VscodeHost = {
      state: () => conn.state(), mirror: () => conn.mirror(), summaries: () => conn.summaries(), chat: (s) => conn.chat(s),
      watch: (s) => conn.watch(s), watching: (s) => conn.watching(s), request: (method, params) => conn.request(method, params),
      dispatch: () => { throw new VscodeError("not_connected"); },
    };
    const made = await call({ conn: noSend, clock: r.clock }, "/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL lost?" });
    expect(made.status).toBe(200);
    expect(made.json).toEqual({ session: expect.stringMatching(/^copilotcli:\/[0-9a-f-]{36}$/), sent: false });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").map((entry) => (entry.params as { channel: string }).channel)).toEqual([made.json.session]);
    expect(actions(r.fake, "chat/turnStarted")).toEqual([]);
    // the watch failing after creation says the same
    const noWatch: VscodeHost = { ...noSend, dispatch: (channel, action) => conn.dispatch(channel, action), watch: () => Promise.reject(new VscodeError("timeout")) };
    const second = await call({ conn: noWatch, clock: manualClock() }, "/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL lost again?" });
    expect(second).toEqual({ status: 200, json: { session: expect.stringMatching(/^copilotcli:\//), sent: false } });
    expect(r.fake.requests.filter((entry) => entry.method === "createSession").length).toBe(2);
    // a new chat that sends answers its session alone
    const sent = await call(r, "/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL sent" });
    expect(Object.keys(sent.json)).toEqual(["session"]);
    await until("the first turn", () => actions(r.fake, "chat/turnStarted").length === 1);
  });

  it("a watch lease keeps the chat subscribed and its expiry unsubscribes", async () => {
    const r = await rig();
    const unsubscribed = () => r.fake.requests.filter((entry) => entry.method === "unsubscribe").map((entry) => (entry.params as { channel: string }).channel);
    expect((await call(r, "/api/vscode/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
    expect(r.conn.chat(sessionUri(1))).toBeDefined();
    r.clock.advance(60_000);
    expect((await call(r, "/api/vscode/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
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
    expect((await call(r, `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`)).status).toBe(200);
    expect(r.conn.chat(sessionUri(1))).toBeDefined();
  });

  it("a resubscribe that fails after a reconnect drops the watch, and the next read subscribes again", async () => {
    const r = await rig();
    const path = `/api/vscode/chat?session=${encodeURIComponent(sessionUri(1))}`;
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
    expect((await call(r, "/api/vscode/chat/watch", { session: sessionUri(1) })).json).toEqual({ ok: true });
    expect(subscribes()).toBe(2);
    const read = await call(r, path);
    expect({ status: read.status, session: read.json.session }).toEqual({ status: 200, session: sessionUri(1) });
    // nothing was re-sent: only the watch's active-client mark
    expect(second.dispatched.map((entry) => String(entry.action.type))).toEqual(["session/activeClientSet"]);
  });

  it("no route response carries the host's token", async () => {
    const r = await rig({ chats: { [chatUri(1)]: asking([COLOR]), [chatUri(2)]: chatState(2, { status: 8, activeTurn: active() }) } });
    const s = sessionUri(1);
    // `call` asserts every body against every fake host's token; this walks each route, ok and refused
    const seen: number[] = [];
    for (const [path, body] of [
      ["/api/vscode/state", undefined], ["/api/vscode/chats", undefined], [`/api/vscode/chat?session=${encodeURIComponent(s)}`, undefined],
      [`/api/vscode/chat?session=${encodeURIComponent(s)}&before=nope`, undefined], [`/api/vscode/models?session=${encodeURIComponent(s)}`, undefined],
      ["/api/vscode/chat/watch", { session: s }], ["/api/vscode/chat/send", { id: crypto.randomUUID(), session: sessionUri(2), text: "FICTIONAL q" }],
      ["/api/vscode/chat/answer", { session: s, request_id: "req-1", question_id: "q-color", option_ids: ["red"] }],
      ["/api/vscode/chat/confirm", { session: s, turn_id: "x", tool_call_id: "y", approved: true }],
      ["/api/vscode/chat/draft", { session: s, model: { id: "fictional/model-a" } }],
      ["/api/vscode/chat/new", { id: crypto.randomUUID(), cwd: "/tmp/fictional-repo", text: "FICTIONAL new" }],
      ["/api/vscode/chat/send", { id: crypto.randomUUID(), session: "copilotcli:/nope", text: "x" }], ["/api/vscode/nothing", undefined],
    ] as const) seen.push((await call(r, path, body)).status);
    expect(tokens).toContain(r.fake.token);
    expect(seen.length).toBe(13);
  });
});
