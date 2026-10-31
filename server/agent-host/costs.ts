/**
 * What a chat spent, from its Copilot log: every model call leaves a `session.usage_record` in
 * `$COPILOT_HOME/session-state/<uuid>/events.jsonl` (the main agent's without an `agentId`, a
 * sub-agent's with one), its `inputTokens` the prompt read from the cache plus the part sent
 * without it; what the call stores in the cache is not inside it. Checked record by record against
 * OmniRoute's call_logs (ZAC-260): read 99,607, OmniRoute's cache creation 2,454, Copilot's input
 * 99,947 (not 102,061), and the next call read 102,061 = 99,607 + 2,454.
 * The index sums them per file by byte offset: a request reads only what was written since the
 * last one, a line still being written is left for the next read, and a call seen twice (same
 * `apiCallId`) counts once. Tokens only: the client prices them.
 *
 * Copilot logs `cacheWriteTokens: 0` on every BYOK (OmniRoute) call, so a write is inferred: what
 * the next call of the same chain (the main agent or one sub-agent, on one model) reads from the
 * cache beyond what this one read, `max(0, next.cacheRead − this.cacheRead)`; a drop (a compaction,
 * a new context) is 0, a write the log does give is taken as is. A side call (`SIDE_CALL`) is
 * left out of the chain. A main-agent call whose write is over half of what the cache holds after
 * it (`rewrote`) is a cold restart: the cache had expired, the whole conversation is stored again;
 * its write is also summed as `coldWrite`. Unless it is the log's first main-agent call of its own
 * (a fork's copied history is not one): that is a first write, summed as `firstWrite` and counted in
 * `firstWrites`, not a restart (ZAC-262: a new chat's first call read 0 and wrote 73,961). Measured with this rule on 2026-10-28's `cc/claude-opus*` calls (ZAC-260):
 * cache reads equal to OmniRoute's (569,791,156 in the Copilot log), inferred writes 9,195,819
 * against OmniRoute's 9,320,792 (98.7%); rewrites counted by the index 9 (main agent; 29 with
 * sub-agents, which is what OmniRoute's 22 compares to, as it counts every call). A chain's newest
 * call gets its write when its next call is read, in this read or a later one.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HostChatCost, HostContextUsage, HostCostCall, HostCostModel, HostCostsAnswer } from "../../shared/host-chats.ts";
import { copilotTranscript, fromSubagent } from "../copilot.ts";
import { peerChatSdkOf, sdkSessionOf } from "./todos.ts";

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
/**
 * bytes a server-driven read takes (the cold-cache alert's poll, ZAC-260 review): nobody waits on
 * it, so it blocks the event loop for one 16 MB read at most, and the poller takes several in a row
 * with a yield between them (POLL_READS_PER_TICK) rather than one 128 MB one. On the owner's Mac
 * (1.5 GB in 286 logs) the first scan was ~12 blocking 128 MB reads.
 */
export const POLL_BYTES_PER_SCAN = 16 * 1024 * 1024;
/** reads a poll tick takes at most, while the index is not complete: 8 × 16 MB, the old pace */
export const POLL_READS_PER_TICK = 8;
const CHUNK = 8 * 1024 * 1024;
/**
 * A call is a side call (a title, a summary: ~500 tokens) when both its prompt and its cache read are
 * under this share of its chain's last call's. It keeps its own tokens and logged write, gets no
 * inferred write, counts no rewrite and does not advance the chain: the next call's read is set
 * against the last call that is not one. Measured on 2026-10-28's `cc/claude-opus*` calls (ZAC-260):
 * the raw delta gave 12.25M overall, 5.43M of it credited to 40 side calls (19 main, 18 sub-agent,
 * 3 user; none in OmniRoute's opus rows), each given the next main call's write. Leaving them out
 * at 10%: 9,195,819 against OmniRoute's 9,320,792 (98.7%). Rejected: a 25% threshold (86.7%),
 * capping a write at the call's prompt (83%).
 */
const SIDE_CALL = 0.1;
const USAGE_MARK = '"session.usage_record"';
const START_SESSION_MARK = '"session.start"';
const MESSAGE_MARK = '"user.message"';
/** the events that carry the CLI's own context split (systemTokens etc.): a compaction's start and end, a shutdown */
const SPLIT_MARKS = ['"session.compaction_start"', '"session.compaction_complete"', '"session.shutdown"'];
/**
 * The owner's answers in an agent-driven chat come back as these tools' results, not as user
 * messages (ZAC-260: 2,640 `ask_user` and 386 `askUser` calls in the Mac's logs, d97ba3a6's 514
 * against its 207 user messages): a main-agent answer starts a reply of its own in the chart.
 */
const ASK_TOOLS = new Set(["ask_user", "askUser"]);
const ASK_MARKS = ['"toolName":"ask_user"', '"toolName":"askUser"'];
const START_MARK = '"tool.execution_start"';
const COMPLETE_MARK = '"tool.execution_complete"';
/** the owner's hand-off to a new chat (ZAC-262's weekly digest): the command alone or followed by its text */
const HANDOFF = /^\/(?:harness:)?handoff(?:\s|$)/;
const CALL_ID = /"toolCallId":"([^"]+)"/;

type Row = Record<string, unknown>;
type Tokens = { input: number; cacheRead: number; cacheWrite: number; coldWrite: number; firstWrite: number; output: number };
type Model = HostCostModel & Tokens;
type Call = HostCostCall & Tokens & { calls: number; restarts: number };
/** an hour of a reply's calls (`HostCostCall.hours`), the main agent's and its sub-agents' apart */
interface Slice { main: Call | null; sub: Call | null }
/**
 * one message's calls: the main agent's and its sub-agents', apart; and the same sums per 60-minute
 * window from the reply's first call (`start`, its last `end`), for the chart's hourly bars (ZAC-262)
 */
interface Message { main: Call | null; sub: Call | null; start: number | null; end: number | null; slices: Map<number, Slice> }
/** a reply that ran longer than this is drawn one bar per hour (owner, 2026-10-31) */
const HOUR = 3_600_000;
const newMessage = (): Message => ({ main: null, sub: null, start: null, end: null, slices: new Map() });
/** a chain's last call that is not a side call, and the sums its inferred write goes into */
interface Last {
  cacheRead: number; input: number; main: boolean;
  model: Model; day: Model | null; call: Call;
  /** its hour of the reply's (Message.slices): an inferred write lands in it too */
  slice: Call | null;
  /** the log gave its write: none is inferred */
  logged: boolean;
  /** its UTC day, for `dayCounts`; and whether it was the log's first main-agent call of its own (its write a first write) */
  dayKey: string | null; first: boolean;
}
interface DayCounts { restarts: number; firstWrites: number; handoffs: number }

interface LogState {
  path: string; offset: number; size: number; mtime: number;
  seenIds: Set<string>;
  sums: {
    models: Map<string, Model>; days: Map<string, Map<string, Model>>;
    lastCallAt: string | null; context: number | null; peak: number; rewrites: number; firstWrites: number;
    /** per UTC day: the main agent's cold restarts, first writes and hand-offs (the weekly digest) */
    dayCounts: Map<string, DayCounts>;
    /** the main agent's last call's model: the cache the next call reads is that model's */
    lastModel: string | null;
    messages: Message[];
    /** the main agent's system prompt as the CLI last counted it (a compaction or a shutdown), its tool definitions and prompt budget as its last call gave them */
    system: number | null; tools: number | null; limit: number | null;
  };
  /** per chain (agent and model): its last call that is not a side call */
  chains: Map<string, Last>;
  /** `ask_user` / `askUser` calls not answered yet, by toolCallId */
  asks: Set<string>;
  /** per sub-agent, the reply it started in: a background one's calls land after later replies began */
  agents: Map<string, number>;
  /** the main agent's calls of its own seen so far (not inherited, not side calls): none yet makes the next one's write a first write */
  ownMainCalls: number;
  /** stopped on the scan's byte budget with lines left to read */
  partial: boolean;
  /**
   * when the session was created (its first `session.start`): a fork's log (VS Code's Fork
   * Conversation) copies its source's events up to the fork point verbatim, with their own earlier
   * timestamps, after it (see `inherited`)
   */
  startedAt: number | null;
}

const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const zero = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, coldWrite: 0, firstWrite: 0, output: 0 });
const dayOf = (at: string): string => new Date(at).toISOString().slice(0, 10);

function countDay(sums: LogState["sums"], day: string | null, key: keyof DayCounts): void {
  if (day === null) return;
  let counts = sums.dayCounts.get(day);
  if (!counts) { counts = { restarts: 0, firstWrites: 0, handoffs: 0 }; sums.dayCounts.set(day, counts); }
  counts[key] += 1;
}

function add(into: Tokens, tokens: Tokens): void {
  into.input += tokens.input; into.cacheRead += tokens.cacheRead; into.cacheWrite += tokens.cacheWrite; into.coldWrite += tokens.coldWrite; into.firstWrite += tokens.firstWrite; into.output += tokens.output;
}

function addModel(models: Map<string, Model>, model: string, tokens: Tokens): Model {
  let sum = models.get(model);
  if (!sum) { sum = { model, ...zero(), calls: 0 }; models.set(model, sum); }
  add(sum, tokens);
  sum.calls += 1;
  return sum;
}

/**
 * A cold restart: the call wrote more than half of what the cache holds after it (its own read plus
 * its write), its read ~0 as the cache had expired. Not "half its prompt": the prompt does not hold
 * the write (see the header), so a warm call storing a long tool result would have passed for one.
 */
const rewrote = (write: number, cacheRead: number): boolean => write > 0.5 * (cacheRead + write);

const fresh = (path: string): LogState => ({
  path, offset: 0, size: 0, mtime: 0, seenIds: new Set(), ownMainCalls: 0, partial: false, startedAt: null, chains: new Map(), asks: new Set(), agents: new Map(),
  sums: { models: new Map(), days: new Map(), lastCallAt: null, context: null, peak: 0, rewrites: 0, firstWrites: 0, dayCounts: new Map(), lastModel: null, messages: [], system: null, tools: null, limit: null },
});

/** a line worth parsing: a call, a user message, an ask tool's start, or an answer to one being waited for */
function wanted(state: LogState, line: string): boolean {
  if (line.includes(USAGE_MARK) || line.includes(MESSAGE_MARK) || SPLIT_MARKS.some((mark) => line.includes(mark))) return true;
  if (state.startedAt === null && line.includes(START_SESSION_MARK)) return true;
  if (line.includes(START_MARK)) return ASK_MARKS.some((mark) => line.includes(mark));
  if (state.asks.size === 0 || !line.includes(COMPLETE_MARK)) return false;
  const id = CALL_ID.exec(line)?.[1];
  return id !== undefined && state.asks.has(id);
}

/**
 * A fork's copy of its source's event (ZAC-260): dated before the session's own start. Live on the
 * Mac, 2026-10-30: of 275 logs exactly the two forks hold such records (680a74b5: 429 of 762,
 * b96e530f: 29 of 36), each with the same event id and apiCallId as in the source's log, which
 * already counts them; peer chats share none. Counting them made each fork cost its source's
 * history again, and the PC totals count it twice.
 */
function isInherited(state: LogState, entry: Row): boolean {
  if (state.startedAt === null || typeof entry.timestamp !== "string") return false;
  const at = Date.parse(entry.timestamp);
  return Number.isFinite(at) && at < state.startedAt;
}

/** One complete line of the log into the sums. */
function take(state: LogState, line: string): void {
  if (!wanted(state, line)) return;
  let entry: Row;
  try { entry = record(JSON.parse(line)); } catch { return; }
  const sums = state.sums;
  const main = !fromSubagent(entry);
  if (entry.type === "session.start") {
    if (state.startedAt === null) {
      const data = record(entry.data);
      const at = Date.parse(typeof data.startTime === "string" ? data.startTime : typeof entry.timestamp === "string" ? entry.timestamp : "");
      if (Number.isFinite(at)) state.startedAt = at;
    }
    return;
  }
  const inherited = isInherited(state, entry);
  if (inherited && entry.type !== "session.usage_record") return;
  if (entry.type === "session.compaction_start" || entry.type === "session.compaction_complete" || entry.type === "session.shutdown") {
    const system = count(record(entry.data).systemTokens);
    if (main && system > 0) sums.system = system;
    return;
  }
  if (entry.type === "user.message") {
    // a sub-agent's prompt is part of the message that started it
    if (!main) return;
    sums.messages.push(newMessage());
    const content = record(entry.data).content;
    if (typeof content === "string" && HANDOFF.test(content.trim()) && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))) countDay(sums, dayOf(entry.timestamp), "handoffs");
    return;
  }
  if (entry.type === "tool.execution_start" || entry.type === "tool.execution_complete") {
    const data = record(entry.data);
    const id = typeof data.toolCallId === "string" ? data.toolCallId : null;
    if (id === null) return;
    if (entry.type === "tool.execution_start") { if (typeof data.toolName === "string" && ASK_TOOLS.has(data.toolName)) state.asks.add(id); return; }
    if (!state.asks.delete(id)) return;
    // the owner's answer: a reply of its own, as a user message is
    if (main) sums.messages.push(newMessage());
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
  const tokens: Tokens = { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadTokens), cacheWrite: count(usage.cacheWriteTokens), coldWrite: 0, firstWrite: 0, output: count(usage.outputTokens) };
  // the previous call of this chain wrote what this one reads beyond it
  const chain = `${main ? "" : String(entry.agentId)}\n${model}`;
  const before = state.chains.get(chain);
  const sideCall = before !== undefined && tokens.input < SIDE_CALL * before.input && tokens.cacheRead < SIDE_CALL * before.cacheRead;
  if (inherited) {
    // the source chat's call, counted in its own log: it only tells the fork's first call what the cache held
    if (!sideCall) state.chains.set(chain, { cacheRead: tokens.cacheRead, input: tokens.input, main, model: { model, ...zero(), calls: 0 }, day: null, call: { at: "", ...zero(), main, context: 0, lastCacheRead: 0, calls: 0, restarts: 0 }, slice: null, logged: tokens.cacheWrite > 0, dayKey: null, first: false });
    return;
  }
  if (before && !before.logged && !sideCall) {
    const write = Math.max(0, tokens.cacheRead - before.cacheRead);
    if (write > 0) {
      const whole = before.main && rewrote(write, before.cacheRead);
      const cold = whole && !before.first ? write : 0;
      const first = whole && before.first ? write : 0;
      for (const sum of [before.model, before.day, before.call, before.slice]) {
        if (!sum) continue;
        sum.cacheWrite += write;
        sum.coldWrite += cold;
        sum.firstWrite += first;
      }
      if (cold > 0) { sums.rewrites += 1; before.call.restarts += 1; if (before.slice) before.slice.restarts += 1; countDay(sums, before.dayKey, "restarts"); }
      if (first > 0) { sums.firstWrites += 1; countDay(sums, before.dayKey, "firstWrites"); }
    }
  }
  // the cache's age, the context and a cold restart are the main agent's: a sub-agent's first call always writes
  const dayKey = at === null ? null : dayOf(at);
  const first = main && !sideCall && state.ownMainCalls === 0;
  if (main && !sideCall) state.ownMainCalls += 1;
  if (main && !sideCall && rewrote(tokens.cacheWrite, tokens.cacheRead)) {
    if (first) { tokens.firstWrite = tokens.cacheWrite; sums.firstWrites += 1; countDay(sums, dayKey, "firstWrites"); }
    else { tokens.coldWrite = tokens.cacheWrite; sums.rewrites += 1; countDay(sums, dayKey, "restarts"); }
  }
  const modelSum = addModel(sums.models, model, tokens);
  let daySum: Model | null = null;
  if (dayKey !== null) {
    const day = dayKey;
    let models = sums.days.get(day);
    if (!models) { models = new Map(); sums.days.set(day, models); }
    daySum = addModel(models, model, tokens);
  }
  if (main) {
    // a prompt cache is one model's (phase 1b): each model's own last call, and which one was last
    if (at !== null) { sums.lastCallAt = at; modelSum.lastCallAt = at; }
    sums.lastModel = model;
    sums.context = tokens.input;
    sums.peak = Math.max(sums.peak, tokens.input);
    if (!sideCall) {
      if (count(usage.toolTokenCount) > 0) sums.tools = count(usage.toolTokenCount);
      if (count(usage.maxPromptTokens) > 0) sums.limit = count(usage.maxPromptTokens);
    }
  }
  if (sums.messages.length === 0) sums.messages.push(newMessage());
  let reply = sums.messages.length - 1;
  if (!main) {
    const agent = String(entry.agentId);
    const started = state.agents.get(agent);
    if (started === undefined) state.agents.set(agent, reply);
    else reply = started;
  }
  const held = sums.messages[reply]!;
  const side = main ? "main" : "sub";
  const call = held[side] ?? (held[side] = { at: at ?? "", ...zero(), main, context: 0, lastCacheRead: 0, calls: 0, restarts: 0 });
  if (call.at === "" && at !== null) call.at = at;
  tally(call, tokens);
  // its hour of the reply: 60-minute windows from the reply's first call (a call without a time, or before it, in the first)
  const time = at === null ? null : Date.parse(at);
  if (time !== null) {
    // the reply's first call is its main agent's (a sub-agent starts from one); the windows never move once set
    if (held.start === null) held.start = time;
    held.end = Math.max(held.end ?? time, time);
  }
  const hour = time === null || held.start === null ? 0 : Math.max(0, Math.floor((time - held.start) / HOUR));
  let window = held.slices.get(hour);
  if (!window) { window = { main: null, sub: null }; held.slices.set(hour, window); }
  const slice = window[side] ?? (window[side] = { at: new Date((held.start ?? time ?? 0) + hour * HOUR).toISOString(), ...zero(), main, context: 0, lastCacheRead: 0, calls: 0, restarts: 0 });
  tally(slice, tokens);
  // a write the log gives is used as is, never added to an inferred one
  if (!sideCall) state.chains.set(chain, { cacheRead: tokens.cacheRead, input: tokens.input, main, model: modelSum, day: daySum, call, slice, logged: tokens.cacheWrite > 0, dayKey, first });
}

/** One call into a reply's sums, or an hour's of them. */
function tally(call: Call, tokens: Tokens): void {
  add(call, tokens);
  // the chart's card: "Reply 11 · … · 37 calls", and a day's "Cold restarts (2)"
  call.calls += 1;
  if (tokens.coldWrite > 0) call.restarts += 1;
  // the sums would read a 10-call tool loop at 200K as 2M: the last call's own prompt is the context
  call.context = tokens.input;
  call.lastCacheRead = tokens.cacheRead;
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

const models = (map: Map<string, Model>): HostCostModel[] => [...map.values()].map((sum) => ({ ...sum }));

/**
 * The context's split as the CLI's own log gives it (ZAC-260 phase 1b): its last prompt, of the
 * prompt budget its last call had (a fallback: the route sets the model's window, withModelWindow), the tool definitions that call sent (`toolTokenCount`) and the
 * system prompt the CLI last counted (a compaction or a shutdown: it barely moves within a
 * session, 25,443 then 25,724 on the owner's chat), the rest messages. The host reports a
 * breakdown only when a turn ends (`contextAttribution`), and a chat driven by ask_user is one turn
 * for hours: live on the Mac, 2026-10-30, "resume zac-241-chineur" read `context: null` while its log
 * had all of these. Null without a prompt or a budget; a part not known is left out, never guessed.
 */
function splitOf(sums: LogState["sums"]): HostContextUsage | null {
  if (sums.context === null || sums.context <= 0 || sums.limit === null) return null;
  const usage: HostContextUsage = { currentTokens: sums.context, tokenLimit: sums.limit };
  if (sums.tools !== null && sums.tools < sums.context) usage.toolDefinitionsTokens = sums.tools;
  if (sums.system !== null && sums.system + (usage.toolDefinitionsTokens ?? 0) < sums.context) {
    usage.systemTokens = sums.system;
    if (usage.toolDefinitionsTokens !== undefined) usage.conversationTokens = sums.context - sums.system - usage.toolDefinitionsTokens;
  }
  // the popup's rows to one decimal, as attributedParts gives them: whole percents left a 0.5% "Other" (round 8)
  if (usage.conversationTokens !== undefined) {
    const share = (tokens: number): number => Math.round((tokens / sums.context!) * 1000) / 10;
    usage.parts = [
      { category: "system", label: "System prompt", share: share(usage.systemTokens!) },
      { category: "system", label: "Tool Definitions", share: share(usage.toolDefinitionsTokens!) },
      { category: "user", label: "Messages", share: share(usage.conversationTokens) },
    ];
  }
  return usage;
}

function answer(session: string, state: LogState): HostChatCost {
  const sums = state.sums;
  return {
    session, models: models(sums.models), lastCallAt: sums.lastCallAt, lastModel: sums.lastModel, context: sums.context, peak: sums.peak, rewrites: sums.rewrites, firstWrites: sums.firstWrites, split: splitOf(sums),
    days: Object.fromEntries([...sums.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, map]) => [day, models(map)])),
    dayCounts: Object.fromEntries([...sums.dayCounts].sort(([a], [b]) => a.localeCompare(b)).map(([day, counts]) => [day, { ...counts }])),
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
  private sdkOf(session: string, parent: string | null = null): string | null {
    // a session's other chat (a peer chat or a fork): its SDK session is in the parent's store
    if (session.startsWith("ahp-chat:")) {
      const peer = peerChatSdkOf(session, this.agentDirs, parent);
      return peer !== null && (this.logs.has(peer) || this.pathOf(peer) !== null) ? peer : null;
    }
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

  /** `parent`: the session a chat id without one (`ahp-chat:/<uuid>`) belongs to, the host row's `fork_of` */
  costOf(session: string, parent: string | null = null): HostChatCost | null {
    const uuid = this.sdkOf(session, parent);
    const state = uuid === null ? null : this.read(uuid, this.bytesPerRequest);
    return state === null ? null : answer(session, state);
  }

  /**
   * Per message, the main agent's calls and its sub-agents', in the log's order: as far as `costOf`
   * read (the route asks both, the chart matching the sums), a log not opened yet up to the budget.
   */
  calls(session: string, parent: string | null = null): HostCostCall[] {
    const uuid = this.sdkOf(session, parent);
    const state = uuid === null ? null : this.logs.get(uuid) ?? this.read(uuid, this.bytesPerRequest);
    if (state === null) return [];
    return state.sums.messages.flatMap((message) => {
      // a reply that ran over an hour: its calls by hour too, each side on the same windows (the chart's hourly bars)
      const long = message.start !== null && message.end !== null && message.end - message.start > HOUR;
      const hours = long ? [...message.slices.entries()].sort(([a], [b]) => a - b).map(([, slice]) => slice) : [];
      return (["main", "sub"] as const).flatMap((side) => {
        const call = message[side];
        if (call === null) return [];
        if (!long) return [{ ...call }];
        return [{ ...call, hours: hours.flatMap((slice) => slice[side] === null ? [] : [{ ...slice[side] }]) }];
      });
    });
  }

  /**
   * Every log read so far, as `copilotcli:/<uuid>`. Each call reads what the known logs gained,
   * then up to 50 logs not read yet (written in the last 30 days, newest first); `complete` once
   * none is left and none stopped part way.
   */
  all(bytes = this.bytesPerRequest): HostCostsAnswer {
    let budget = Math.min(bytes, this.bytesPerRequest);
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
