import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { VscodeHostState } from "../../shared/vscode.ts";
import { createServer } from "../index.ts";
import { fakeAgentHost } from "./fake-host.ts";
import { vscodeRoute, type VscodeHost } from "./routes.ts";

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

describe("VS Code routes", () => {
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
    const host: VscodeHost = { state: () => current };
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
