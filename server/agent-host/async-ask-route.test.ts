import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import type { HostChatRead } from "../../shared/host-chats.ts";
import { descriptorPath, type BridgeDescriptor } from "../bridge.ts";
import { createServer } from "../index.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { fakeAgentHost } from "./fake-host.ts";
import { rowOfSdk, type AgentHost } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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

  it("refuses a request without the bridge token, a bad body, and a session no row runs on", async () => {
    const { endpoint, token } = await bridge();
    expect((await post(endpoint, ASK)).status).toBe(401);
    expect((await post(endpoint, ASK, "FICTIONAL-wrong")).status).toBe(401);
    const refused = async (body: unknown) => { const response = await post(endpoint, body, token); return [response.status, ((await response.json()) as { error: { code: string } }).error.code]; };
    expect(await refused({ ...ASK, sdk_session: "" })).toEqual([400, "missing_sdk_session"]);
    expect(await refused({ ...ASK, question: " " })).toEqual([400, "invalid_question"]);
    expect(await refused({ ...ASK, kind: "urgent" })).toEqual([400, "invalid_kind"]);
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
    expect(rowOfSdk(host(true), UUID, [])).toBe(SESSION);
    expect(rowOfSdk(host(true), "00000000-0000-4000-8000-000000000002", [])).toBe("copilotcli:/00000000-0000-4000-8000-000000000002");
    expect(rowOfSdk(host(true), "00000000-0000-4000-8000-0000000000ff", [])).toBeNull();
    expect(rowOfSdk(host(false), UUID, [])).toBeNull();
  });
});
