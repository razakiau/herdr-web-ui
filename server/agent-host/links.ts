/**
 * Which chat continues which (ZAC-265), read from the chats' Copilot logs
 * (`$COPILOT_HOME/session-state/<uuid>/events.jsonl`), the durable record of every kind but `job`:
 * the new chat's first `user.message` (`/resume <topic or CLI session id>`), the old chat's
 * `assistant.message` ending on the harness resume line (RESUME_LINE), and the `create_session`
 * tool's `tool.execution_complete`, whose result names the chat it made. Measured on the Mac,
 * 2026-10-31: the ZAC-262 chat (74ceb9b3) started both the ZAC-265 and the ZAC-266 chats with
 * `create_session` and never wrote a resume line for 265, so without `spawn` they would not link.
 */
import { resumeTopic } from "./handoff.ts";

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
