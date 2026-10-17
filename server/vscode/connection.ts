/**
 * The bridge's one client for its PC's VS Code agent host (Agent Host Protocol: JSON-RPC over a
 * WebSocket), built on the official `@microsoft/agent-host-protocol` package.
 *
 * It finds the host in VS Code's endpoint registry (or starts one), offers protocol 1.0.0 then
 * 0.10.0, mirrors the root, the session list and every watched session and chat, and reconnects
 * with backoff when the host goes away (it exits after idle minutes, on `--replace`, or a crash).
 *
 * Invariants:
 * - The host's token goes into the WebSocket URL and nowhere else: not in state, events, errors
 *   or logs. Errors are rebuilt from codes, never from the transport's message, which can carry
 *   the URL.
 * - Nothing is ever re-sent: a dispatch goes out once, now, or throws. A reconnect re-initializes
 *   with the same clientId and resubscribes; it replays no dispatch.
 */
import { randomBytes } from "node:crypto";
import type {
  ActionEnvelope,
  CommandMap,
  ChatState,
  SessionState,
  SessionSummary,
  Snapshot,
  StateAction,
  SubscribeResult,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError, type AhpStateMirror, type ClientEvent } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import type { VscodeHostState } from "../../shared/vscode.ts";
import { findServerCli, startHost as startAgentHost, START_DEADLINE_MS } from "./host-start.ts";
import { VscodeMirror } from "./mirror.ts";
import { liveStandalone, registryDirs, type HostEntry } from "./registry.ts";

export interface VscodeConnectionOptions {
  home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>;
  startHost: boolean;                          // false: HERDR_WEB_AGENT_HOST_START=off
  onChange: (event: VscodeEvent) => void;      // state, chat list, or one chat changed
  clientId?: string;                           // default `herdr-web-<8 hex>`, stable for the process
  deps?: {                                     // tests only; defaults are the real ones
    spawn?: (argv: string[]) => void;          // default: Bun.spawn(argv, {stdin/stdout/stderr: "ignore"}).unref()
    alive?: (pid: number) => boolean;          // default: process.kill(pid, 0)
    now?: () => number; sleep?: (ms: number) => Promise<void>;
  };
}
export type VscodeEvent = { kind: "host" } | { kind: "chats" } | { kind: "chat"; session: string };

/** Why a call to the host failed, by code only: `message` never carries the host's URL or token. */
export type VscodeErrorCode = "not_connected" | "connect_failed" | "refused" | "rpc_error" | "timeout";
export class VscodeError extends Error {
  constructor(readonly code: VscodeErrorCode, readonly rpcCode?: number) {
    super(rpcCode === undefined ? code : `${code} ${rpcCode}`);
    this.name = "VscodeError";
  }
}

const ROOT = "ahp-root://";
export const PROTOCOL_VERSIONS = ["1.0.0", "0.10.0"] as const;
const UNSUPPORTED_PROTOCOL_VERSION = -32005;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PROCESS_CLIENT_ID = `herdr-web-${randomBytes(4).toString("hex")}`;

const defaultSpawn = (argv: string[]): void => {
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
};
const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** A rebuilt error: the package's errors keep the transport's text, which can carry the URL. */
function coded(error: unknown): VscodeError {
  if (error instanceof VscodeError) return error;
  if (error instanceof RpcError) return new VscodeError("rpc_error", error.code);
  if (error instanceof Error && error.name === "RpcTimeoutError") return new VscodeError("timeout");
  return new VscodeError("connect_failed");
}

interface Watch { count: number; chat: string | null; ready: Promise<void> }
interface Live { client: AhpClient; closed: Promise<void> }

export class VscodeConnection {
  readonly clientId: string;
  private readonly options: VscodeConnectionOptions;
  private readonly spawn: (argv: string[]) => void;
  private readonly alive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store = new VscodeMirror();
  private current: VscodeHostState;
  private sessionList: SessionSummary[] = [];
  private readonly watches = new Map<string, Watch>();
  /** Per channel: the snapshot's `fromSeq`; an action at or below it is already in the snapshot. */
  private readonly fromSeq = new Map<string, number>();
  /** Per channel whose subscribe is in flight: the actions that arrived before its snapshot. */
  private readonly early = new Map<string, ActionEnvelope[]>();
  private live: Live | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: () => void = () => {};
  private readonly stopping: Promise<void>;

  constructor(options: VscodeConnectionOptions) {
    this.options = options;
    this.clientId = options.clientId ?? PROCESS_CLIENT_ID;
    this.spawn = options.deps?.spawn ?? defaultSpawn;
    this.alive = options.deps?.alive ?? defaultAlive;
    this.now = options.deps?.now ?? Date.now;
    this.sleep = options.deps?.sleep ?? Bun.sleep;
    this.current = options.platform === "win32" ? { state: "unsupported" } : { state: "starting" };
    this.stopping = new Promise((resolve) => { this.wake = resolve; });
  }

  start(): void {
    if (this.running || this.stopped || this.options.platform === "win32") return;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.live?.client.shutdown();
    await this.running;
  }

  state(): VscodeHostState { return this.current; }
  mirror(): AhpStateMirror { return this.store; }
  summaries(): SessionSummary[] { return this.sessionList; }

  chat(session: string): ChatState | undefined {
    const chat = this.watches.get(session)?.chat;
    return chat ? this.store.getChat(chat) : undefined;
  }

  /** Subscribes `session` and its default chat, shared and reference-counted; the returned function releases this hold. */
  async watch(session: string): Promise<() => void> {
    if (!this.live) throw new VscodeError("not_connected");
    let watch = this.watches.get(session);
    if (watch) {
      watch.count += 1;
    } else {
      watch = { count: 1, chat: null, ready: Promise.resolve() };
      this.watches.set(session, watch);
      watch.ready = this.subscribeWatch(session, watch);
    }
    try {
      await watch.ready;
    } catch (error) {
      if (--watch.count === 0 && this.watches.get(session) === watch) this.drop(session, watch);
      throw coded(error);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--watch.count === 0 && this.watches.get(session) === watch) this.drop(session, watch);
    };
  }

  async request<M extends keyof CommandMap>(method: M, params: CommandMap[M]["params"]): Promise<CommandMap[M]["result"]> {
    const live = this.live;
    if (!live) throw new VscodeError("not_connected");
    try { return await live.client.request(method, params); } catch (error) { throw coded(error); }
  }

  /** Sends `action` once, now. Never queued and never replayed: without a connection it throws. */
  dispatch(channel: string, action: StateAction): void {
    const live = this.live;
    if (!live) throw new VscodeError("not_connected");
    try { live.client.dispatch(channel, action); } catch (error) { throw coded(error); }
  }

  // ─── Connection loop ───────────────────────────────────────────────────────

  private setState(next: VscodeHostState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.options.onChange({ kind: "host" });
  }

  private connectedState(protocol: string): VscodeHostState {
    return { state: "connected", signed_in: this.store.root.agents.some((agent) => agent.models.length > 0), protocol };
  }

  /** Waits `ms`, or less when stop() is called. */
  private async pause(ms: number): Promise<void> {
    await Promise.race([this.stopping, this.sleep(ms)]);
  }

  private async run(): Promise<void> {
    const dirs = registryDirs(this.options.home, this.options.platform, this.options.env);
    let backoff = BACKOFF_FIRST_MS;
    while (!this.stopped) {
      const entry = await this.findHost(dirs);
      if (this.stopped) return;
      if (entry) {
        const connected = await this.connect(entry);
        if (connected) backoff = BACKOFF_FIRST_MS;
      }
      if (this.stopped) return;
      await this.pause(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  /** A live registry entry, or one from starting the host; null (with the state saying why) when there is none. */
  private async findHost(dirs: string[]): Promise<HostEntry | null> {
    const poll = () => liveStandalone(dirs, this.alive);
    const entry = poll();
    if (entry) return entry;
    if (!this.options.startHost) { this.setState({ state: "waiting" }); return null; }
    const cli = findServerCli(this.options.home);
    if (!cli) { this.setState({ state: "no_server" }); return null; }
    this.setState({ state: "starting" });
    return startAgentHost(cli, { spawn: this.spawn, poll, deadlineMs: START_DEADLINE_MS, now: this.now, sleep: (ms) => this.pause(ms) });
  }

  /** One connection's whole life: false when it never got connected, true once it was and has closed. */
  private async connect(entry: HostEntry): Promise<boolean> {
    let transport: WebSocketTransport;
    try {
      transport = await WebSocketTransport.connect(`ws://${entry.host}:${entry.port}/?tkn=${encodeURIComponent(entry.token)}`);
    } catch {
      return false;
    }
    const client = new AhpClient(transport);
    client.connect();
    const events = client.events();
    const closed = this.pump(events);
    if (this.stopped) { await client.shutdown(); return false; }
    this.live = { client, closed };
    let connected = false;
    try {
      const init = await client.initialize({ clientId: this.clientId, protocolVersions: PROTOCOL_VERSIONS, initialSubscriptions: [ROOT] });
      if (!(PROTOCOL_VERSIONS as readonly string[]).includes(init.protocolVersion)) {
        this.setState({ state: "refused", server_version: init.protocolVersion || null });
        throw new VscodeError("refused");
      }
      this.store.reset();
      this.fromSeq.clear();
      for (const snapshot of init.snapshots ?? []) this.applySnapshot(snapshot);
      this.sessionList = await this.listAll(client);
      this.setState(this.connectedState(init.protocolVersion));
      connected = true;
      this.options.onChange({ kind: "chats" });
      await this.resubscribe();
    } catch (error) {
      if (error instanceof RpcError && error.code === UNSUPPORTED_PROTOCOL_VERSION) {
        const versions = (error.data as { supportedVersions?: unknown } | undefined)?.supportedVersions;
        this.setState({ state: "refused", server_version: Array.isArray(versions) && versions.length ? versions.map(String).join(", ") : null });
      }
      if (!connected) {
        this.live = null;
        await client.shutdown();
        await closed;
        return false;
      }
    }
    await closed;
    this.live = null;
    if (!this.stopped) this.setState({ state: "starting" });
    return true;
  }

  private async listAll(client: AhpClient): Promise<SessionSummary[]> {
    const all: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.request("listSessions", { channel: ROOT, ...(cursor ? { cursor } : {}) });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  /** After a reconnect: every watched session and its chat again. Nothing is dispatched but the active-client mark. */
  private async resubscribe(): Promise<void> {
    for (const [session, watch] of this.watches) {
      watch.ready = this.subscribeWatch(session, watch);
      try { await watch.ready; } catch { /* the session may be gone on this host; the watch stays empty */ }
      this.options.onChange({ kind: "chat", session });
    }
  }

  private async subscribeWatch(session: string, watch: Watch): Promise<void> {
    const live = this.live;
    if (!live) throw new VscodeError("not_connected");
    const state = (await this.subscribe(live.client, session, "session")).state as SessionState;
    live.client.dispatch(session, { type: "session/activeClientSet", activeClient: { clientId: this.clientId, displayName: "herdr-web", tools: [] } } as StateAction);
    watch.chat = state.defaultChat ?? null;
    if (watch.chat) await this.subscribe(live.client, watch.chat, "chat");
  }

  /** Subscribes `channel`, holding back the actions that arrive before its snapshot. */
  private async subscribe(client: AhpClient, channel: string, kind: "session" | "chat"): Promise<Snapshot> {
    this.early.set(channel, []);
    let result: SubscribeResult;
    try {
      result = (await client.subscribe(channel)).result;
    } catch (error) {
      this.early.delete(channel);
      throw coded(error);
    }
    const snapshot = result.snapshot;
    const held = this.early.get(channel) ?? [];
    this.early.delete(channel);
    if (!snapshot) throw new VscodeError("rpc_error");
    if (kind === "session") this.store.applySessionSnapshot(snapshot);
    else this.store.applyChatSnapshot(snapshot);
    this.fromSeq.set(channel, snapshot.fromSeq);
    for (const envelope of held) this.applyAction(envelope);
    return snapshot;
  }

  private drop(session: string, watch: Watch): void {
    this.watches.delete(session);
    const channels = watch.chat ? [session, watch.chat] : [session];
    for (const channel of channels) {
      this.store.forget(channel);
      this.fromSeq.delete(channel);
      void this.live?.client.unsubscribe(channel).catch(() => {});
    }
  }

  private applySnapshot(snapshot: Snapshot): void {
    this.store.applySnapshot(snapshot);
    this.fromSeq.set(snapshot.resource, snapshot.fromSeq);
  }

  private applyAction(envelope: ActionEnvelope): void {
    const seen = this.fromSeq.get(envelope.channel);
    if (seen !== undefined && envelope.serverSeq <= seen) return;
    this.store.apply(envelope);
    if (seen !== undefined) this.fromSeq.set(envelope.channel, envelope.serverSeq);
  }

  /** The session whose watch covers `channel` (its own channel or its chat's). */
  private watcherOf(channel: string): string | null {
    if (this.watches.has(channel)) return channel;
    for (const [session, watch] of this.watches) if (watch.chat === channel) return session;
    return null;
  }

  /** Reads every event until the connection closes. */
  private async pump(events: AsyncIterableIterator<ClientEvent>): Promise<void> {
    for await (const { channel, event } of events) {
      try {
        if (event.type === "action") {
          const held = this.early.get(channel);
          if (held) { held.push(event.params); continue; }
          this.applyAction(event.params);
          if (channel === ROOT) {
            if (this.current.state === "connected") this.setState(this.connectedState(this.current.protocol));
            continue;
          }
          const session = this.watcherOf(channel);
          if (session) this.options.onChange({ kind: "chat", session });
        } else if (event.type === "sessionAdded") {
          const added = event.params.summary;
          this.sessionList = [...this.sessionList.filter((s) => s.resource !== added.resource), added];
          this.options.onChange({ kind: "chats" });
        } else if (event.type === "sessionRemoved") {
          this.sessionList = this.sessionList.filter((s) => s.resource !== event.params.session);
          this.options.onChange({ kind: "chats" });
        } else if (event.type === "sessionSummaryChanged") {
          const { session, changes } = event.params;
          this.sessionList = this.sessionList.map((s) => (s.resource === session ? { ...s, ...changes } : s));
          this.options.onChange({ kind: "chats" });
        }
      } catch {
        // a consumer's onChange or a reducer threw: one event, not the connection
      }
    }
  }
}
