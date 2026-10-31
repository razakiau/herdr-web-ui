/**
 * Which chat continues which (ZAC-265), read from the chats' Copilot logs
 * (`$COPILOT_HOME/session-state/<uuid>/events.jsonl`), the durable record of every kind but `job`:
 * the new chat's first `user.message` (`/resume <topic or CLI session id>`), the old chat's
 * `assistant.message` ending on the harness resume line (RESUME_LINE), and the `create_session`
 * tool's `tool.execution_complete`, whose result names the chat it made. Measured on the Mac,
 * 2026-10-31: the ZAC-262 chat (74ceb9b3) started both the ZAC-265 and the ZAC-266 chats with
 * `create_session` and never wrote a resume line for 265, so without `spawn` they would not link.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HostLink, LinkKind } from "../../shared/host-chats.ts";
import { resumeTopic } from "./handoff.ts";
import { peerChatSdkOf } from "./todos.ts";

/** One fact a log line gives; the index decides which `first_user` is the log's first. */
export type LogFact =
  | { kind: "first_user"; text: string; at: string }
  | { kind: "resume_line"; topic: string; at: string }
  | { kind: "spawned"; chat: string; at: string };

const USER_MARK = '"user.message"';
const ASSISTANT_MARK = '"assistant.message"';
const COMPLETE_MARK = '"tool.execution_complete"';
/** the resume line's words, so a reply without one is never parsed */
const RESUME_MARK = "Start the next chat with: ";
const SPAWN_MARK = "Chat created in the current session (";
/**
 * create_session's whole result (live on the Mac, 2026-10-31):
 * `Chat created in the current session (agent-host-session://ahp-session/<s>?chat=<c>).`
 */
const SPAWNED = /^Chat created in the current session \(agent-host-session:\/\/ahp-session\/([0-9a-f-]{36})\?chat=([0-9a-f-]{36})\)\.?$/i;
/** `/resume X` or `/harness:resume X` at the start of the message */
const RESUME_ARG = /^\/(?:harness:)?resume[ \t]+(\S+)/;

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/** The argument of a message's leading `/resume X` or `/harness:resume X`, else null. */
export function resumeArg(text: string): string | null {
  return RESUME_ARG.exec(text.trimStart())?.[1] ?? null;
}

/**
 * The host row id of the chat `create_session` made: the bridge lists a session's other chat as
 * `ahp-chat://<chat>/<base64url of its session's URI>` (rowsFrom, from the host's
 * SessionSummary.chats), and the host names that session `ahp-session:/<s>`. Null for any other text.
 */
export function spawnedChat(result: string): string | null {
  const match = SPAWNED.exec(result.trim());
  if (!match) return null;
  const parent = `ahp-session:/${match[1]!.toLowerCase()}`;
  return `ahp-chat://${match[2]!.toLowerCase()}/${Buffer.from(parent).toString("base64url")}`;
}

/**
 * What one complete `events.jsonl` line says about links, else null. A line that cannot hold one
 * is passed over by a substring check before any JSON.parse (a log is mostly usage and tool lines).
 * A sub-agent's messages (`agentId` on the envelope) are not the chat's.
 */
export function factOf(line: string): LogFact | null {
  const user = line.includes(USER_MARK);
  const assistant = !user && line.includes(ASSISTANT_MARK) && line.includes(RESUME_MARK);
  const complete = !user && !assistant && line.includes(COMPLETE_MARK) && line.includes(SPAWN_MARK);
  if (!user && !assistant && !complete) return null;
  let entry: Row;
  try { entry = record(JSON.parse(line)); } catch { return null; }
  if (typeof entry.agentId === "string" && entry.agentId !== "") return null;
  const at = typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  if (at === null) return null;
  const data = record(entry.data);
  if (entry.type === "user.message") {
    return typeof data.content === "string" ? { kind: "first_user", text: data.content, at } : null;
  }
  if (entry.type === "assistant.message") {
    const topic = typeof data.content === "string" ? resumeTopic(data.content) : null;
    return topic === null ? null : { kind: "resume_line", topic, at };
  }
  if (entry.type === "tool.execution_complete") {
    const content = record(data.result).content;
    const chat = typeof content === "string" ? spawnedChat(content) : null;
    return chat === null ? null : { kind: "spawned", chat, at };
  }
  return null;
}

/** `HostLink` as the index keeps it: each end an SDK session id (a log's uuid), or a host row id it could not name by one */
export type SdkLink = HostLink;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** the first scan reads logs written in the last 30 days, as CostIndex's */
const SCAN_DAYS = 30;
/** new logs opened per `all()`, so a request never waits on the whole store */
const FILES_PER_SCAN = 50;
/** bytes a request reads by default; the route reads POLL_BYTES_PER_SCAN at a time (routes.ts) */
const BYTES_PER_SCAN = 128 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const DAY = 86_400_000;
/**
 * a `resume` source's line is at most this old when the new chat's first message comes (spec's
 * builder's call): a hand-off is picked up the same day or after a weekend, and a topic reused
 * months later must not join two threads
 */
const RESUME_WINDOW = 14 * DAY;
const START_MARK = '"session.start"';
/** when two kinds name the same (from, to), the first in this order wins */
const ORDER: readonly LinkKind[] = ["job", "spawn", "continue", "resume"];

interface LogState {
  path: string; offset: number; partial: boolean;
  /**
   * when the session was created (its first `session.start`): a fork's log copies its source's
   * events, with their earlier timestamps, after it (as costs.ts isInherited); those are the
   * source's facts, not the fork's
   */
  startedAt: number | null;
  /** its first own user message, kept once */
  first: { text: string; at: string } | null;
  resumes: { topic: string; at: string }[];
  spawned: { chat: string; at: string }[];
}

const fresh = (path: string): LogState => ({ path, offset: 0, partial: false, startedAt: null, first: null, resumes: [], spawned: [] });

function take(state: LogState, line: string): void {
  if (state.startedAt === null && line.includes(START_MARK)) {
    let entry: Row;
    try { entry = record(JSON.parse(line)); } catch { return; }
    if (entry.type !== "session.start") return;
    const data = record(entry.data);
    const at = Date.parse(typeof data.startTime === "string" ? data.startTime : typeof entry.timestamp === "string" ? entry.timestamp : "");
    if (Number.isFinite(at)) state.startedAt = at;
    return;
  }
  const fact = factOf(line);
  if (fact === null) return;
  if (state.startedAt !== null && Date.parse(fact.at) < state.startedAt) return;
  if (fact.kind === "first_user") { state.first ??= { text: fact.text, at: fact.at }; return; }
  if (fact.kind === "resume_line") { state.resumes.push({ topic: fact.topic, at: fact.at }); return; }
  state.spawned.push({ chat: fact.chat, at: fact.at });
}

/**
 * Reads the log from its offset to its last complete line, at most `budget` bytes (a line longer
 * than that is still read whole), as costs.ts readLog does. Returns the bytes read. A log that
 * shrank was replaced: read anew.
 */
function readLog(state: LogState, budget: number): number {
  let size: number;
  try { size = statSync(state.path).size; } catch { return 0; }
  if (size < state.offset) Object.assign(state, fresh(state.path));
  if (state.offset >= size) { state.partial = false; return 0; }
  let fd: number;
  try { fd = openSync(state.path, "r"); } catch { return 0; }
  let read = 0;
  try {
    let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size - state.offset, budget)));
    while (state.offset < size && read < budget) {
      const got = readSync(fd, buffer, 0, Math.min(buffer.length, size - state.offset), state.offset);
      if (got <= 0) break;
      const last = buffer.lastIndexOf(10, got - 1);
      if (last < 0) {
        // the log's torn tail waits for the next read; a line longer than the buffer is read whole
        if (state.offset + got >= size) break;
        buffer = Buffer.allocUnsafe(buffer.length * 2);
        continue;
      }
      for (const line of buffer.toString("utf8", 0, last).split("\n")) take(state, line);
      state.offset += last + 1;
      read += last + 1;
    }
  } finally { closeSync(fd); }
  state.partial = size - state.offset > 0 && read >= budget;
  return read;
}

/**
 * The links this PC's Copilot logs give, read incrementally as CostIndex reads costs (30-day first
 * scan, newest first, FILES_PER_SCAN new logs and a byte budget per call, a line still being
 * written left for the next read), plus the hand-off jobs this bridge saw end (`addJob`, memory
 * only: a restart forgets them, and their chats' logs give the same link as `resume` or `continue`).
 * Each log keeps only its first own user message, its resume lines and the chats it spawned; the
 * links are derived from those on every call.
 */
export class LinkIndex {
  /** per SDK session (its folder's uuid): the log's state */
  private readonly logs = new Map<string, LogState>();
  /** logs found but not read yet, newest first; null before the first scan listed the store */
  private queue: string[] | null = null;
  private readonly jobs = new Map<string, SdkLink>();
  /** bytes read from the logs so far (tests: a second read takes only what was appended) */
  bytesRead = 0;

  constructor(
    private readonly home: string, private readonly agentDirs: readonly string[], private readonly now: () => number = Date.now,
    private readonly bytesPerRequest = BYTES_PER_SCAN,
  ) {}

  /** A hand-off job ended `done`: `to` continues `from` (SDK ids where the caller could name them). */
  addJob(from: string, to: string, at: string): void {
    const key = `${from}\n${to}`;
    if (!this.jobs.has(key)) this.jobs.set(key, { from, to, kind: "job", at });
  }

  /** Reads what the logs gained, up to `bytes`, then answers every link known; `complete` once nothing is left to read. */
  all(bytes = this.bytesPerRequest): { links: SdkLink[]; complete: boolean } {
    let budget = Math.min(bytes, this.bytesPerRequest);
    for (const state of this.logs.values()) {
      if (budget <= 0) { state.partial = state.partial || this.stale(state); continue; }
      const read = readLog(state, budget);
      budget -= read; this.bytesRead += read;
    }
    const queue = this.list();
    let started = 0;
    while (queue.length > 0 && started < FILES_PER_SCAN && budget > 0) {
      const uuid = queue.shift()!;
      started += 1;
      if (this.logs.has(uuid)) continue;
      const state = fresh(join(this.home, "session-state", uuid, "events.jsonl"));
      this.logs.set(uuid, state);
      const read = readLog(state, budget);
      budget -= read; this.bytesRead += read;
    }
    const complete = queue.length === 0 && [...this.logs.values()].every((state) => !state.partial);
    return { links: this.derive(), complete };
  }

  private derive(): SdkLink[] {
    const found: SdkLink[] = [...this.jobs.values()];
    for (const [uuid, state] of this.logs) {
      for (const spawned of state.spawned) {
        // the new chat's SDK session, through its parent's store; else the host row its result names
        const sdk = peerChatSdkOf(spawned.chat, this.agentDirs);
        found.push({ from: uuid, to: sdk ?? spawned.chat, kind: "spawn", at: spawned.at });
      }
      const first = state.first;
      const arg = first === null ? null : resumeArg(first.text);
      if (first === null || arg === null) continue;
      // tried as a CLI session id first, then as a topic
      const id = arg.toLowerCase();
      if (UUID.test(id) && id !== uuid && (this.logs.has(id) || existsSync(join(this.home, "session-state", id, "events.jsonl")))) {
        found.push({ from: id, to: uuid, kind: "continue", at: first.at });
        continue;
      }
      const start = Date.parse(first.at);
      const sources = [...this.logs].filter(([other, each]) => other !== uuid && each.resumes.some((line) => {
        const at = Date.parse(line.at);
        return line.topic === arg && at <= start && start - at <= RESUME_WINDOW;
      }));
      // a topic two chats ended on names neither: no link rather than a wrong one
      if (sources.length === 1) found.push({ from: sources[0]![0], to: uuid, kind: "resume", at: first.at });
    }
    const kept = new Map<string, SdkLink>();
    for (const link of found.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))) {
      const key = `${link.from}\n${link.to}`;
      if (!kept.has(key)) kept.set(key, link);
    }
    return [...kept.values()].sort((a, b) => a.at.localeCompare(b.at) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  }

  /** a log that grew past the last read */
  private stale(state: LogState): boolean {
    try { return statSync(state.path).size > state.offset; } catch { return false; }
  }

  /** Queues the logs written in the last 30 days that are not known yet, newest first; the queue. */
  private list(): string[] {
    const store = join(this.home, "session-state");
    const since = this.now() - SCAN_DAYS * DAY;
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
    this.queue = [...found.map((each) => each.uuid), ...(this.queue ?? [])];
    return this.queue;
  }
}
