import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionModelInfo, SessionState, SessionSummary, StateAction } from "@microsoft/agent-host-protocol";
import { PUSH_WINDOW_MS, VscodeConnection, type VscodeConnectionOptions, type VscodeEvent } from "./connection.ts";
import { fakeAgentHost, type FakeAgentHost, type FakeAgentHostSeed } from "./fake-host.ts";

// Stands in for the reconnect backoff (1 s, 2 s, 4 s …) so a restart is seen within a test.
const quick = (ms: number) => Bun.sleep(Math.min(ms, 10));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A temp home whose Linux registry dir (under XDG_CONFIG_HOME) exists and is empty. */
function tempHome(): { home: string; env: Record<string, string>; entries: string } {
  const home = mkdtempSync(join(tmpdir(), "herdr-vscode-conn-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "cfg");
  const entries = join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  return { home, env: { XDG_CONFIG_HOME: config }, entries };
}

async function until(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (ready()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionUri = (n: number) => `copilotcli:/${uuid(n)}`;
const chatUri = (n: number) => `ahp-chat://default/${Buffer.from(sessionUri(n)).toString("base64")}`;
const AT = "2026-01-01T00:00:00.000Z";

const MODEL: SessionModelInfo = {
  id: "fictional/model-a", provider: "copilotcli", name: "Fictional Model A",
  configSchema: { type: "object", properties: { thinkingLevel: { type: "string", title: "Thinking Level", default: "high", enum: ["low", "high"] } } },
};

const summary = (n: number): SessionSummary => ({
  resource: sessionUri(n), provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, createdAt: AT, modifiedAt: AT,
  project: { uri: "file:///tmp/fictional-repo", displayName: "fictional-repo" }, workingDirectories: ["file:///tmp/fictional-repo"],
  defaultChat: chatUri(n),
});

const sessionState = (n: number): SessionState => ({
  provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, lifecycle: "ready", activeClients: [],
  chats: [{ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT }],
  defaultChat: chatUri(n), project: { uri: "file:///tmp/fictional-repo", displayName: "fictional-repo" }, workingDirectories: ["file:///tmp/fictional-repo"],
} as unknown as SessionState);

const chatState = (n: number): ChatState => ({ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT, turns: [] } as unknown as ChatState);

function seed(overrides: Partial<FakeAgentHostSeed> = {}): FakeAgentHostSeed {
  return {
    sessions: [1, 2, 3, 4, 5].map(summary),
    states: { [sessionUri(1)]: sessionState(1) },
    chats: { [chatUri(1)]: chatState(1) },
    models: [MODEL],
    ...overrides,
  };
}

async function host(entries: string, overrides: Partial<FakeAgentHostSeed> = {}): Promise<FakeAgentHost> {
  const fake = await fakeAgentHost(seed({ entryDir: entries, ...overrides }));
  cleanups.push(() => fake.stop());
  return fake;
}

function connection(options: Partial<VscodeConnectionOptions> & { home: string; env: Record<string, string> }) {
  const events: VscodeEvent[] = [];
  const spawned: string[][] = [];
  const conn = new VscodeConnection({
    platform: "linux",
    startHost: true,
    onChange: (event) => { events.push(event); },
    clientId: "herdr-web-0000test",
    deps: { spawn: (argv) => { spawned.push(argv); }, sleep: quick },
    ...options,
  });
  cleanups.push(() => conn.stop());
  return { conn, events, spawned };
}

const turnStarted = (text: string): StateAction => ({
  type: "chat/turnStarted", turnId: crypto.randomUUID(), startedAt: AT, message: { text, origin: { kind: "user" } },
} as unknown as StateAction);

describe("VS Code connection", () => {
  it("connects with protocolVersions 1.0.0 then 0.10.0 and reports connected", async () => {
    const { home, env, entries } = tempHome();
    const fake = await host(entries);
    const { conn, events } = connection({ home, env });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    expect(fake.requests[0]!.method).toBe("initialize");
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params["protocolVersions"]).toEqual(["1.0.0", "0.10.0"]);
    expect(params["clientId"]).toBe("herdr-web-0000test");
    expect(params["initialSubscriptions"]).toEqual(["ahp-root://"]);
    expect(conn.state()).toEqual({ state: "connected", signed_in: true, protocol: "1.0.0" });
    expect(events).toContainEqual({ kind: "host" });
    expect(conn.mirror().root.agents[0]!.models[0]!.id).toBe("fictional/model-a");
  });

  it("a default clientId is herdr-web-<8 hex> and stable for the process", () => {
    const { home, env } = tempHome();
    const a = new VscodeConnection({ home, env, platform: "linux", startHost: false, onChange: () => {} });
    const b = new VscodeConnection({ home, env, platform: "linux", startHost: false, onChange: () => {} });
    expect(a.clientId).toMatch(/^herdr-web-[0-9a-f]{8}$/);
    expect(b.clientId).toBe(a.clientId);
  });

  it("a refused handshake reports refused with the server's version, never an empty list", async () => {
    const { home, env, entries } = tempHome();
    await host(entries, { refuse: "9.0.0" });
    const { conn } = connection({ home, env });
    conn.start();
    await until("refused", () => conn.state().state === "refused");
    expect(conn.state()).toEqual({ state: "refused", server_version: "9.0.0" });
    expect(conn.summaries()).toEqual([]);
  });

  it("watch subscribes the session, sets the active client, then the defaultChat it names", async () => {
    const { home, env, entries } = tempHome();
    const fake = await host(entries);
    const { conn, events } = connection({ home, env });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    const release = await conn.watch(sessionUri(1));
    const after = fake.requests.filter((r) => r.method !== "initialize" && r.method !== "listSessions");
    expect(after.map((r) => [r.method, (r.params as { channel: string }).channel])).toEqual([
      ["subscribe", sessionUri(1)],
      ["dispatchAction", sessionUri(1)],
      ["subscribe", chatUri(1)],
    ]);
    expect(fake.dispatched).toEqual([{ channel: sessionUri(1), action: { type: "session/activeClientSet", activeClient: { clientId: "herdr-web-0000test", displayName: "herdr-web", tools: [] } } as unknown as StateAction }]);
    expect(conn.chat(sessionUri(1))?.resource).toBe(chatUri(1));
    expect(conn.mirror().getSession(sessionUri(1))?.defaultChat).toBe(chatUri(1));
    await until("the active client echo", () => (conn.mirror().getSession(sessionUri(1))?.activeClients.length ?? 0) === 1);

    // an action on the watched chat is mirrored and reported for its session
    events.length = 0;
    fake.push(chatUri(1), { type: "chat/activityChanged", activity: "FICTIONAL_activity" } as unknown as StateAction);
    await until("the chat action", () => conn.chat(sessionUri(1))?.activity === "FICTIONAL_activity");
    await until("the chat push", () => events.some((e) => e.kind === "chat" && e.session === sessionUri(1)), PUSH_WINDOW_MS * 4);

    // a second watcher shares the subscription; only the last release unsubscribes both
    const second = await conn.watch(sessionUri(1));
    expect(fake.requests.filter((r) => r.method === "subscribe")).toHaveLength(2);
    release();
    release();
    expect(fake.requests.some((r) => r.method === "unsubscribe")).toBe(false);
    second();
    await until("both unsubscribes", () => fake.requests.filter((r) => r.method === "unsubscribe").length === 2);
    expect(fake.requests.filter((r) => r.method === "unsubscribe").map((r) => (r.params as { channel: string }).channel).sort()).toEqual([chatUri(1), sessionUri(1)].sort());
    expect(conn.chat(sessionUri(1))).toBeUndefined();
  });

  it("summaries walks every listSessions page and follows sessionAdded", async () => {
    const { home, env, entries } = tempHome();
    const fake = await host(entries);
    const { conn, events } = connection({ home, env });
    conn.start();
    await until("five summaries", () => conn.summaries().length === 5);
    expect(fake.requests.filter((r) => r.method === "listSessions")).toHaveLength(3);
    expect(conn.summaries().map((s) => s.title)).toEqual([1, 2, 3, 4, 5].map((n) => `FICTIONAL_chat_${n}`));
    events.length = 0;
    fake.push("ahp-root://", { type: "root/sessionAdded", summary: summary(6) });
    await until("six summaries", () => conn.summaries().length === 6);
    // the list push comes within one window (the connect's own may have just opened one)
    await until("the list push", () => events.some((e) => e.kind === "chats"), PUSH_WINDOW_MS * 4);
    fake.push("ahp-root://", { type: "root/sessionSummaryChanged", session: sessionUri(6), changes: { title: "FICTIONAL_renamed" } });
    await until("the rename", () => conn.summaries().some((s) => s.title === "FICTIONAL_renamed"));
    fake.push("ahp-root://", { type: "root/sessionRemoved", session: sessionUri(2) });
    await until("the removal", () => conn.summaries().length === 5);
    expect(conn.summaries().some((s) => s.resource === sessionUri(2))).toBe(false);
  });

  it("no VS Code server and no host reports no_server", async () => {
    const { home, env } = tempHome();
    const { conn, spawned } = connection({ home, env });
    conn.start();
    await until("no_server", () => conn.state().state === "no_server");
    expect(spawned).toHaveLength(0);
  });

  it("starts the host through the VS Code server CLI when no host runs", async () => {
    const { home, env, entries } = tempHome();
    const cli = join(home, ".vscode-server", `code-${"d".repeat(40)}`);
    mkdirSync(join(home, ".vscode-server"), { recursive: true });
    await Bun.write(cli, "#!/bin/sh\nexit 0\n");
    (await import("node:fs")).chmodSync(cli, 0o755);
    let fake: FakeAgentHost | null = null;
    const { conn, spawned } = connection({
      home, env,
      deps: { sleep: quick, spawn: (argv) => { spawned.push(argv); void host(entries).then((f) => { fake = f; }); } },
    });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    expect(spawned).toEqual([[cli, "--cli-data-dir", join(home, ".vscode-server", "cli"), "agent", "host"]]);
    expect(fake).not.toBeNull();
  });

  it("stop() while the host is starting returns at once and leaves the event loop free", async () => {
    const { home, env } = tempHome();
    const cli = join(home, ".vscode-server", `code-${"e".repeat(40)}`);
    mkdirSync(join(home, ".vscode-server"), { recursive: true });
    await Bun.write(cli, "#!/bin/sh\nexit 0\n");
    (await import("node:fs")).chmodSync(cli, 0o755);
    // the spawned host never registers, so startHost polls toward its 30 s deadline
    const { conn, spawned } = connection({ home, env, deps: { sleep: Bun.sleep, spawn: (argv) => { spawned.push(argv); } } });
    conn.start();
    await until("starting", () => conn.state().state === "starting" && spawned.length === 1);
    const ticks = { count: 0 };
    const timer = setInterval(() => { ticks.count += 1; }, 1);
    const began = Date.now();
    await conn.stop();
    const took = Date.now() - began;
    await until("the event loop to run timers", () => ticks.count >= 2, 2_000);
    clearInterval(timer);
    expect(took).toBeLessThan(1_000);
  });

  it("no models listed means signed_in false", async () => {
    const { home, env, entries } = tempHome();
    await host(entries, { models: [] });
    const { conn } = connection({ home, env });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    expect(conn.state()).toEqual({ state: "connected", signed_in: false, protocol: "1.0.0" });
  });

  it("start off with no host waits and spawns nothing", async () => {
    const { home, env } = tempHome();
    mkdirSync(join(home, ".vscode-server"), { recursive: true });
    const { conn, spawned } = connection({ home, env, startHost: false });
    conn.start();
    await until("waiting", () => conn.state().state === "waiting");
    expect(spawned).toHaveLength(0);
  });

  it("Windows reports unsupported and opens nothing", async () => {
    const { home, env } = tempHome();
    let reads = 0;
    const { conn, spawned } = connection({ home, env, platform: "win32", deps: { spawn: () => { spawned.push([]); }, alive: () => { reads += 1; return true; }, sleep: quick } });
    conn.start();
    expect(conn.state()).toEqual({ state: "unsupported" });
    expect(reads).toBe(0);
    expect(spawned).toHaveLength(0);
    await expect(conn.watch(sessionUri(1))).rejects.toThrow("not_connected");
  });

  it("the token never appears in state, events or errors", async () => {
    const { home, env, entries } = tempHome();
    const fake = await host(entries);
    const seen: string[] = [];
    const { conn, events } = connection({ home, env, onChange: (event) => { events.push(event); seen.push(JSON.stringify(conn.state())); } });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    await conn.watch(sessionUri(1));
    seen.push(JSON.stringify(conn.state()));
    // forced errors: an unknown channel, then a request while the host is gone
    const unknown = await conn.request("subscribe", { channel: "copilotcli:/no-such-session" }).then(() => null, (error: Error) => error);
    expect(unknown).toBeInstanceOf(Error);
    await fake.stop();
    await until("disconnected", () => conn.state().state !== "connected");
    const gone = await conn.request("listSessions", { channel: "ahp-root://" }).then(() => null, (error: Error) => error);
    expect(gone).toBeInstanceOf(Error);
    for (const text of [...seen, ...events.map((e) => JSON.stringify(e)), JSON.stringify(conn.state()), unknown!.message, String(unknown!.stack), gone!.message, String(gone!.stack), JSON.stringify(gone)]) {
      expect(text).not.toContain(fake.token);
    }
  });

  it("a streaming chat pushes at most once per window, and its last push carries the last delta", async () => {
    const { home, env, entries } = tempHome();
    const streaming = { ...chatState(1), status: 8, activeTurn: { id: "turn-live", startedAt: AT, message: { text: "FICTIONAL go", origin: { kind: "user" } }, usage: undefined,
      responseParts: [{ kind: "markdown", id: "part-1", content: "" }] } } as unknown as ChatState;
    const fake = await host(entries, { chats: { [chatUri(1)]: streaming } });
    const content = () => ((conn.chat(sessionUri(1))?.activeTurn?.responseParts[0] as { content?: string } | undefined)?.content ?? "");
    const pushes: string[] = [];
    const { conn } = connection({ home, env, onChange: (event) => { if (event.kind === "chat" && event.session === sessionUri(1)) pushes.push(content()); } });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    await conn.watch(sessionUri(1));
    pushes.length = 0;
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      fake.push(chatUri(1), { type: "chat/delta", turnId: "turn-live", partId: "part-1", content: "x" } as unknown as StateAction);
      await Bun.sleep(2);
    }
    const streamedMs = Date.now() - started;
    await until("all 50 deltas mirrored", () => content().length === 50);
    await until("the trailing push", () => pushes.at(-1)?.length === 50, PUSH_WINDOW_MS * 4);
    // ~100 ms of deltas, under one window: at most the first change and the trailing one (a
    // slower machine that streamed for longer gets one more per window it took)
    expect(pushes.length).toBeLessThanOrEqual(1 + Math.max(1, Math.ceil(streamedMs / PUSH_WINDOW_MS)));
    expect(pushes.at(-1)).toBe("x".repeat(50));
  });

  it("a host restart reconnects, resubscribes the watched chat, and re-sends nothing", async () => {
    const { home, env, entries } = tempHome();
    const first = await host(entries);
    const { conn } = connection({ home, env });
    conn.start();
    await until("connected", () => conn.state().state === "connected");
    // 1. watch a chat, and send it one message
    await conn.watch(sessionUri(1));
    conn.dispatch(chatUri(1), turnStarted("FICTIONAL_message"));
    await until("the first host saw the message", () => first.dispatched.some((d) => d.action.type === "chat/turnStarted"));

    // 2. the host goes away and a new one registers
    await first.stop();
    await until("the drop", () => conn.state().state !== "connected");
    const second = await host(entries);

    // 3. the bridge finds it
    await until("reconnected", () => conn.state().state === "connected");
    await until("the chat resubscribed", () => second.requests.some((r) => r.method === "subscribe" && (r.params as { channel: string }).channel === chatUri(1)));

    // 4. it re-initialized with the same clientId and resubscribed session and chat
    const init = second.requests.find((r) => r.method === "initialize")!.params as Record<string, unknown>;
    expect(init["clientId"]).toBe("herdr-web-0000test");
    expect(second.requests.some((r) => r.method === "subscribe" && (r.params as { channel: string }).channel === sessionUri(1))).toBe(true);
    expect(conn.chat(sessionUri(1))?.resource).toBe(chatUri(1));

    // 5. nothing was re-sent
    expect(second.dispatched.filter((d) => d.action.type === "chat/turnStarted")).toEqual([]);
    // the only thing it sends is the watch's own active-client mark on the session, which a new host does not know
    expect(second.dispatched.map((d) => [d.channel, d.action.type])).toEqual([[sessionUri(1), "session/activeClientSet"]]);
  });
});
