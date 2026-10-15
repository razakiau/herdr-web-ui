import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

/**
 * GitHub Copilot's session log: `~/.copilot/session-state/<id>/events.jsonl`, one event per line
 * (`type`, `data`, `id`, `parentId`, `timestamp`), written alike by the Copilot CLI, the Copilot
 * SDK and VS Code's Copilot harness, and by VS Code when it moves a Local chat there (producer
 * `vscode-copilot-migration`). The SDK's `session-events.schema.json` is the reference.
 */

type Row = Record<string, unknown>;
type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

/** Copilot's home: `COPILOT_HOME` moves it, as the CLI reads it (1.0.88), else `~/.copilot`. */
export const defaultCopilotHome = (): string => process.env["COPILOT_HOME"] || join(process.env["HOME"] || homedir(), ".copilot");

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session herdr's Copilot integration reported for the pane, or null for none or another agent's. */
export function copilotSessionId(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "copilot" || session.kind !== "id" || typeof session.value !== "string" || !SESSION_ID.test(session.value)) return null;
  return session.value.toLowerCase();
}

/**
 * The session's events file, inside the store and a real file, or null when it is not one.
 * `unwritten` is a session whose folder Copilot has not written yet: the CLI reports its id at
 * start, before its first event, so it is a chat not begun rather than a missing one.
 */
export function copilotTranscript(sessionId: string, home = defaultCopilotHome()): { path: string } | { unwritten: string } | null {
  const store = join(home, "session-state");
  const path = join(store, sessionId, "events.jsonl");
  let root: string;
  try { root = realpathSync(store); } catch { return { unwritten: sessionId }; }
  let canonical: string;
  try { canonical = realpathSync(path); } catch {
    // an absent folder or file is a session still to come; anything else at that name is not one
    try { lstatSync(join(store, sessionId)); } catch { return { unwritten: sessionId }; }
    try { lstatSync(path); return null; } catch { return { unwritten: sessionId }; }
  }
  const inside = relative(root, canonical);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return null;
  if (inside !== join(sessionId, "events.jsonl")) return null;
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? { path: canonical } : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const label = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** One parsed line, or null for a torn or foreign one. */
function eventOf(line: string): Row | null {
  if (line.length === 0) return null;
  try {
    const entry = record(JSON.parse(line));
    return typeof entry.type === "string" ? entry : null;
  } catch { return null; }
}

/**
 * A subagent's own events (its prompt, its answers, its tool calls, its model) carry the
 * subagent's `agentId`; the main chat's carry none. Its work reaches the chat as the result of
 * the `task` call that started it, as Copilot shows it.
 */
const fromSubagent = (entry: Row): boolean => typeof entry.agentId === "string" && entry.agentId.length > 0;

/** A tool call's arguments: an object as the CLI records them, a JSON string in older records. */
function argumentsOf(value: unknown): { input: string; fields: Row } {
  if (typeof value === "string") {
    try { return { input: value, fields: record(JSON.parse(value)) }; } catch { return { input: value, fields: {} }; }
  }
  if (value === undefined || value === null) return { input: "", fields: {} };
  return { input: JSON.stringify(value, null, 2), fields: record(value) };
}

/** What a collapsed call says: the question an ask_user call asked, else the usual summary. */
function summaryOf(name: string, fields: Row): string {
  // the CLI's ask_user names its question `message`; VS Code's Local harness named it `question`
  if (name === "ask_user") {
    const asked = label(fields.message) ?? label(fields.question);
    if (asked !== null) return asked.slice(0, 120);
  }
  // VS Code's run_in_terminal explains a command in `explanation`, never a `description`
  return toolSummary(name, fields);
}

/** What a user.message event shows as the user's prompt, or null when it is no prompt: empty, injected, or a subagent's. */
function promptOf(entry: Row): string | null {
  if (entry.type !== "user.message" || fromSubagent(entry)) return null;
  const data = record(entry.data);
  const prompt = text(data.content);
  // `source` names a message nobody typed: a skill's hidden injection, an inter-agent prompt
  const source = label(data.source);
  return prompt.trim().length === 0 || (source !== null && source !== "user") ? null : prompt;
}

/** Bytes every line that opens a turn holds: both writers emit compact JSON. */
export const COPILOT_TURN_MARK = Buffer.from('"type":"user.message"');

/** Does this line open a turn: the main chat's typed prompt. Pages start at such lines. */
export function copilotOpensTurn(line: string): boolean {
  const entry = eventOf(line);
  return entry !== null && promptOf(entry) !== null;
}

/** Splits a Copilot session's events into turns, the way the chat lens shows every agent's. */
export function parseCopilotEvents(input: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, ToolPart>();
  /** the assistant turn answering the last prompt, until the next one */
  const open: { turn: ConversationTurn | null } = { turn: null };

  const answer = (ts: string | null): ConversationTurn => {
    if (open.turn === null) {
      open.turn = { role: "assistant", ts, parts: [] };
      turns.push(open.turn);
    }
    if (ts !== null) open.turn.end_ts = ts;
    return open.turn;
  };
  const touch = (ts: string | null): void => { if (open.turn !== null && ts !== null) open.turn.end_ts = ts; };

  for (const line of input.split("\n")) {
    const entry = eventOf(line);
    if (entry === null || fromSubagent(entry)) continue;
    const type = entry.type as string;
    const data = record(entry.data);
    const ts = label(entry.timestamp);

    if (type === "session.context_cleared") {
      turns.length = 0;
      pending.clear();
      open.turn = null;
      continue;
    }
    if (type === "user.message") {
      const prompt = promptOf(entry);
      if (prompt === null) continue;
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] });
      open.turn = null;
      continue;
    }
    if (type === "assistant.message") {
      const turn = answer(ts);
      const thinking = text(data.reasoningText);
      if (thinking.trim()) turn.parts.push({ kind: "thinking", text: thinking });
      const said = text(data.content);
      if (said.trim()) turn.parts.push({ kind: "text", text: said });
      continue;
    }
    if (type === "assistant.turn_end") {
      touch(ts);
      continue;
    }
    if (type === "tool.execution_start") {
      const id = text(data.toolCallId);
      const name = label(data.toolName) ?? "tool";
      const { input, fields } = argumentsOf(data.arguments);
      const part: ToolPart = { kind: "tool", name, summary: summaryOf(name, fields), input, output: "" };
      answer(ts).parts.push(part);
      if (id) pending.set(id, part);
      continue;
    }
    if (type === "tool.execution_complete") {
      const id = text(data.toolCallId);
      const part = pending.get(id);
      if (part === undefined) continue;
      pending.delete(id);
      const failed = data.success === false;
      const output = failed ? text(record(data.error).message) || text(record(data.result).content) : text(record(data.result).content);
      trimOutput(part, output, id);
      if (failed) part.error = true;
      touch(ts);
      continue;
    }
    if (type === "session.error") {
      const message = label(data.message);
      if (message !== null) answer(ts).parts.push({ kind: "text", text: `Error: ${message}` });
      continue;
    }
    // an interrupted turn ends where it stopped, as every reader's does: the chat draws no row for it
    if (type === "session.compaction_complete") {
      const summary = text(data.summaryContent);
      if (data.success === true && summary.trim()) {
        turns.push({ role: "user", ts, parts: [{ kind: "compact", text: summary }] });
        open.turn = null;
      }
    }
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

/** The whole output of one of the main chat's tool calls, by its call id, after the last context clear; null when there is none. */
export function copilotToolOutput(input: string, ref: string): string | null {
  const needle = JSON.stringify(ref);
  let output: string | null = null;
  for (const line of input.split("\n")) {
    if (line.includes('"session.context_cleared"')) { output = null; continue; }
    if (!line.includes(needle)) continue;
    const entry = eventOf(line);
    if (entry === null || fromSubagent(entry) || entry.type !== "tool.execution_complete") continue;
    const data = record(entry.data);
    if (data.toolCallId !== ref) continue;
    output = data.success === false ? text(record(data.error).message) || text(record(data.result).content) : text(record(data.result).content);
  }
  return output;
}

/**
 * The main chat's model and effort as the session last recorded them (its start or resume, a
 * model change, the model each answer came from), and what the last request filled of its
 * window. `inputTokens` already counts the cached part of the prompt; `maxPromptTokens` is the
 * window that request ran against.
 */
export function parseCopilotMetadata(input: string, before?: ConversationMetadata): ConversationMetadata {
  const metadata: ConversationMetadata = before ? { ...before } : { model: null, reasoning_effort: null };
  for (const line of input.split("\n")) {
    const entry = eventOf(line);
    if (entry === null || fromSubagent(entry)) continue;
    const data = record(entry.data);
    switch (entry.type) {
      case "session.start":
      case "session.resume": {
        const model = label(data.selectedModel);
        if (model !== null) metadata.model = model;
        if ("reasoningEffort" in data) metadata.reasoning_effort = label(data.reasoningEffort);
        break;
      }
      case "session.model_change": {
        const model = label(data.newModel);
        if (model !== null) metadata.model = model;
        if ("reasoningEffort" in data) metadata.reasoning_effort = label(data.reasoningEffort);
        break;
      }
      case "session.context_cleared":
        delete metadata.context;
        break;
      case "assistant.message": {
        const model = label(data.model);
        if (model !== null) metadata.model = model;
        break;
      }
      case "session.usage_record": {
        // one record per model request of the chat, its first (`initiator: user`) and each one
        // after a tool call (`agent`) alike; a subagent's carry its agentId and are skipped above
        const usage = record(data.usage);
        const used = count(usage.inputTokens);
        if (used > 0) metadata.context = { used, window: count(usage.maxPromptTokens) || null };
        if ("reasoningEffort" in usage && label(usage.reasoningEffort) !== null) metadata.reasoning_effort = label(usage.reasoningEffort);
        break;
      }
    }
  }
  return metadata;
}
