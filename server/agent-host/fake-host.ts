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
  type StringOrMarkdown,
  type ToolCallResult,
  type ToolInput,
  type Turn,
} from "@microsoft/agent-host-protocol";

/** A chat after these actions, through the package's own reducer, as a host would hold it. */
export function reducedChat(actions: StateAction[], start?: ChatState): ChatState {
  const empty = { resource: "ahp-chat://default/fictional", title: "FICTIONAL_chat", status: 1, modifiedAt: new Date(0).toISOString(), turns: [] } as unknown as ChatState;
  return actions.reduce((chat, action) => chatReducer(chat, action as ChatAction, () => {}), start ?? empty);
}

/**
 * The actions a host sends for one tool call of turn `turnId`: started, ready (no confirmation
 * needed) and, given a result, completed with it. Without one the call is left running.
 */
export function toolCallActions(
  turnId: string,
  call: { toolCallId: string; toolName: string; displayName: string; invocationMessage: StringOrMarkdown; toolInput?: ToolInput },
  result?: ToolCallResult,
): StateAction[] {
  const base = { turnId, toolCallId: call.toolCallId };
  return [
    { type: "chat/toolCallStart", ...base, toolName: call.toolName, displayName: call.displayName },
    { type: "chat/toolCallReady", ...base, invocationMessage: call.invocationMessage, ...(call.toolInput === undefined ? {} : { toolInput: call.toolInput }), confirmed: "not-needed" },
    ...(result ? [{ type: "chat/toolCallComplete", ...base, result }] : []),
  ] as StateAction[];
}

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
  /** Per channel: the items a `completions` request answers (none: an empty list). */
  completions?: Record<string, unknown[]>;
  /** Files and content refs by URI, as `resourceRead` / `resourceWrite` / `resourceDelete` see them. */
  files?: Record<string, string>;
  /** The agent's `capabilities` (default: forks and side chats, as VS Code 1.142's copilotcli). */
  capabilities?: Record<string, unknown>;
}

export interface FakeAgentHost {
  port: number;
  token: string;
  dispatched: Array<{ channel: string; action: StateAction }>;
  requests: Array<{ method: string; params: unknown }>;
  /** what `resource*` sees now, by URI */
  files: Map<string, string>;
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
  const files = new Map(Object.entries(seed.files ?? {}));
  // sessions made and not yet listed, by their default chat: they have had no message
  const unlisted = new Map<string, SessionSummary>();
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
  /**
   * What a host does to its catalog after a client's title, read or archived action: the session's
   * summary follows (the default chat's read flag is the session's; archived is the session's own action), announced as root/sessionSummaryChanged.
   */
  const follow = (channel: string, action: StateAction) => {
    const forkOwner = sessions.find((s) => s.defaultChat !== channel && (s.chats ?? []).some((c) => c.resource === channel));
    if (forkOwner) { followChat(forkOwner, channel, action); return; }
    const owner = sessions.find((s) => s.resource === channel || s.defaultChat === channel);
    if (!owner) return;
    const bit = action.type === "chat/isReadChanged" ? 32 : 0;
    if (action.type === "session/isArchivedChanged" && owner.resource === channel) {
      const on = (action as { isArchived: boolean }).isArchived;
      notice(ROOT, { type: "root/sessionSummaryChanged", session: owner.resource, changes: { status: on ? owner.status | 64 : owner.status & ~64 } });
    } else if (action.type === "session/titleChanged" && owner.resource === channel) {
      notice(ROOT, { type: "root/sessionSummaryChanged", session: owner.resource, changes: { title: (action as { title: string }).title } });
    } else if (bit !== 0 && owner.defaultChat === channel) {
      const on = action.type === "chat/isReadChanged" ? (action as { isRead: boolean }).isRead : (action as { isArchived: boolean }).isArchived;
      notice(ROOT, { type: "root/sessionSummaryChanged", session: owner.resource, changes: { status: on ? owner.status | bit : owner.status & ~bit } });
    }
  };
  /**
   * A session's other chat (a fork), as VS Code 1.142's host keeps it (probed 2026-10-20): its title,
   * read and archived bits and its activity are its own, in the session's catalog (SessionSummary.chats),
   * announced as root/sessionSummaryChanged and session/chatUpdated; the session's own stay as they were.
   */
  const followChat = (owner: SessionSummary, channel: string, action: StateAction) => {
    const entry = (owner.chats ?? []).find((c) => c.resource === channel)!;
    let changes: Partial<NonNullable<SessionSummary["chats"]>[number]> | null = null;
    const status = entry.status ?? 1;
    if (action.type === "session/titleChanged") changes = { title: (action as { title: string }).title };
    else if (action.type === "chat/isReadChanged") changes = { status: (action as { isRead: boolean }).isRead ? status | 32 : status & ~32 };
    else if (action.type === "chat/isArchivedChanged") changes = { status: (action as { isArchived: boolean }).isArchived ? status | 64 : status & ~64 };
    else if (action.type === "chat/turnStarted") changes = { status: (status & ~(1 | 2)) | 8 };
    if (!changes) return;
    chatCatalog(owner.resource, owner.chats!.map((c) => (c.resource === channel ? { ...c, ...changes } : c)));
    const state = states[owner.resource];
    if (state) { const sessionAction = { type: "session/chatUpdated", chat: channel, changes } as StateAction; apply(owner.resource, sessionAction); announce(owner.resource, sessionAction); }
  };
  /** A session's catalog changed: the list hears it as root/sessionSummaryChanged, as the host's does. */
  const chatCatalog = (session: string, chats: NonNullable<SessionSummary["chats"]>) => {
    notice(ROOT, { type: "root/sessionSummaryChanged", session, changes: { chats } });
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
          snapshots: [{ resource: ROOT, fromSeq: serverSeq, state: { agents: [{ provider: "copilotcli", displayName: "Fictional Agent", description: "A fictional agent", models: seed.models, capabilities: seed.capabilities ?? { multipleChats: { fork: true, sideChat: true } } }], activeSessions: 0 } }],
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
        const workingDirectories = params["workingDirectories"] as string[] | undefined;
        states[channel] = { provider: summary.provider, title: "", status: 1, lifecycle: "ready", activeClients: [], chats: [{ resource: chat, title: "", status: 1, modifiedAt: now }], defaultChat: chat, ...(workingDirectories ? { workingDirectories } : {}) } as SessionState;
        chats[chat] = { resource: chat, title: "", status: 1, modifiedAt: now, turns: [] } as unknown as ChatState;
        ok(null);
        // as VS Code 1.142's host (probed 2026-10-19): a session is listed once its first message goes
        unlisted.set(chat, { ...summary, ...(workingDirectories ? { workingDirectories } : {}) });
        return;
      }
      case "disposeSession": {
        const channel = String(params["channel"]);
        const summary = sessions.find((s) => s.resource === channel);
        const quiet = [...unlisted.values()].find((s) => s.resource === channel);
        if (!summary && !quiet) { fail(-32008, `no such session ${channel}`); return; }
        ok(null);
        if (quiet) { unlisted.delete(quiet.defaultChat!); delete chats[quiet.defaultChat!]; delete states[channel]; return; }
        if (summary!.defaultChat) delete chats[summary!.defaultChat];
        delete states[channel];
        notice(ROOT, { type: "root/sessionRemoved", session: channel });
        return;
      }
      // VS Code's Fork Conversation (1.142): a new chat in the same session with the source chat's
      // turns through `turnId`, in the session's catalog; the chat URI is the client's
      case "createChat": {
        const channel = String(params["channel"]);
        const chat = String(params["chat"]);
        const source = params["source"] as { kind: string; chat: string; turnId: string } | undefined;
        const owner = sessions.find((s) => s.resource === channel);
        const from = source ? chats[source.chat] : undefined;
        const fork = (seed.capabilities as { multipleChats?: { fork?: boolean } } | undefined)?.multipleChats?.fork ?? true;
        if (!owner || !source || source.kind !== "fork" || !from || !fork) { fail(-32602, "FICTIONAL createChat refused"); return; }
        const at = from.turns.findIndex((turn) => turn.id === source.turnId);
        if (at < 0) { fail(-32602, `no such turn ${source.turnId}`); return; }
        ok(null);
        if (chats[chat]) return;
        const now = new Date(0).toISOString();
        const title = `FICTIONAL fork of ${from.title}`;
        chats[chat] = { resource: chat, title, status: 1, modifiedAt: now, turns: from.turns.slice(0, at + 1) } as unknown as ChatState;
        const entry = { resource: chat, title, status: 1, origin: { kind: "fork", chat: source.chat, turnId: source.turnId } } as NonNullable<SessionSummary["chats"]>[number];
        const state = states[channel];
        if (state) { const added = { type: "session/chatAdded", summary: { ...entry, modifiedAt: now } } as StateAction; apply(channel, added); announce(channel, added); }
        chatCatalog(channel, [...(owner.chats ?? [{ resource: owner.defaultChat!, title: owner.title, status: owner.status, origin: { kind: "user" } } as NonNullable<SessionSummary["chats"]>[number]]), entry]);
        return;
      }
      case "disposeChat": {
        const chat = String(params["channel"]);
        const owner = sessions.find((s) => s.defaultChat !== chat && (s.chats ?? []).some((c) => c.resource === chat));
        if (!owner) { fail(-32008, `no such chat ${chat}`); return; }
        ok(null);
        delete chats[chat];
        const state = states[owner.resource];
        if (state) { const removed = { type: "session/chatRemoved", chat } as StateAction; apply(owner.resource, removed); announce(owner.resource, removed); }
        chatCatalog(owner.resource, owner.chats!.filter((c) => c.resource !== chat));
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
      case "completions": {
        ok({ items: seed.completions?.[String(params["channel"])] ?? [] });
        return;
      }
      // a host's files and its edits' content refs, in memory: what `resource*` reads and changes
      case "resourceRead": {
        const uri = String(params["uri"]);
        const data = files.get(uri);
        if (data === undefined) { fail(-32008, `not found: ${uri}`); return; }
        ok({ data: Buffer.from(data).toString("base64"), encoding: "base64", contentType: "text/plain" });
        return;
      }
      case "resourceWrite": {
        const uri = String(params["uri"]);
        const raw = String(params["data"]);
        files.set(uri, params["encoding"] === "base64" ? Buffer.from(raw, "base64").toString() : raw);
        ok({});
        return;
      }
      case "resourceDelete": {
        const uri = String(params["uri"]);
        if (!files.delete(uri)) { fail(-32008, `not found: ${uri}`); return; }
        ok({});
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
          const waiting = unlisted.get(channel);
          if (waiting && action.type === "chat/turnStarted") { unlisted.delete(channel); notice(ROOT, { type: "root/sessionAdded", summary: waiting }); }
          // VS Code's host (1.142) refuses to archive a session's default chat: "Only a known
          // independently manageable non-default chat can be archived"; the session is archived instead
          if (action.type === "chat/isArchivedChanged" && sessions.some((each) => each.defaultChat === channel)) return;
          apply(channel, action);
          announce(channel, action, { clientId: ws.data.clientId ?? "", clientSeq: Number(params["clientSeq"]) });
          follow(channel, action);
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
    files,
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
