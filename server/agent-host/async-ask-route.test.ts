import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import type { HostChatRead } from "../../shared/host-chats.ts";
import { forgetAuthAttempts } from "../auth.ts";
import { descriptorPath, type BridgeDescriptor } from "../bridge.ts";
import { createServer } from "../index.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { fakeAgentHost } from "./fake-host.ts";
import { rowOfSdk, type AgentHost } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
// the refusals below spend the shared auth-failure budget (server/auth.ts): give it back after each test
afterEach(async () => { forgetAuthAttempts(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-agent-ask-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(what: string, ready: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (await ready()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const UUID = "00000000-0000-4000-8000-000000000001";
const SESSION = `copilotcli:/${UUID}`;
const CHAT = `ahp-chat://default/${Buffer.from(SESSION).toString("base64")}`;
const AT = "2026-01-01T00:00:00.000Z";
const summary = { resource: SESSION, provider: "copilotcli", title: "FICTIONAL_chat", status: 1, createdAt: AT, modifiedAt: AT, workingDirectories: ["file:///tmp/fictional-repo"], defaultChat: CHAT } as SessionSummary;
const state = { provider: "copilotcli", title: "FICTIONAL_chat", status: 1, lifecycle: "ready", activeClients: [], chats: [{ resource: CHAT, title: "FICTIONAL_chat", status: 1, modifiedAt: AT }], defaultChat: CHAT, workingDirectories: ["file:///tmp/fictional-repo"] } as unknown as SessionState;
const chat = { resource: CHAT, title: "FICTIONAL_chat", status: 1, modifiedAt: AT, turns: [] } as unknown as ChatState;
const ASK = { sdk_session: UUID, question: "FICTIONAL: keep the old table?", options: [{ label: "FICTIONAL keep" }, { label: "FICTIONAL drop", description: "FICTIONAL why" }], recommended: 0, kind: "optional" };

/** A bridge on a fake agent host, whose browsers need a token of their own: the shim holds only the bridge token. */
async function bridge(): Promise<{ endpoint: string; token: string; stateDir: string }> {
  const home = temp();
  const config = join(home, "cfg");
  const entries = process.platform === "darwin" ? join(home, "Library", "Application Support", "Code", "agent-host", "local-endpoint", "entries") : join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  const fake = await fakeAgentHost({ sessions: [summary], states: { [SESSION]: state }, chats: { [CHAT]: chat }, models: [], entryDir: entries });
  cleanups.push(() => fake.stop());
  const stateDir = temp();
  const server = createServer({
    port: 0, hostname: "127.0.0.1", token: "FICTIONAL-browser-token", machines: false, registerBridge: true, stateDir, tailscaleOwner: null, herdrProfiles: async () => [],
    agentHost: { enabled: true, startHost: false, home, env: { XDG_CONFIG_HOME: config } },
  });
  cleanups.push(() => server.stop());
  const token = (JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor).token;
  const endpoint = `http://127.0.0.1:${server.port}`;
  await until("the bridge's host", async () => (await (await fetch(`${endpoint}/api/host-chats/chats`, { headers: { authorization: `Bearer ${token}` } })).json() as { chats?: unknown[] }).chats?.length === 1);
  return { endpoint, token, stateDir };
}

/** A PC's bridge as server/remote-entry.ts starts it: no registerBridge, so the descriptor's token is the server's own. */
async function remoteBridge(): Promise<{ endpoint: string; token: string }> {
  const home = temp();
  const config = join(home, "cfg");
  const entries = process.platform === "darwin" ? join(home, "Library", "Application Support", "Code", "agent-host", "local-endpoint", "entries") : join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  const fake = await fakeAgentHost({ sessions: [summary], states: { [SESSION]: state }, chats: { [CHAT]: chat }, models: [], entryDir: entries });
  cleanups.push(() => fake.stop());
  const token = "FICTIONAL-remote-token";
  const server = createServer({
    port: 0, hostname: "127.0.0.1", token, machines: false, stateDir: temp(), tailscaleOwner: null, herdrProfiles: async () => [],
    agentHost: { enabled: true, startHost: false, home, env: { XDG_CONFIG_HOME: config } },
  });
  cleanups.push(() => server.stop());
  const endpoint = `http://127.0.0.1:${server.port}`;
  await until("the bridge's host", async () => (await (await fetch(`${endpoint}/api/host-chats/chats`, { headers: { authorization: `Bearer ${token}` } })).json() as { chats?: unknown[] }).chats?.length === 1);
  return { endpoint, token };
}

const post = (endpoint: string, body: unknown, token?: string) => fetch(`${endpoint}/api/agent-ask`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

describe("POST /api/agent-ask (ask_user_async, ZAC-326)", () => {
  it("files the question under the row its SDK session runs on, and the chat's card shows it", async () => {
    const { endpoint, token, stateDir } = await bridge();
    const response = await post(endpoint, ASK, token);
    expect(response.status).toBe(200);
    const answer = await response.json() as { accepted: boolean; id: string };
    expect(answer.accepted).toBe(true);
    expect(answer.id).toMatch(/^ask-[0-9a-f]{8}$/);
    const read = await (await fetch(`${endpoint}/api/host-chats/chat?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } })).json() as HostChatRead;
    expect(read.prompt).toMatchObject({ id: answer.id, question: ASK.question, away_default: 1, host: { async_id: answer.id, option_ids: ["0", "1"] } });
    // kept in the bridge's state dir, across a restart
    expect((JSON.parse(readFileSync(join(stateDir, "async-asks.json"), "utf8")) as { id: string; session: string }[]).map((q) => [q.id, q.session])).toEqual([[answer.id, SESSION]]);
  });

  it("shows the agent's message above the question, as ask_user's card does, and keeps it across a restart", async () => {
    const { endpoint, token, stateDir } = await bridge();
    const message = "FICTIONAL context:\n\n- the table holds **3 years** of rows\n- nothing reads it since v4";
    const answer = await (await post(endpoint, { ...ASK, message }, token)).json() as { id: string };
    const read = async () => (await (await fetch(`${endpoint}/api/host-chats/chat?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } })).json() as HostChatRead).prompt;
    expect(await read()).toMatchObject({ id: answer.id, question: ASK.question, body: message });
    expect((JSON.parse(readFileSync(join(stateDir, "async-asks.json"), "utf8")) as { message?: string }[])[0]?.message).toBe(message);
  });

  it("Stop on a chat whose turn ended with questions open drops them: the card goes and the chat is no longer waiting", async () => {
    const { endpoint, token, stateDir } = await bridge();
    await post(endpoint, ASK, token);
    await post(endpoint, { ...ASK, kind: "blocking" }, token);
    const read = async () => (await (await fetch(`${endpoint}/api/host-chats/chat?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } })).json() as HostChatRead).prompt;
    expect(await read()).toMatchObject({ title: "Question 1 of 2" });
    const stopped = await fetch(`${endpoint}/api/host-chats/chat/stop`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ session: SESSION }) });
    expect(stopped.status).toBe(200);
    expect(await read()).toBeNull();
    expect(JSON.parse(readFileSync(join(stateDir, "async-asks.json"), "utf8"))).toEqual([]);
  });

  it("a question with no message, or a blank one, has no body", async () => {
    const { endpoint, token } = await bridge();
    await post(endpoint, { ...ASK, message: "  " }, token);
    const read = await (await fetch(`${endpoint}/api/host-chats/chat?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } })).json() as HostChatRead;
    expect(read.prompt?.body).toBeNull();
  });

  // ask_user's requestedSchema, as the shim sends it for ask_user_async (ZAC-326)
  const SCHEMA = {
    properties: {
      store: { type: "string", title: "FICTIONAL store", description: "FICTIONAL where should rows live?", enum: ["pg", "sqlite"], enumNames: ["FICTIONAL Postgres", "FICTIONAL SQLite"], default: "sqlite" },
      checks: { type: "array", title: "FICTIONAL checks", items: { anyOf: [{ const: "lint", title: "FICTIONAL lint" }, { const: "test", title: "FICTIONAL test" }] }, default: ["test"] },
      migrate: { type: "boolean", title: "FICTIONAL migrate now?" },
      notes: { type: "string", description: "FICTIONAL anything else?" },
    },
    required: ["store", "migrate"],
  };
  const FORM = { sdk_session: UUID, question: "FICTIONAL: how should the table move?", message: "FICTIONAL context", requested_schema: SCHEMA, kind: "blocking" };

  it("a question with requested_schema is a form: one page a field, as ask_user's card (ZAC-326)", async () => {
    const { endpoint, token } = await bridge();
    const response = await post(endpoint, FORM, token);
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    const read = await (await fetch(`${endpoint}/api/host-chats/chat?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } })).json() as HostChatRead;
    const other = { label: "Other…", description: null };
    expect(read.prompt).toMatchObject({ id, kind: "question", title: "FICTIONAL store", question: "FICTIONAL where should rows live?", body: "FICTIONAL context\n\n**FICTIONAL: how should the table move?**", multi_select: false, custom_option_index: 2 });
    expect(read.prompt?.away_default).toBeUndefined();
    expect(read.prompt?.form).toEqual([
      { title: "FICTIONAL store", question: "FICTIONAL where should rows live?", options: [{ label: "FICTIONAL Postgres", description: null }, { label: "FICTIONAL SQLite", description: null, recommended: true }, other], multi_select: false, custom_option_index: 2, required: true },
      { title: "FICTIONAL checks", question: "FICTIONAL checks", options: [{ label: "FICTIONAL lint", description: null }, { label: "FICTIONAL test", description: null, recommended: true }, other], multi_select: true, custom_option_index: 2, required: false },
      { title: "FICTIONAL migrate now?", question: "FICTIONAL migrate now?", options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null, required: true },
      { title: "", question: "FICTIONAL anything else?", options: [{ label: "Answer", description: null }], multi_select: false, custom_option_index: 0, required: false },
    ]);
    expect(read.prompt?.host).toEqual({ async_id: id, option_ids: ["0", "1", ""], form: [
      { question_id: "store", option_ids: ["0", "1", ""] }, { question_id: "checks", option_ids: ["0", "1", ""] }, { question_id: "migrate", option_ids: ["0", "1"] }, { question_id: "notes", option_ids: [""] },
    ] });
  });

  it("refuses a malformed requested_schema, and a form with no fields (ZAC-326)", async () => {
    const { endpoint, token } = await bridge();
    const refused = async (schema: unknown) => { const response = await post(endpoint, { ...FORM, requested_schema: schema }, token); return [response.status, ((await response.json()) as { error: { code: string } }).error.code]; };
    expect(await refused({ properties: {} })).toEqual([400, "invalid_schema"]);
    expect(await refused("FICTIONAL")).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: { a: { type: "object" } } })).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: { a: { type: "string", enum: [] } } })).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: { a: { type: "string", enum: ["x".repeat(501)] } } })).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: { a: { type: "array", items: { anyOf: [{ title: "no const" }] } } } })).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: { a: { type: "boolean" } }, required: "a" })).toEqual([400, "invalid_schema"]);
    expect(await refused({ properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: "string" }])) })).toEqual([400, "invalid_schema"]);
    // without a schema, options are still required
    const plain = await post(endpoint, { ...FORM, requested_schema: undefined }, token);
    expect(plain.status).toBe(400);
  });

  it("a form is answered whole: one line a field in the answer the chat gets; a required field left empty is refused (ZAC-326)", async () => {
    const { endpoint, token, stateDir } = await bridge();
    const { id } = await (await post(endpoint, FORM, token)).json() as { id: string };
    const answer = (body: Record<string, unknown>) => fetch(`${endpoint}/api/host-chats/chat/answer`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ session: SESSION, async_id: id, ...body }),
    });
    const refused = async (body: Record<string, unknown>) => { const response = await answer(body); return [response.status, ((await response.json()) as { error: { code: string } }).error.code]; };
    expect(await refused({ answers: { store: { option_ids: ["1"] }, migrate: null } })).toEqual([400, "missing_answer"]);
    expect(await refused({ answers: { store: { option_ids: ["5"] }, migrate: { option_ids: ["0"] } } })).toEqual([400, "invalid_answer"]);
    expect(await refused({ answers: { store: { option_ids: ["0", "1"] }, migrate: { option_ids: ["0"] } } })).toEqual([400, "invalid_answer"]);
    expect(await refused({ answers: { store: { option_ids: ["1"] }, migrate: { text: "FICTIONAL maybe" } } })).toEqual([400, "invalid_answer"]);
    expect(await refused({ option_ids: ["0"] })).toEqual([400, "invalid_answer"]);
    const stored = () => (JSON.parse(readFileSync(join(stateDir, "async-asks.json"), "utf8")) as { id: string; answer: { label: string } | null }[]).find((q) => q.id === id)?.answer ?? null;
    expect(stored()).toBeNull();
    const response = await answer({ answers: {
      store: { option_ids: ["1"] },
      checks: { option_ids: ["0", ""], text: "FICTIONAL e2e\n\n\nFICTIONAL soon" },
      migrate: { option_ids: ["1"] },
      notes: null,
    } });
    expect(response.status).toBe(200);
    expect(stored()?.label).toBe("FICTIONAL store: FICTIONAL SQLite\nFICTIONAL checks: FICTIONAL lint, FICTIONAL e2e\nFICTIONAL soon\nFICTIONAL migrate now?: No\nnotes: (skipped)");
    // answered once
    expect((await answer({ answers: { store: { option_ids: ["0"] }, migrate: { option_ids: ["0"] } } })).status).toBe(409);
  });

  it("refuses a request without the bridge token, a bad body, and a session no row runs on", async () => {
    const { endpoint, token } = await bridge();
    expect((await post(endpoint, ASK)).status).toBe(401);
    expect((await post(endpoint, ASK, "FICTIONAL-wrong")).status).toBe(401);
    const refused = async (body: unknown) => { const response = await post(endpoint, body, token); return [response.status, ((await response.json()) as { error: { code: string } }).error.code]; };
    expect(await refused({ ...ASK, sdk_session: "" })).toEqual([400, "missing_sdk_session"]);
    expect(await refused({ ...ASK, question: " " })).toEqual([400, "invalid_question"]);
    expect(await refused({ ...ASK, kind: "urgent" })).toEqual([400, "invalid_kind"]);
    expect(await refused({ ...ASK, message: 42 })).toEqual([400, "invalid_message"]);
    expect(await refused({ ...ASK, message: "x".repeat(20_001) })).toEqual([400, "invalid_message"]);
    expect(await refused({ ...ASK, options: [] })).toEqual([400, "invalid_options"]);
    expect(await refused({ ...ASK, options: [{ description: "FICTIONAL no label" }] })).toEqual([400, "invalid_options"]);
    expect(await refused({ ...ASK, recommended: 2 })).toEqual([400, "invalid_recommended"]);
    expect(await refused([ASK])).toEqual([400, "invalid_body"]);
    expect(await refused({ ...ASK, sdk_session: "00000000-0000-4000-8000-0000000000ff" })).toEqual([404, "no_chat"]);
    // recommended may be left out: no away default
    expect((await post(endpoint, { ...ASK, recommended: undefined, kind: "blocking" }, token)).status).toBe(200);
    expect((await fetch(`${endpoint}/api/agent-ask`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
  });

  it("the bridge takes the connection server's presence with its token only (ZAC-326)", async () => {
    const { endpoint, token } = await bridge();
    const presence = (body: unknown, bearer?: string) => fetch(`${endpoint}/api/host-chats/presence`, {
      method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
    });
    expect((await presence({ in_use: true })).status).toBe(401);
    expect((await presence({ in_use: true }, "FICTIONAL-wrong")).status).toBe(401);
    expect((await presence({ in_use: "yes" }, token)).status).toBe(400);
    expect((await presence({ in_use: true }, token)).status).toBe(204);
    expect((await presence({ in_use: false }, token)).status).toBe(204);
  });

  it("a bridge with registerBridge takes the bridge token only, never the browser's token, on agent-ask and presence (ZAC-326)", async () => {
    const { endpoint, token } = await bridge();
    const presence = (bearer: string) => fetch(`${endpoint}/api/host-chats/presence`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ in_use: true }),
    });
    // the browser token is full access elsewhere; the descriptor here names the bridge token, so these two refuse it
    expect((await fetch(`${endpoint}/api/host-chats/chats`, { headers: { authorization: "Bearer FICTIONAL-browser-token" } })).status).toBe(200);
    expect((await post(endpoint, ASK, "FICTIONAL-browser-token")).status).toBe(401);
    expect((await presence("FICTIONAL-browser-token")).status).toBe(401);
    expect((await post(endpoint, { ...ASK, sdk_session: "00000000-0000-4000-8000-0000000000ff" }, token)).status).toBe(404);
    expect((await presence(token)).status).toBe(204);
  });

  // remote-entry registers the server's own token in the descriptor, with no registerBridge: the shim and
  // the connection server's PresenceRelay send that token, never the random bridge token createServer makes
  const remotePresence = (endpoint: string, body: unknown, bearer?: string) => fetch(`${endpoint}/api/host-chats/presence`, {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  });

  it("a PC's bridge, built as remote-entry builds it, takes the shim's question with its own token (ZAC-326)", async () => {
    const { endpoint, token } = await remoteBridge();
    const ask = await post(endpoint, { ...ASK, sdk_session: "00000000-0000-4000-8000-0000000000ff" }, token);
    expect([ask.status, ((await ask.json()) as { error: { code: string } }).error.code]).toEqual([404, "no_chat"]);
  });

  it("a PC's bridge, built as remote-entry builds it, takes the relay's presence with its own token (ZAC-326)", async () => {
    const { endpoint, token } = await remoteBridge();
    expect((await remotePresence(endpoint, { in_use: true }, token)).status).toBe(204);
  });

  it("a PC's bridge refuses a wrong Bearer and no auth at all on agent-ask and presence (ZAC-326)", async () => {
    const { endpoint } = await remoteBridge();
    expect((await post(endpoint, ASK, "FICTIONAL-wrong")).status).toBe(401);
    expect((await remotePresence(endpoint, { in_use: true }, "FICTIONAL-wrong")).status).toBe(401);
    expect((await post(endpoint, ASK)).status).toBe(401);
    expect((await remotePresence(endpoint, { in_use: true })).status).toBe(401);
  });

  it("the bridge's own token in a cookie does not reach agent-ask or presence: a Bearer only (ZAC-326)", async () => {
    const { endpoint, token } = await remoteBridge();
    const cookie = { "content-type": "application/json", cookie: `ovis_token=${token}`, origin: endpoint };
    expect((await fetch(`${endpoint}/api/agent-ask`, { method: "POST", headers: cookie, body: JSON.stringify(ASK) })).status).toBe(401);
    expect((await fetch(`${endpoint}/api/host-chats/presence`, { method: "POST", headers: cookie, body: JSON.stringify({ in_use: true }) })).status).toBe(401);
    // the same cookie still opens the rest of the API, so the refusal is these two paths' own
    expect((await fetch(`${endpoint}/api/host-chats/chats`, { headers: { cookie: `ovis_token=${token}` } })).status).toBe(200);
  });

  it("is 404 on a server with no agent host", async () => {
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    cleanups.push(() => server.stop());
    expect((await post(`http://127.0.0.1:${server.port}`, ASK)).status).toBe(404);
  });

  it("/api/agent-ask is not forwarded by the central server", async () => {
    // a remote PC's bridge that would accept anything: it must never be asked
    let reached = 0;
    const remote = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { reached += 1; return Response.json({ accepted: true, id: "ask-00000000" }); } });
    cleanups.push(() => { void remote.stop(true); });
    const manager = { endpoint: (id: string) => id === "pc-remote" ? { url: `http://127.0.0.1:${remote.port}`, token: "FICTIONAL-bridge-token" } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const forwarded = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc-remote/agent-ask", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(ASK),
    }), manager);
    expect(forwarded.status).toBe(404);
    expect(MACHINE_PROXY_PATH.test("agent-ask")).toBe(false);
    // the central server's own /api/agent-ask, and its /local alias, answer here (no agent host: 404), never on another PC
    const central = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: temp(), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    cleanups.push(() => central.stop());
    expect((await post(`http://127.0.0.1:${central.port}`, ASK)).status).toBe(404);
    const local = await fetch(`http://127.0.0.1:${central.port}/api/machines/local/agent-ask`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(ASK) });
    expect(local.status).toBeGreaterThanOrEqual(400);
    expect(reached).toBe(0);
  });
});

describe("rowOfSdk", () => {
  it("names the row whose SDK session matches, and null for one no row runs on or a host that is down", () => {
    const rows = [summary, { ...summary, resource: "copilotcli:/00000000-0000-4000-8000-000000000002", defaultChat: "ahp-chat://default/x" }] as SessionSummary[];
    const host = (connected: boolean) => ({ state: () => ({ state: connected ? "connected" : "disconnected" }), summaries: () => rows }) as unknown as AgentHost;
    const logged = () => true;
    expect(rowOfSdk(host(true), UUID, [], logged)).toBe(SESSION);
    expect(rowOfSdk(host(true), "00000000-0000-4000-8000-000000000002", [], logged)).toBe("copilotcli:/00000000-0000-4000-8000-000000000002");
    expect(rowOfSdk(host(true), "00000000-0000-4000-8000-0000000000ff", [], logged)).toBeNull();
    expect(rowOfSdk(host(false), UUID, [], logged)).toBeNull();
  });

  it("names a copilotcli:/ row with no log of its own by the SDK session its VS Code store names (live 2026-11-13)", () => {
    const row = "00000000-0000-4000-8000-000000000003";
    const sdk = "00000000-0000-4000-8000-000000000004";
    const agentDirs = [temp()];
    mkdirSync(join(agentDirs[0]!, row), { recursive: true });
    const db = new Database(join(agentDirs[0]!, row, "session.db"));
    db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    db.run("INSERT INTO session_metadata (key, value) VALUES ('defaultChatProviderData', ?)", [JSON.stringify({ sdkSessionId: sdk })]);
    db.close();
    const rows = [{ ...summary, resource: `copilotcli:/${row}`, defaultChat: "ahp-chat://default/y" }] as SessionSummary[];
    const host = { state: () => ({ state: "connected" }), summaries: () => rows } as unknown as AgentHost;
    expect(rowOfSdk(host, sdk, agentDirs, () => false)).toBe(`copilotcli:/${row}`);
    expect(rowOfSdk(host, row, agentDirs, () => false)).toBeNull();
    // a CLI chat with its own log still runs on its own uuid
    expect(rowOfSdk(host, row, agentDirs, (uuid) => uuid === row)).toBe(`copilotcli:/${row}`);
  });
});
