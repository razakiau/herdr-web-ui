import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import { forgetAuthAttempts } from "../auth.ts";
import { createServer } from "../index.ts";
import { MACHINE_PROXY_PATH } from "../machine-api.ts";
import { CostIndex } from "./costs.ts";
import { fakeAgentHost } from "./fake-host.ts";
import { HOST_CHAT_ROUTES, setCostIndexForTests } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { forgetAuthAttempts(); setCostIndexForTests(null); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-goal-digest-"));
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
const OTHER = "00000000-0000-4000-8000-000000000002";
const SESSION = `copilotcli:/${UUID}`;
const CHAT = `ahp-chat://default/${Buffer.from(SESSION).toString("base64")}`;
const AT = "2026-01-01T00:00:00.000Z";
const summary = { resource: SESSION, provider: "copilotcli", title: "FICTIONAL_chat", status: 1, createdAt: AT, modifiedAt: AT, workingDirectories: ["file:///tmp/fictional-repo"], defaultChat: CHAT } as SessionSummary;
const state = { provider: "copilotcli", title: "FICTIONAL_chat", status: 1, lifecycle: "ready", activeClients: [], chats: [{ resource: CHAT, title: "FICTIONAL_chat", status: 1, modifiedAt: AT }], defaultChat: CHAT, workingDirectories: ["file:///tmp/fictional-repo"] } as unknown as SessionState;
const chat = { resource: CHAT, title: "FICTIONAL_chat", status: 1, modifiedAt: AT, turns: [] } as unknown as ChatState;

const LOG = [
  { type: "user.message", data: { content: "FICTIONAL: make the tests pass" } },
  { type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "bun test" } } },
  { type: "tool.execution_complete", data: { success: true, result: { content: "FICTIONAL 3 pass" } } },
  { type: "assistant.message", data: { content: "FICTIONAL: done" } },
].map((event) => `${JSON.stringify(event)}\n`).join("");

/** A PC's bridge as server/remote-entry.ts starts it (the central server calls it with this token), its cost index on a fixture Copilot home. */
async function bridge(): Promise<{ endpoint: string; token: string }> {
  const home = temp();
  const config = join(home, "cfg");
  const entries = process.platform === "darwin" ? join(home, "Library", "Application Support", "Code", "agent-host", "local-endpoint", "entries") : join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  const copilot = temp();
  mkdirSync(join(copilot, "session-state", UUID), { recursive: true });
  writeFileSync(join(copilot, "session-state", UUID, "events.jsonl"), LOG);
  setCostIndexForTests(new CostIndex(copilot, []), []);
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

describe("GET /api/host-chats/goal-digest", () => {
  it("answers the chat's log digest", async () => {
    const { endpoint, token } = await bridge();
    const response = await fetch(`${endpoint}/api/host-chats/goal-digest?session=${encodeURIComponent(SESSION)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ digest: "USER: FICTIONAL: make the tests pass\nTOOL bash: bun test\nRESULT: FICTIONAL 3 pass\nAGENT: FICTIONAL: done" });
  });

  it("answers 404 no_log for a chat with no log", async () => {
    const { endpoint, token } = await bridge();
    const response = await fetch(`${endpoint}/api/host-chats/goal-digest?session=${encodeURIComponent(`copilotcli:/${OTHER}`)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("no_log");
  });

  it("answers 401 to a request with no token", async () => {
    const { endpoint } = await bridge();
    const response = await fetch(`${endpoint}/api/host-chats/goal-digest?session=${encodeURIComponent(SESSION)}`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("is the central server's to ask, never proxied for a browser", () => {
    expect(MACHINE_PROXY_PATH.test("host-chats/goal-digest")).toBe(false);
    expect(HOST_CHAT_ROUTES).not.toContain("goal-digest");
  });
});
