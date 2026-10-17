/**
 * A fake VS Code agent host for tests: an AHP JSON-RPC server over a WebSocket on port 0, shaped on
 * a real VS Code 1.142 capture. It checks `?tkn=`, answers the commands the bridge uses, applies the
 * package's reducers to dispatched actions and echoes them back as `action` notifications.
 *
 * Fixtures are fictional; a test seeds them.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  chatReducer,
  sessionReducer,
  type ChatAction,
  type ChatState,
  type SessionAction,
  type SessionModelInfo,
  type SessionState,
  type SessionSummary,
  type StateAction,
  type Turn,
} from "@microsoft/agent-host-protocol";

/** A root notification the fake can push besides state actions. */
export type FakeRootNotice =
  | { type: "root/sessionAdded"; summary: SessionSummary }
  | { type: "root/sessionRemoved"; session: string }
  | { type: "root/sessionSummaryChanged"; session: string; changes: Partial<SessionSummary> };

export interface FakeAgentHostSeed {
  sessions: SessionSummary[];
  states: Record<string, SessionState>;
  chats: Record<string, ChatState>;
  older?: Record<string, { turns: Turn[]; cursor?: string }>;
  models: SessionModelInfo[];
  /** Refuse every handshake, naming this as the server's version. */
  refuse?: string;
  /** Write this host's own `standalone` registry entry into this directory. */
  entryDir?: string;
  /** Per channel: how many of its next subscribes fail (as a host that times out or lost it would). */
  failSubscribes?: Record<string, number>;
}

export interface FakeAgentHost {
  port: number;
  token: string;
  dispatched: Array<{ channel: string; action: StateAction }>;
  requests: Array<{ method: string; params: unknown }>;
  push(channel: string, action: StateAction | FakeRootNotice): void;
  /** How many clients are connected now. */
  peers(): number;
  stop(): Promise<void>;
}

const ROOT = "ahp-root://";
const PAGE = 2;
const NOTICES = new Set(["root/sessionAdded", "root/sessionRemoved", "root/sessionSummaryChanged"]);

interface Peer { clientId: string | null }
interface Frame { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> }

export async function fakeAgentHost(seed: FakeAgentHostSeed): Promise<FakeAgentHost> {
  const token = `fictional-${crypto.randomUUID()}`;
  const sessions = seed.sessions.map((summary) => ({ ...summary }));
  const states: Record<string, SessionState> = { ...seed.states };
  const chats: Record<string, ChatState> = { ...seed.chats };
  const failSubscribes: Record<string, number> = { ...seed.failSubscribes };
  const dispatched: FakeAgentHost["dispatched"] = [];
  const requests: FakeAgentHost["requests"] = [];
  const peers = new Set<ServerWebSocket<Peer>>();
  let serverSeq = 1000;

  const send = (ws: ServerWebSocket<Peer>, frame: unknown) => { ws.send(JSON.stringify(frame)); };
  const broadcast = (frame: unknown) => { for (const ws of peers) send(ws, frame); };
  const announce = (channel: string, action: StateAction, origin?: { clientId: string; clientSeq: number }) => {
    serverSeq += 1;
    broadcast({ jsonrpc: "2.0", method: "action", params: { channel, serverSeq, action, ...(origin ? { origin } : {}) } });
  };
  const apply = (channel: string, action: StateAction) => {
    const chat = chats[channel];
    if (chat) { chats[channel] = chatReducer(chat, action as ChatAction, () => {}); return; }
    const state = states[channel];
    if (state) states[channel] = sessionReducer(state, action as SessionAction, () => {});
  };
  const notice = (channel: string, item: FakeRootNotice) => {
    if (item.type === "root/sessionAdded") sessions.push(item.summary);
    else if (item.type === "root/sessionRemoved") sessions.splice(0, sessions.length, ...sessions.filter((s) => s.resource !== item.session));
    else { const at = sessions.find((s) => s.resource === item.session); if (at) Object.assign(at, item.changes); }
    const { type, ...params } = item;
    broadcast({ jsonrpc: "2.0", method: type, params: { channel, ...params } });
  };

  function answer(ws: ServerWebSocket<Peer>, id: number, method: string, params: Record<string, unknown>): void {
    const ok = (result: unknown) => send(ws, { jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string, data?: unknown) => send(ws, { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
    switch (method) {
      case "initialize": {
        if (seed.refuse !== undefined) {
          fail(-32005, `Unsupported protocol version; server speaks ${seed.refuse}`, { supportedVersions: [seed.refuse] });
          return;
        }
        ws.data.clientId = String(params["clientId"]);
        const offered = (params["protocolVersions"] as string[] | undefined) ?? [];
        if (!offered.includes("1.0.0")) { fail(-32005, "Unsupported protocol version; server speaks 1.0.0", { supportedVersions: ["1.0.0"] }); return; }
        ok({
          protocolVersion: "1.0.0",
          serverSeq,
          snapshots: [{ resource: ROOT, fromSeq: serverSeq, state: { agents: [{ provider: "copilotcli", displayName: "Fictional Agent", description: "A fictional agent", models: seed.models }], activeSessions: 0 } }],
          defaultDirectory: "file:///tmp/fictional-repo",
        });
        return;
      }
      case "listSessions": {
        const start = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
        if (!Number.isInteger(start) || start < 0) { fail(-32602, "unknown cursor"); return; }
        const items = sessions.slice(start, start + PAGE);
        ok(start + PAGE < sessions.length ? { items, nextCursor: String(start + PAGE) } : { items });
        return;
      }
      case "subscribe": {
        const channel = String(params["channel"]);
        const failing = failSubscribes[channel] ?? 0;
        if (failing > 0) { failSubscribes[channel] = failing - 1; fail(-32603, `FICTIONAL subscribe failure on ${channel}`); return; }
        const state = states[channel] ?? chats[channel];
        if (!state) { fail(-32008, `no such channel ${channel}`); return; }
        ok({ snapshot: { resource: channel, fromSeq: serverSeq, state } });
        return;
      }
      case "createSession": {
        const channel = String(params["channel"]);
        const chat = `ahp-chat://default/${Buffer.from(channel).toString("base64")}`;
        const now = new Date(0).toISOString();
        const summary: SessionSummary = { resource: channel, provider: String(params["provider"] ?? "copilotcli"), title: "", status: 1, createdAt: now, modifiedAt: now, defaultChat: chat };
        states[channel] = { provider: summary.provider, title: "", status: 1, lifecycle: "ready", activeClients: [], chats: [{ resource: chat, title: "", status: 1, modifiedAt: now }], defaultChat: chat } as SessionState;
        chats[chat] = { resource: chat, title: "", status: 1, modifiedAt: now, turns: [] } as unknown as ChatState;
        ok(null);
        notice(ROOT, { type: "root/sessionAdded", summary });
        return;
      }
      case "fetchTurns": {
        const channel = String(params["channel"]);
        ok({});
        const page = seed.older?.[channel];
        if (!page) return;
        const action = { type: "chat/turnsLoaded", turns: page.turns, ...(page.cursor ? { turnsNextCursor: page.cursor } : {}) } as StateAction;
        apply(channel, action);
        announce(channel, action);
        return;
      }
      default:
        fail(-32601, `method not found: ${method}`);
    }
  }

  const server = Bun.serve<Peer>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, instance) {
      if (new URL(request.url).searchParams.get("tkn") !== token) return new Response("forbidden", { status: 403 });
      if (instance.upgrade(request, { data: { clientId: null } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) { peers.add(ws); },
      close(ws) { peers.delete(ws); },
      message(ws, raw) {
        let frame: Frame;
        try { frame = JSON.parse(String(raw)) as Frame; } catch { return; }
        const method = frame.method ?? "";
        const params = frame.params ?? {};
        requests.push({ method, params });
        if (frame.id !== undefined) { answer(ws, frame.id, method, params); return; }
        if (method === "dispatchAction") {
          const channel = String(params["channel"]);
          const action = params["action"] as StateAction;
          dispatched.push({ channel, action });
          apply(channel, action);
          announce(channel, action, { clientId: ws.data.clientId ?? "", clientSeq: Number(params["clientSeq"]) });
        }
      },
    },
  });
  const port = server.port!;
  const entryFile = seed.entryDir ? join(seed.entryDir, `fake-${port}.json`) : null;
  if (entryFile) {
    writeFileSync(entryFile, JSON.stringify({ schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port }, connectionToken: token, protocolVersion: "1.0.0" }));
  }

  return {
    port,
    token,
    dispatched,
    requests,
    push(channel, item) {
      if (NOTICES.has(item.type)) { notice(channel, item as FakeRootNotice); return; }
      // an action this fake's own reducer cannot apply is still sent, as a host would
      try { apply(channel, item as StateAction); } catch { /* the fake's copy stays as it was */ }
      announce(channel, item as StateAction);
    },
    peers: () => peers.size,
    async stop() {
      if (entryFile) rmSync(entryFile, { force: true });
      await server.stop(true);
    },
  };
}
