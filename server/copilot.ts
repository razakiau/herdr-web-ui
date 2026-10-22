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

/**
 * What a collapsed call says. VS Code's own tools (in a moved chat) name a file `filePath`, edit
 * several files at once in `replacements`, and search by `query`; the shared summary knows none of
 * them. Its run_in_terminal explains a command in `explanation`, never a `description`.
 */
function summaryOf(name: string, fields: Row): string {
  const file = label(fields.filePath);
  if (file !== null) return file.slice(0, 120);
  if (Array.isArray(fields.replacements)) {
    const files = [...new Set(fields.replacements.map((item) => label(record(item).filePath)).filter((path) => path !== null))];
    if (files.length > 0) return files.join(", ").slice(0, 120);
  }
  const summary = toolSummary(name, fields);
  const query = label(fields.query);
  return summary === name && query !== null ? query.slice(0, 120) : summary;
}

/** The question an ask_user call asks: the CLI names it `message`, VS Code's Local harness `question`. */
const questionOf = (name: string, fields: Row): string | null =>
  name === "ask_user" ? label(fields.message) ?? label(fields.question) : null;

/** The CLI's record of an answer (1.0.88): "User responded: FICTIONAL_BLUE", a form's "colour=…, ok=…". */
const CLI_REPLY = "User responded: ";

/**
 * TaskSync (the VS Code extension behind the Local harness's ask_user) adds a note for the agent
 * after the first answer of a session, and marks that answer with a `directive`. The note is
 * TaskSync's, not the user's: measured on the owner's 1044 moved questions, it starts the same way
 * every time, after a blank line.
 */
const TASKSYNC_NOTE = /\n\n?TaskSync assigned session_id "[^"]*"\. [\s\S]*$/;

/**
 * What the user replied to an ask_user call, or null when no reply came back: a decline ("The user
 * is not available…"), a cancel, an empty answer, an error. Those stay a row that says so.
 */
function replyOf(content: string): string | null {
  if (content.startsWith(CLI_REPLY)) return label(content.slice(CLI_REPLY.length));
  if (!content.startsWith("{")) return null;
  let answer: Row;
  try { answer = record(JSON.parse(content)); } catch { return null; }
  if (typeof answer.response !== "string") return null;
  const said = answer.directive !== undefined ? answer.response.replace(TASKSYNC_NOTE, "") : answer.response;
  return said.trim() ? said : null;
}

/**
 * The images a tool call returned to the model (a screenshot, an image file it viewed). Copilot
 * keeps their bytes once, in a `session.binary_asset` event their `assetId` names; an image it
 * left out for size names no asset and has nothing to show.
 */
function imagesOf(data: Row): { assetId: string; mimeType: string }[] {
  const binaries = record(data.result).binaryResultsForLlm;
  if (!Array.isArray(binaries)) return [];
  return binaries.flatMap((value) => {
    const binary = record(value);
    const assetId = label(binary.assetId);
    const mimeType = label(binary.mimeType);
    return binary.type === "image" && assetId !== null && mimeType !== null && mimeType.startsWith("image/") ? [{ assetId, mimeType }] : [];
  });
}

/** The ref of a tool's image: `copilot:<call id>:<index among its images>`. */
export const COPILOT_IMAGE_REF = /^copilot:([A-Za-z0-9_:.-]{1,128}):(\d{1,3})$/;

/** The image a ref names, decoded from the asset event that holds its bytes; null when there is none. */
export function copilotImage(input: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = COPILOT_IMAGE_REF.exec(ref);
  if (match === null) return null;
  const [, callId, nth] = match;
  const needle = JSON.stringify(callId);
  let wanted: { assetId: string; mimeType: string } | null = null;
  for (const line of input.split("\n")) {
    if (!line.includes(needle)) continue;
    const entry = eventOf(line);
    if (entry === null || fromSubagent(entry) || entry.type !== "tool.execution_complete") continue;
    const data = record(entry.data);
    if (data.toolCallId === callId) wanted = imagesOf(data)[Number(nth)] ?? null;
  }
  if (wanted === null) return null;
  const asset = JSON.stringify(wanted.assetId);
  for (const line of input.split("\n")) {
    if (!line.includes(asset) || !line.includes('"session.binary_asset"')) continue;
    const data = record(eventOf(line)?.data);
    if (data.assetId !== wanted.assetId || typeof data.data !== "string") continue;
    return { mediaType: wanted.mimeType, bytes: new Uint8Array(Buffer.from(data.data, "base64")) };
  }
  return null;
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
  /** ask_user calls still open: shown as the question until the answer, which replaces a row */
  const asking = new Map<string, { name: string; input: string }>();
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
      asking.clear();
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
      // a question is what the agent said to the user: it reads as the agent's words, not a tool row
      const question = questionOf(name, fields);
      if (question !== null && id) {
        answer(ts).parts.push({ kind: "text", text: question });
        asking.set(id, { name, input });
        continue;
      }
      const part: ToolPart = { kind: "tool", name, summary: summaryOf(name, fields), input, output: "" };
      answer(ts).parts.push(part);
      if (id) pending.set(id, part);
      continue;
    }
    if (type === "tool.execution_complete") {
      const id = text(data.toolCallId);
      const failed = data.success === false;
      const output = failed ? text(record(data.error).message) || text(record(data.result).content) : text(record(data.result).content);
      const asked = asking.get(id);
      if (asked !== undefined) {
        asking.delete(id);
        const reply = failed ? null : replyOf(output);
        if (reply !== null) {
          // the user's answer, as if typed: the agent's next words open a turn of their own
          turns.push({ role: "user", ts, parts: [{ kind: "text", text: reply }] });
          open.turn = null;
          continue;
        }
        // no answer came back: a row under the question says what did ("User cancelled the request.")
        const outcome = output.split("\n").find((line) => line.trim())?.trim() ?? "";
        const part: ToolPart = { kind: "tool", name: asked.name, summary: outcome.slice(0, 120) || asked.name, input: asked.input, output: "" };
        trimOutput(part, output, id);
        if (failed) part.error = true;
        answer(ts).parts.push(part);
        continue;
      }
      const part = pending.get(id);
      if (part === undefined) continue;
      pending.delete(id);
      trimOutput(part, output, id);
      if (failed) part.error = true;
      const images = imagesOf(data).map((image, index) => ({ media_type: image.mimeType, ref: `copilot:${id}:${index}` }));
      if (images.length > 0) part.images = images;
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
