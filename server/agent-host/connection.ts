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
import type { AgentHostState } from "../../shared/host-chats.ts";
import { findServerCli, startHost as startAgentHost, START_DEADLINE_MS } from "./host-start.ts";
import { AgentHostMirror } from "./mirror.ts";
import { liveStandalone, liveStandalones, registryDirs, type HostEntry } from "./registry.ts";

export interface AgentHostConnectionOptions {
  home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>;
  startHost: boolean;                          // false: HERDR_WEB_AGENT_HOST_START=off
  onChange: (event: AgentHostEvent) => void;      // state, chat list, or one chat changed
  clientId?: string;                           // default `herdr-web-<8 hex>`, stable for the process
  deps?: {                                     // tests only; defaults are the real ones
    spawn?: (argv: string[]) => number | void; // default: Bun.spawn(argv, {stdin/stdout/stderr: "ignore", detached: true}).unref(), its pid
    alive?: (pid: number) => boolean;          // default: process.kill(pid, 0)
    now?: () => number; sleep?: (ms: number) => Promise<void>;
  };
}
export type AgentHostEvent = { kind: "host" } | { kind: "chats" } | { kind: "chat"; session: string };

/** Why a call to the host failed, by code only: `message` never carries the host's URL or token. */
export type AgentHostErrorCode = "not_connected" | "connect_failed" | "refused" | "rpc_error" | "timeout";
export class AgentHostError extends Error {
  constructor(readonly code: AgentHostErrorCode, readonly rpcCode?: number) {
    super(rpcCode === undefined ? code : `${code} ${rpcCode}`);
    this.name = "AgentHostError";
  }
}

const ROOT = "ahp-root://";
export const PROTOCOL_VERSIONS = ["1.0.0", "0.10.0"] as const;
const UNSUPPORTED_PROTOCOL_VERSION = -32005;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * How often a bridge on a host that lists no models looks at the other live hosts: when every host
 * was empty at connect time (none signed in yet), ah-byok-signin or a VS Code window may sign in
 * another one later, and this host would answer every chat with an error until its socket closed.
 */
export const RECHECK_MS = 30_000;
const PROCESS_CLIENT_ID = `herdr-web-${randomBytes(4).toString("hex")}`;
/**
 * The shortest gap between two pushes of the same chat (or of the chat list): a streaming reply
 * changes its chat every few ms, and every push goes to every phone, which then reads the chat.
 * A change in the window goes out when it ends, so the last state is always pushed.
 */
export const PUSH_WINDOW_MS = 300;

// detached: its own session and process group (setsid), so a signal to the bridge's group never
// reaches VS Code's shared agent host; unref: the bridge does not wait for it
const defaultSpawn = (argv: string[]): number => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  return child.pid;
};
const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** An error's name for a log line: never its message, which can carry the host's URL and token. */
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;

/** A rebuilt error: the package's errors keep the transport's text, which can carry the URL. */
function coded(error: unknown): AgentHostError {
  if (error instanceof AgentHostError) return error;
  if (error instanceof RpcError) return new AgentHostError("rpc_error", error.code);
  if (error instanceof Error && error.name === "RpcTimeoutError") return new AgentHostError("timeout");
  return new AgentHostError("connect_failed");
}

/**
 * Per key, at most one call per window: the first change goes out at once and opens the window;
 * changes inside it are held and the latest goes out when it closes, opening the next one.
 */
class Coalescer {
  private readonly windows = new Map<string, { timer: ReturnType<typeof setTimeout>; held: AgentHostEvent | null }>();
  constructor(private readonly emit: (event: AgentHostEvent) => void, private readonly ms: number) {}

  push(key: string, event: AgentHostEvent): void {
    const open = this.windows.get(key);
    if (open) { open.held = event; return; }
    this.emit(event);
    this.open(key);
  }

  private open(key: string): void {
    const window = { timer: setTimeout(() => {
      this.windows.delete(key);
      if (window.held) { this.emit(window.held); this.open(key); }
    }, this.ms), held: null as AgentHostEvent | null };
    window.timer.unref?.();
    this.windows.set(key, window);
  }

  clear(): void {
    for (const window of this.windows.values()) clearTimeout(window.timer);
    this.windows.clear();
  }
}

/** `session`: the session channel it subscribes (a fork's key is its chat URI, its session another). */
interface Watch { count: number; session: string; chat: string | null; ready: Promise<void> }
/** A chat watched on its own (a subagent's worker chat), for the session whose chat started it. */
/** `inner`: the worker's own chat when its URI names a session (VS Code 1.142 names subagents `<session>/subagent/<id>`). */
interface ChatWatch { count: number; session: string; ready: Promise<void>; inner?: string }
interface Live { client: AhpClient; closed: Promise<void> }

export class AgentHostConnection {
  readonly clientId: string;
  private readonly options: AgentHostConnectionOptions;
  private readonly spawn: (argv: string[]) => number | void;
  /** The `agent host` this bridge last started, while it may still be downloading VS Code's server. */
  private startedPid: number | null = null;
  private dirs: string[] = [];
  private readonly alive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store = new AgentHostMirror();
  private current: AgentHostState;
  private sessionList: SessionSummary[] = [];
  private readonly watches = new Map<string, Watch>();
  private readonly chatWatches = new Map<string, ChatWatch>();
  /** Per channel: the snapshot's `fromSeq`; an action at or below it is already in the snapshot. */
  private readonly fromSeq = new Map<string, number>();
  /** Per channel whose subscribe is in flight: the actions that arrived before its snapshot. */
  private readonly early = new Map<string, ActionEnvelope[]>();
  private live: Live | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: () => void = () => {};
  private readonly stopping: Promise<void>;
  private readonly pushes: Coalescer;

  constructor(options: AgentHostConnectionOptions) {
    this.options = options;
    this.clientId = options.clientId ?? PROCESS_CLIENT_ID;
    this.spawn = options.deps?.spawn ?? defaultSpawn;
    this.alive = options.deps?.alive ?? defaultAlive;
    this.now = options.deps?.now ?? Date.now;
    this.sleep = options.deps?.sleep ?? Bun.sleep;
    this.current = options.platform === "win32" ? { state: "unsupported" } : { state: "starting" };
    this.stopping = new Promise((resolve) => { this.wake = resolve; });
    this.pushes = new Coalescer((event) => {
      if (this.stopped) return;
      // a push can run from the window's timer: a consumer that throws is logged, never thrown there
      try { this.options.onChange(event); } catch (error) { console.warn(`agent-host: a ${event.kind} push failed (${errorName(error)})`); }
    }, PUSH_WINDOW_MS);
  }

  /** A change of one chat, or of the list: at most one push per PUSH_WINDOW_MS each, the last one always. */
  private changed(event: AgentHostEvent): void {
    this.pushes.push(event.kind === "chat" ? `chat\n${event.session}` : event.kind, event);
  }

  start(): void {
    if (this.running || this.stopped || this.options.platform === "win32") return;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    this.pushes.clear();
    await this.live?.client.shutdown();
    await this.running;
  }

  state(): AgentHostState { return this.current; }
  mirror(): AhpStateMirror { return this.store; }
  summaries(): SessionSummary[] { return this.sessionList; }

  chat(session: string): ChatState | undefined {
    const chat = this.watches.get(session)?.chat;
    return chat ? this.store.getChat(chat) : undefined;
  }

  /** A chat watched on its own (watchChat), as the mirror holds it; undefined when it is not watched. */
  chatAt(uri: string): ChatState | undefined {
    const watch = this.chatWatches.get(uri);
    return watch ? this.store.getChat(watch.inner ?? uri) : undefined;
  }

  /**
   * Subscribes one chat that is not a session's default (a subagent's worker chat), shared and
   * reference-counted like watch(). Its changes push as changes of `session`, the chat that started
   * it, whose read shows its model and times. Read only: nothing is dispatched to it.
   */
  async watchChat(uri: string, session: string): Promise<() => void> {
    const live = this.live;
    if (!live) throw new AgentHostError("not_connected");
    let watch = this.chatWatches.get(uri);
    if (watch) {
      watch.count += 1;
    } else {
      watch = { count: 1, session, ready: Promise.resolve() };
      this.chatWatches.set(uri, watch);
      watch.ready = this.subscribeWorker(live.client, uri, watch);
    }
    const own = watch;
    try {
      await own.ready;
    } catch (error) {
      if (--own.count === 0 && this.chatWatches.get(uri) === own) this.dropChat(uri);
      throw coded(error);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--own.count === 0 && this.chatWatches.get(uri) === own) this.dropChat(uri);
    };
  }

  /** Whether `uri` has a chat watch now. */
  watchingChat(uri: string): boolean { return this.chatWatches.has(uri); }

  private dropChat(uri: string): void {
    const inner = this.chatWatches.get(uri)?.inner;
    this.chatWatches.delete(uri);
    for (const channel of inner ? [uri, inner] : [uri]) {
      this.store.forget(channel);
      this.fromSeq.delete(channel);
      void this.live?.client.unsubscribe(channel).catch(() => {});
    }
  }

  /**
   * A worker chat's subscribe. A chat URI is the chat; a session URI (a subagent of VS Code 1.142+)
   * is subscribed as a session, and its default chat is the one read.
   */
  private async subscribeWorker(client: AhpClient, uri: string, watch: ChatWatch): Promise<void> {
    if (uri.startsWith("ahp-chat:")) { await this.subscribe(client, uri, "chat"); return; }
    const state = (await this.subscribe(client, uri, "session")).state as SessionState;
    watch.inner = state.defaultChat ?? undefined;
    if (watch.inner) await this.subscribe(client, watch.inner, "chat");
  }

  /**
   * The session a session's other chat (a fork, VS Code's Fork Conversation) is in, by its chat URI,
   * from the list's catalog (SessionSummary.chats); null for a session's own URI or an unknown chat.
   */
  ownerOf(chat: string): string | null {
    if (!chat.startsWith("ahp-chat:")) return null;
    return this.sessionList.find((summary) => summary.defaultChat !== chat && (summary.chats ?? []).some((each) => each.resource === chat))?.resource ?? null;
  }

  /**
   * Subscribes `session` and its default chat, shared and reference-counted; the returned function
   * releases this hold. A session's other chat (a fork) is watched by its chat URI: its session and that chat.
   */
  async watch(session: string): Promise<() => void> {
    if (!this.live) throw new AgentHostError("not_connected");
    let watch = this.watches.get(session);
    if (watch) {
      watch.count += 1;
    } else {
      watch = { count: 1, session, chat: null, ready: Promise.resolve() };
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
    if (!live) throw new AgentHostError("not_connected");
    try { return await live.client.request(method, params); } catch (error) { throw coded(error); }
  }

  /** Sends `action` once, now. Never queued and never replayed: without a connection it throws. */
  dispatch(channel: string, action: StateAction): void {
    const live = this.live;
    if (!live) throw new AgentHostError("not_connected");
    try { live.client.dispatch(channel, action); } catch (error) { throw coded(error); }
  }

  // ─── Connection loop ───────────────────────────────────────────────────────

  private setState(next: AgentHostState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.options.onChange({ kind: "host" });
  }

  private connectedState(protocol: string): AgentHostState {
    return { state: "connected", signed_in: this.store.root.agents.some((agent) => agent.models.length > 0), protocol };
  }

  /** Waits `ms`, or less when stop() is called. */
  private async pause(ms: number): Promise<void> {
    await Promise.race([this.stopping, this.sleep(ms)]);
  }

  private async run(): Promise<void> {
    const dirs = registryDirs(this.options.home, this.options.platform, this.options.env);
    this.dirs = dirs;
    let backoff = BACKOFF_FIRST_MS;
    while (!this.stopped) {
      const entries = await this.findHosts(dirs);
      if (this.stopped) return;
      // several live hosts (starts that raced): the newest one that lists models, as a host no
      // client signed in has none and answers every chat with an error; else the newest
      let outcome: "never" | "closed" | "no_models" = "never";
      for (const entry of entries) {
        outcome = await this.connect(entry, entries.length > 1);
        if (outcome !== "no_models" || this.stopped) break;
      }
      if (outcome === "no_models" && !this.stopped) outcome = await this.connect(entries[0]!);
      if (outcome === "closed") backoff = BACKOFF_FIRST_MS;
      if (this.stopped) return;
      await this.pause(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  /**
   * The live registry entries, newest first, or the one from starting the host; empty (with the state
   * saying why) when there is none. A host this bridge started that is still alive is waited for, not
   * started again: its first start downloads VS Code's server (minutes) before it registers.
   */
  private async findHosts(dirs: string[]): Promise<HostEntry[]> {
    const found = liveStandalones(dirs, this.alive);
    if (found.length > 0) return found;
    if (!this.options.startHost) { this.setState({ state: "waiting" }); return []; }
    const cli = findServerCli(this.options.home);
    if (!cli) { this.setState({ state: "no_server" }); return []; }
    this.setState({ state: "starting" });
    const starting = this.startedPid !== null && this.alive(this.startedPid);
    const spawn = (argv: string[]): void => {
      if (starting) return;
      const pid = this.spawn(argv);
      this.startedPid = typeof pid === "number" ? pid : null;
    };
    const entry = await startAgentHost(cli, { spawn, poll: () => liveStandalone(dirs, this.alive), deadlineMs: START_DEADLINE_MS, now: this.now, sleep: (ms) => this.pause(ms), aborted: () => this.stopped });
    return entry ? [entry] : [];
  }

  /**
   * One connection's whole life: `never` when it never got connected, `closed` once it was and has
   * closed, `no_models` when `needModels` and the host lists no models (it was let go at once).
   */
  private async connect(entry: HostEntry, needModels = false): Promise<"never" | "closed" | "no_models"> {
    let transport: WebSocketTransport;
    try {
      transport = await WebSocketTransport.connect(`ws://${entry.host}:${entry.port}/?tkn=${encodeURIComponent(entry.token)}`);
    } catch {
      return "never";
    }
    const client = new AhpClient(transport);
    client.connect();
    const events = client.events();
    const closed = this.pump(events);
    if (this.stopped) { await client.shutdown(); return "never"; }
    this.live = { client, closed };
    let connected = false;
    try {
      const init = await client.initialize({ clientId: this.clientId, protocolVersions: PROTOCOL_VERSIONS, initialSubscriptions: [ROOT] });
      if (!(PROTOCOL_VERSIONS as readonly string[]).includes(init.protocolVersion)) {
        this.setState({ state: "refused", server_version: init.protocolVersion || null });
        throw new AgentHostError("refused");
      }
      this.store.reset();
      this.fromSeq.clear();
      for (const snapshot of init.snapshots ?? []) this.applySnapshot(snapshot);
      if (needModels && !this.store.root.agents.some((agent) => agent.models.length > 0)) {
        this.store.reset();
        this.live = null;
        await client.shutdown();
        await closed;
        return "no_models";
      }
      this.sessionList = await this.listAll(client);
      this.setState(this.connectedState(init.protocolVersion));
      connected = true;
      this.changed({ kind: "chats" });
      void this.recheckWhileEmpty(entry, client);
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
        return "never";
      }
    }
    await closed;
    this.live = null;
    if (!this.stopped) this.setState({ state: "starting" });
    return "closed";
  }

  /**
   * While `client` is the live one and its host lists no models: every RECHECK_MS, when another live
   * host lists models, closes `client`, so run() connects again and keeps that one.
   */
  private async recheckWhileEmpty(entry: HostEntry, client: AhpClient): Promise<void> {
    const current = () => !this.stopped && this.live?.client === client;
    while (current()) {
      await this.pause(RECHECK_MS);
      if (!current() || this.current.state !== "connected" || this.current.signed_in) continue;
      for (const other of liveStandalones(this.dirs, this.alive)) {
        if (other.pid === entry.pid && other.port === entry.port) continue;
        if (!current()) return;
        if (await this.listsModels(other)) { await client.shutdown(); return; }
      }
    }
  }

  /** Whether the host at `entry` lists models now; false when it can't be reached. */
  private async listsModels(entry: HostEntry): Promise<boolean> {
    let transport: WebSocketTransport;
    try {
      transport = await WebSocketTransport.connect(`ws://${entry.host}:${entry.port}/?tkn=${encodeURIComponent(entry.token)}`);
    } catch {
      return false;
    }
    const probe = new AhpClient(transport);
    probe.connect();
    try {
      const init = await probe.initialize({ clientId: this.clientId, protocolVersions: PROTOCOL_VERSIONS, initialSubscriptions: [ROOT] });
      return (init.snapshots ?? []).some((snapshot) => {
        const state = snapshot.state as { agents?: Array<{ models?: unknown[] }> } | undefined;
        return snapshot.resource === ROOT && (state?.agents ?? []).some((agent) => (agent.models?.length ?? 0) > 0);
      });
    } catch {
      return false;
    } finally {
      await probe.shutdown();
    }
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

  /**
   * After a reconnect: every watched session and its chat again. Nothing is dispatched but the
   * active-client mark. A resubscribe that fails drops its watch (its holders' releases then do
   * nothing), so the next watch() of that session subscribes again instead of reading an empty
   * mirror for as long as a phone keeps renewing its lease; the push makes the phone read now.
   */
  private async resubscribe(): Promise<void> {
    for (const [session, watch] of [...this.watches]) {
      watch.ready = this.subscribeWatch(session, watch);
      try {
        await watch.ready;
      } catch {
        // the session may be gone on this host, or the subscribe timed out
        if (this.watches.get(session) === watch) this.drop(session, watch);
      }
      this.changed({ kind: "chat", session });
    }
    for (const [uri, watch] of [...this.chatWatches]) {
      const live = this.live;
      if (!live) return;
      watch.ready = this.subscribeWorker(live.client, uri, watch);
      try {
        await watch.ready;
      } catch {
        if (this.chatWatches.get(uri) === watch) this.dropChat(uri);
      }
      this.changed({ kind: "chat", session: watch.session });
    }
  }

  /** Whether `session` has a watch now: false once its lease expired or a resubscribe failed. */
  watching(session: string): boolean { return this.watches.has(session); }

  private async subscribeWatch(session: string, watch: Watch): Promise<void> {
    const live = this.live;
    if (!live) throw new AgentHostError("not_connected");
    const owner = this.ownerOf(session);
    if (session.startsWith("ahp-chat:") && !owner) throw new AgentHostError("rpc_error");
    watch.session = owner ?? session;
    const state = (await this.subscribe(live.client, watch.session, "session")).state as SessionState;
    live.client.dispatch(watch.session, { type: "session/activeClientSet", activeClient: { clientId: this.clientId, displayName: "herdr-web", tools: [] } } as StateAction);
    watch.chat = owner ? session : state.defaultChat ?? null;
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
    if (!snapshot) throw new AgentHostError("rpc_error");
    if (kind === "session") this.store.applySessionSnapshot(snapshot);
    else this.store.applyChatSnapshot(snapshot);
    this.fromSeq.set(channel, snapshot.fromSeq);
    for (const envelope of held) this.applyAction(envelope);
    return snapshot;
  }

  private drop(session: string, watch: Watch): void {
    this.watches.delete(session);
    const channels = watch.chat ? [watch.session, watch.chat] : [watch.session];
    // a session's channel stays while another of its chats is watched
    const held = new Set([...this.watches.values()].flatMap((other) => [other.session, other.chat]));
    for (const channel of channels.filter((each) => !held.has(each))) {
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

  /** The session whose watch covers `channel` (its own channel or its chat's, or a worker chat it started). */
  private watcherOf(channel: string): string | null { return this.watchersOf(channel)[0] ?? null; }

  /** Every watch `channel` is part of: a session's channel is its forks' too. */
  private watchersOf(channel: string): string[] {
    const found = new Set<string>();
    if (this.watches.has(channel)) found.add(channel);
    for (const [key, watch] of this.watches) if (watch.chat === channel || watch.session === channel) found.add(key);
    for (const [uri, watch] of this.chatWatches) if (uri === channel || watch.inner === channel) found.add(watch.session);
    return [...found];
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
          for (const session of this.watchersOf(channel)) this.changed({ kind: "chat", session });
        } else if (event.type === "sessionAdded") {
          const added = event.params.summary;
          this.sessionList = [...this.sessionList.filter((s) => s.resource !== added.resource), added];
          this.changed({ kind: "chats" });
        } else if (event.type === "sessionRemoved") {
          this.sessionList = this.sessionList.filter((s) => s.resource !== event.params.session);
          this.changed({ kind: "chats" });
        } else if (event.type === "sessionSummaryChanged") {
          const { session, changes } = event.params;
          this.sessionList = this.sessionList.map((s) => (s.resource === session ? { ...s, ...changes } : s));
          this.changed({ kind: "chats" });
        }
      } catch (error) {
        // a reducer threw: one event, not the connection. Its name only: a message can carry the
        // host's URL
        console.warn(`agent-host: an agent host ${event.type} event on a ${channel === ROOT ? "root" : this.watcherOf(channel) ? "watched" : "other"} channel failed (${errorName(error)})`);
      }
    }
  }
}
