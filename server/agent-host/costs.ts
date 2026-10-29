/**
 * What a chat spent, from its Copilot log: every model call leaves a `session.usage_record` in
 * `$COPILOT_HOME/session-state/<uuid>/events.jsonl` (the main agent's without an `agentId`, a
 * sub-agent's with one), its `inputTokens` the whole prompt, cache reads and writes included.
 * The index sums them per file by byte offset: a request reads only what was written since the
 * last one, a line still being written is left for the next read, and a call seen twice (same
 * `apiCallId`) counts once. Tokens only: the client prices them.
 *
 * Copilot logs `cacheWriteTokens: 0` on every BYOK (OmniRoute) call, so a write is inferred: what
 * the next call of the same chain (the main agent or one sub-agent, on one model) reads from the
 * cache beyond what this one read, `max(0, next.cacheRead − this.cacheRead)`; a drop (a compaction,
 * a new context) is 0, a write the log does give is taken as is. Measured on 2026-10-28's
 * `cc/claude-opus*` calls (ZAC-260): 4194 of 4283 matched OmniRoute's call_logs by (tokens_in,
 * tokens_out), cache reads equal to the token (567,265,821 both); inferred writes 8.97M against
 * OmniRoute's 9.32M (96%), cold-cache rewrites 21 against 22. A chain's newest call gets its write
 * when its next call is read, in this read or a later one.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HostChatCost, HostCostCall, HostCostModel, HostCostsAnswer } from "../../shared/host-chats.ts";
import { copilotTranscript, fromSubagent } from "../copilot.ts";
import { sdkSessionOf } from "./todos.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** the first scan reads logs written in the last 30 days */
const SCAN_DAYS = 30;
/** new logs read per `all()`, so a request never waits on the whole store */
const FILES_PER_SCAN = 50;
/**
 * bytes read per request (`all()`, `costOf()`): a marathon's log (400 MB seen) is read over several
 * requests, a floor (`partial`) meanwhile, rather than blocking the bridge's terminals for seconds
 */
const BYTES_PER_SCAN = 128 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const USAGE_MARK = '"session.usage_record"';
const MESSAGE_MARK = '"user.message"';

type Row = Record<string, unknown>;
type Tokens = Omit<HostCostModel, "model" | "calls">;
/** one message's calls: the main agent's and its sub-agents', apart */
interface Message { main: HostCostCall | null; sub: HostCostCall | null }
/** a chain's last call, its write still to infer from the chain's next read: the sums it went into */
interface Pending {
  cacheRead: number; input: number; main: boolean;
  model: HostCostModel; day: HostCostModel | null; call: HostCostCall;
}

interface LogState {
  path: string; offset: number; size: number; mtime: number;
  seenIds: Set<string>;
  sums: {
    models: Map<string, HostCostModel>; days: Map<string, Map<string, HostCostModel>>;
    lastCallAt: string | null; context: number | null; peak: number; rewrites: number;
    messages: Message[];
  };
  /** per chain (agent and model): its last call whose write the log gave as 0 */
  chains: Map<string, Pending | null>;
  /** stopped on the scan's byte budget with lines left to read */
  partial: boolean;
}

const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const zero = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

function add(into: Tokens, tokens: Tokens): void {
  into.input += tokens.input; into.cacheRead += tokens.cacheRead; into.cacheWrite += tokens.cacheWrite; into.output += tokens.output;
}

function addModel(models: Map<string, HostCostModel>, model: string, tokens: Tokens): HostCostModel {
  let sum = models.get(model);
  if (!sum) { sum = { model, ...zero(), calls: 0 }; models.set(model, sum); }
  add(sum, tokens);
  sum.calls += 1;
  return sum;
}

/** a cold cache's rewrite: the call wrote more than half its prompt */
const rewrote = (write: number, input: number): boolean => write > 0.5 * input;

const fresh = (path: string): LogState => ({
  path, offset: 0, size: 0, mtime: 0, seenIds: new Set(), partial: false, chains: new Map(),
  sums: { models: new Map(), days: new Map(), lastCallAt: null, context: null, peak: 0, rewrites: 0, messages: [] },
});

/** One complete line of the log into the sums. */
function take(state: LogState, line: string): void {
  if (!line.includes(USAGE_MARK) && !line.includes(MESSAGE_MARK)) return;
  let entry: Row;
  try { entry = record(JSON.parse(line)); } catch { return; }
  const sums = state.sums;
  const main = !fromSubagent(entry);
  if (entry.type === "user.message") {
    // a sub-agent's prompt is part of the message that started it
    if (main) sums.messages.push({ main: null, sub: null });
    return;
  }
  if (entry.type !== "session.usage_record") return;
  const usage = record(record(entry.data).usage);
  const id = typeof usage.apiCallId === "string" && usage.apiCallId ? usage.apiCallId : typeof entry.id === "string" ? entry.id : null;
  if (id !== null) {
    if (state.seenIds.has(id)) return;
    state.seenIds.add(id);
  }
  const at = typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  const model = typeof usage.model === "string" && usage.model ? usage.model : "unknown";
  const tokens: Tokens = { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadTokens), cacheWrite: count(usage.cacheWriteTokens), output: count(usage.outputTokens) };
  // the previous call of this chain wrote what this one reads beyond it
  const chain = `${main ? "" : String(entry.agentId)}\n${model}`;
  const before = state.chains.get(chain);
  if (before) {
    const write = Math.max(0, tokens.cacheRead - before.cacheRead);
    if (write > 0) {
      before.model.cacheWrite += write;
      if (before.day) before.day.cacheWrite += write;
      before.call.cacheWrite += write;
      if (before.main && rewrote(write, before.input)) sums.rewrites += 1;
    }
  }
  const modelSum = addModel(sums.models, model, tokens);
  let daySum: HostCostModel | null = null;
  if (at !== null) {
    const day = new Date(at).toISOString().slice(0, 10);
    let models = sums.days.get(day);
    if (!models) { models = new Map(); sums.days.set(day, models); }
    daySum = addModel(models, model, tokens);
  }
  if (main) {
    // the cache's age, the context and a cold cache's rewrite are the main agent's: a sub-agent's first call always writes
    if (at !== null) sums.lastCallAt = at;
    sums.context = tokens.input;
    sums.peak = Math.max(sums.peak, tokens.input);
    if (rewrote(tokens.cacheWrite, tokens.input)) sums.rewrites += 1;
  }
  if (sums.messages.length === 0) sums.messages.push({ main: null, sub: null });
  const message = sums.messages[sums.messages.length - 1]!;
  const side = main ? "main" : "sub";
  const call = message[side] ?? (message[side] = { at: at ?? "", ...zero(), main, context: 0, lastCacheRead: 0 });
  if (call.at === "" && at !== null) call.at = at;
  add(call, tokens);
  // the sums would read a 10-call tool loop at 200K as 2M: the last call's own prompt is the context
  call.context = tokens.input;
  call.lastCacheRead = tokens.cacheRead;
  // a write the log gives is used as is, never added to an inferred one
  state.chains.set(chain, tokens.cacheWrite > 0 ? null : { cacheRead: tokens.cacheRead, input: tokens.input, main, model: modelSum, day: daySum, call });
}

/**
 * Reads the log from its offset to its last complete line, at most `budget` bytes (a line longer
 * than that is still read whole). Returns the bytes read. A log that shrank was replaced: read anew.
 */
function readLog(state: LogState, budget: number): number {
  let stat;
  try { stat = statSync(state.path); } catch { return 0; }
  if (stat.size < state.offset) Object.assign(state, fresh(state.path));
  state.size = stat.size; state.mtime = stat.mtimeMs;
  if (state.offset >= stat.size) { state.partial = false; return 0; }
  let fd: number;
  try { fd = openSync(state.path, "r"); } catch { return 0; }
  let read = 0;
  try {
    // the budget caps the chunk too, else a log under 8 MB is read whole whatever the budget
    let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, stat.size - state.offset, budget)));
    while (state.offset < stat.size && read < budget) {
      const want = Math.min(buffer.length, stat.size - state.offset);
      const got = readSync(fd, buffer, 0, want, state.offset);
      if (got <= 0) break;
      const last = buffer.lastIndexOf(10, got - 1);
      if (last < 0) {
        // the log's torn tail, or one line longer than the buffer: read it whole
        if (state.offset + got >= stat.size) break;
        buffer = Buffer.allocUnsafe(buffer.length * 2);
        continue;
      }
      for (const line of buffer.toString("utf8", 0, last).split("\n")) take(state, line);
      state.offset += last + 1;
      read += last + 1;
    }
  } finally { closeSync(fd); }
  // what is left after the last newline is a line still being written, not a part unread
  state.partial = stat.size - state.offset > 0 && read >= budget;
  return read;
}

const models = (map: Map<string, HostCostModel>): HostCostModel[] => [...map.values()].map((sum) => ({ ...sum }));

function answer(session: string, state: LogState): HostChatCost {
  const sums = state.sums;
  return {
    session, models: models(sums.models), lastCallAt: sums.lastCallAt, context: sums.context, peak: sums.peak, rewrites: sums.rewrites,
    days: Object.fromEntries([...sums.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, map]) => [day, models(map)])),
    partial: state.partial,
  };
}

export class CostIndex {
  /** per SDK session (its folder's uuid): the log's state */
  private readonly logs = new Map<string, LogState>();
  /** logs found but not read yet, newest first; null before the first scan listed the store */
  private queue: string[] | null = null;

  constructor(
    private readonly home: string, private readonly agentDirs: readonly string[], private readonly now: () => number = Date.now,
    /** bytes a request reads (BYTES_PER_SCAN), smaller in tests */
    private readonly bytesPerRequest = BYTES_PER_SCAN,
  ) {}

  /** The SDK session a chat id names: a CLI chat's own folder, a VS Code chat's through its store. */
  private sdkOf(session: string): string | null {
    const at = session.indexOf(":/");
    if (at < 0) return null;
    const uuid = session.slice(at + 2);
    if (!UUID.test(uuid)) return null;
    if (this.logs.has(uuid) || this.pathOf(uuid) !== null) return uuid;
    const sdk = sdkSessionOf(uuid, this.agentDirs);
    return sdk !== null && this.pathOf(sdk) !== null ? sdk : null;
  }

  private pathOf(uuid: string): string | null {
    const found = copilotTranscript(uuid, this.home);
    return found !== null && "path" in found ? found.path : null;
  }

  /** The log's state, read up to now or up to `budget`; null when the session has no log. */
  private read(uuid: string, budget: number): LogState | null {
    let state = this.logs.get(uuid);
    if (!state) {
      const path = this.pathOf(uuid);
      if (path === null) return null;
      state = fresh(path);
      this.logs.set(uuid, state);
    }
    readLog(state, budget);
    return state;
  }

  costOf(session: string): HostChatCost | null {
    const uuid = this.sdkOf(session);
    const state = uuid === null ? null : this.read(uuid, this.bytesPerRequest);
    return state === null ? null : answer(session, state);
  }

  /**
   * Per message, the main agent's calls and its sub-agents', in the log's order: as far as `costOf`
   * read (the route asks both, the chart matching the sums), a log not opened yet up to the budget.
   */
  calls(session: string): HostCostCall[] {
    const uuid = this.sdkOf(session);
    const state = uuid === null ? null : this.logs.get(uuid) ?? this.read(uuid, this.bytesPerRequest);
    if (state === null) return [];
    return state.sums.messages.flatMap((message) => [message.main, message.sub].filter((call) => call !== null).map((call) => ({ ...call })));
  }

  /**
   * Every log read so far, as `copilotcli:/<uuid>`. Each call reads what the known logs gained,
   * then up to 50 logs not read yet (written in the last 30 days, newest first); `complete` once
   * none is left and none stopped part way.
   */
  all(): HostCostsAnswer {
    let budget = this.bytesPerRequest;
    for (const state of this.logs.values()) {
      if (budget <= 0) { state.partial = state.partial || this.stale(state); continue; }
      budget -= readLog(state, budget);
    }
    const queue = this.list();
    let started = 0;
    while (queue.length > 0 && started < FILES_PER_SCAN && budget > 0) {
      const uuid = queue.shift()!;
      started += 1;
      // read in the meantime by costOf
      if (this.logs.has(uuid)) continue;
      const state = this.read(uuid, budget);
      if (state) budget -= state.offset;
    }
    const chats = [...this.logs].filter(([, state]) => state.sums.models.size > 0).map(([uuid, state]) => answer(`copilotcli:/${uuid}`, state));
    const complete = queue.length === 0 && [...this.logs.values()].every((state) => !state.partial);
    return { chats, complete };
  }

  /** a log that grew past the last read */
  private stale(state: LogState): boolean {
    try { return statSync(state.path).size > state.offset; } catch { return false; }
  }

  /** Queues the logs written in the last 30 days that are not known yet, newest first; the queue. */
  private list(): string[] {
    const store = join(this.home, "session-state");
    const since = this.now() - SCAN_DAYS * 86_400_000;
    let names: string[];
    try { names = readdirSync(store); } catch { names = []; }
    const queued = new Set(this.queue ?? []);
    const found: { uuid: string; mtime: number }[] = [];
    for (const name of names) {
      if (!UUID.test(name) || this.logs.has(name) || queued.has(name)) continue;
      let mtime: number;
      try { mtime = statSync(join(store, name, "events.jsonl")).mtimeMs; } catch { continue; }
      if (mtime >= since) found.push({ uuid: name, mtime });
    }
    found.sort((a, b) => b.mtime - a.mtime);
    // new logs go ahead of older ones still waiting
    this.queue = [...found.map((each) => each.uuid), ...(this.queue ?? [])];
    return this.queue;
  }
}
