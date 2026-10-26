/**
 * Pure mappers from the agent host's state (AHP) to what the phone draws: the chat list, a chat's
 * turns in herdr's conversation shape, the question or approval it waits on, and the models and
 * agents it can be sent with. No I/O; routes.ts feeds them the connection's mirror.
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatInputAnswerState,
  ChatInteractivity,
  ChatOriginKind,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  ConfirmationOptionKind,
  CustomizationType,
  MessageAttachmentKind,
  ResponsePartKind,
  SessionStatus,
  ToolCallCancellationReason,
  ToolCallStatus,
  ToolResultContentType,
  TurnState,
  type ActiveTurn,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
  type ChatState,
  type Customization,
  type PendingMessage,
  type InputRequestResponsePart,
  type Message,
  type ModelSelection,
  type ResponsePart,
  type RootState,
  type SessionState,
  type SessionSummary,
  type StringOrMarkdown,
  type ToolCallState,
  type ToolResultContent,
  type ToolResultEmbeddedResourceContent,
  type ToolResultFileEditContent,
  type ToolResultSubagentContent,
  type ToolResultTerminalContent,
  type Turn,
} from "@microsoft/agent-host-protocol";
import { artifactsOf, workOf } from "./artifacts.ts";
import { todosSince, type StoredTodo } from "./todos.ts";
import type { ConversationPart, ConversationTurn, FileEditKind, InteractivePromptOption, ToolEdit } from "../../shared/protocol.ts";
import type { HostAgent, HostChatRead, HostChatRow, HostCheckpoint, HostCommand, HostContextUsage, HostModel, HostTokenTotal } from "../../shared/host-chats.ts";
import { IMAGE_TYPES } from "../conversation.ts";
import { trimOutput } from "../tool-output.ts";

export const PROVIDER = "copilotcli";
/** InteractivePrompt.agent for every host chat card. */
const PROMPT_AGENT = "copilot";
/** The typed-answer slot's label, after a question's own options. */
export const OTHER_LABEL = "Other…";
/** A text, number or integer question has only the typed-answer slot. */
const ANSWER_LABEL = "Answer";
/** In `option_ids`: the slot that has no host id (the typed answer, or a default Approve/Deny). */
const NO_ID = "";

type Status = HostChatRow["status"];

/** Bit flags: InputNeeded (24) includes InProgress (8), so it is tested first. */
export function statusOf(status: number): Status {
  if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) return "asks";
  if (status & SessionStatus.InProgress) return "working";
  if (status & SessionStatus.Error) return "error";
  return "idle";
}

export function pathOf(uri: string | undefined): string | null {
  if (!uri?.startsWith("file:")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

/**
 * A chat VS Code opened and nobody sent to: VS Code makes one per window it opens ("backing stays
 * deferred until the first send") and lists none of them; there is nothing to read. Its default
 * chat has no title, it is idle and never read, and it has not changed since it was made. A blank
 * default chat title alone is not one: real chats on the Mac's host had it, read and hours old
 * (2026-10-21: "MCP integration with Sentry", status 33, 8620 s; the draft: status 1, 0 s).
 */
const DRAFT_AGE_MS = 1_000;
function neverSent(summary: SessionSummary): boolean {
  const own = summary.chats?.find((chat) => chat.resource === summary.defaultChat);
  if (!own || own.title !== "") return false;
  const status = own.status ?? summary.status;
  if (status !== SessionStatus.Idle || summary.status !== SessionStatus.Idle) return false;
  const age = Date.parse(String(summary.modifiedAt)) - Date.parse(String(summary.createdAt));
  return Number.isFinite(age) && age < DRAFT_AGE_MS;
}

/**
 * The chat list: Copilot CLI sessions only, newest first, without the drafts VS Code never sent. A session's other chats a user made (VS
 * Code's Fork Conversation: SessionSummary.chats, origin fork or user) are rows of their own, by
 * their chat URI, beside it: their own title and status, the session's folder and time (a catalog
 * entry has none). Hidden chats and a tool's are not listed, as VS Code lists none of them.
 */
export function rowsFrom(summaries: SessionSummary[]): HostChatRow[] {
  return summaries
    .filter((summary) => summary.provider === PROVIDER && !neverSent(summary))
    .flatMap((summary) => {
      const meta = (summary as { _meta?: Record<string, unknown> })._meta;
      const folder = pathOf(summary.workingDirectories?.[0] ?? summary.project?.uri);
      // a chat the host was given no folder for runs in a scratch folder of its own,
      // ~/.copilot/chats/<id> (VS Code drops its folders when it creates a chat mid-reconnect,
      // seen 2026-10-21): every such chat files under one row, their common parent
      const noFolder = meta?.["workspaceless"] === true && folder !== null;
      const cwd = noFolder ? dirname(folder) : folder;
      // the host names a worktree's main checkout as its project: the folder it nests under
      const project = pathOf(summary.project?.uri);
      const repo = project !== null && cwd !== null && project !== cwd ? { repo: project } : {};
      // the branch VS Code reported for the folder (`_meta.git`, as its Sessions list shows it)
      const git = meta?.["git"] as { branchName?: unknown; isDetachedHead?: unknown } | undefined;
      const where = {
        ...repo,
        ...(typeof git?.branchName === "string" && git.branchName !== "" ? { branch: git.branchName } : git?.isDetachedHead === true ? { detached: true } : {}),
        ...(noFolder ? { no_folder: true } : {}),
      };
      // a session's status promotes any chat's InputNeeded and Error (AHP's aggregation rule): its
      // row is its default chat, so it reads that chat's own activity, as each fork's row reads its own
      const own = summary.chats?.find((chat) => chat.resource === summary.defaultChat)?.status;
      const row: HostChatRow = {
        session: summary.resource,
        title: summary.title,
        status: statusOf(own ?? summary.status),
        modified_at: summary.modifiedAt,
        cwd,
        // the flags beside the activity bits (VS Code's isSessionStatusRead / isSessionStatusArchived)
        unread: (summary.status & SessionStatus.IsRead) === 0,
        archived: (summary.status & SessionStatus.IsArchived) !== 0,
        ...where,
      };
      // what it is doing now, in the host's words (its intent, a command's progress): only while it works,
      // as a word kept from a finished turn would read as current
      const activity = summary.activity?.trim();
      if (activity && row.status === "working") row.activity = activity;
      const forks = (summary.chats ?? []).filter((chat) => chat.resource !== summary.defaultChat
        && chat.interactivity !== ChatInteractivity.Hidden && (chat.origin === undefined || chat.origin.kind === ChatOriginKind.Fork || chat.origin.kind === ChatOriginKind.User));
      return [row, ...forks.map((chat): HostChatRow => {
        // a chat without a status is unknown: neither unread nor archived (AHP's rule)
        const status = chat.status ?? (SessionStatus.Idle | SessionStatus.IsRead);
        return {
          session: chat.resource, title: chat.title, status: statusOf(status), modified_at: summary.modifiedAt, cwd,
          unread: (status & SessionStatus.IsRead) === 0, archived: (status & SessionStatus.IsArchived) !== 0,
          fork_of: summary.resource, ...where,
        };
      })];
    })
    .sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : 0));
}

const plain = (value: StringOrMarkdown | undefined): string => (value === undefined ? "" : typeof value === "string" ? value : value.markdown);

// ─── Turns ───────────────────────────────────────────────────────────────────

const contentOf = (tool: ToolCallState): ToolResultContent[] => ("content" in tool ? tool.content ?? [] : []);

/** A call's whole output: its text blocks, else what its terminal printed. */
function toolOutput(tool: ToolCallState): string {
  const content = contentOf(tool);
  const texts = content.flatMap((item) => (item.type === ToolResultContentType.Text ? [item.text] : []));
  if (texts.length > 0) return texts.join("\n");
  return content.flatMap((item) => (item.type === ToolResultContentType.Terminal && item.result?.preview ? [item.result.preview] : [])).join("\n");
}

/** The images a call returned, in order: the index in its ref counts these alone. */
function imagesOf(tool: ToolCallState): ToolResultEmbeddedResourceContent[] {
  return contentOf(tool).flatMap((item) => (item.type === ToolResultContentType.EmbeddedResource && IMAGE_TYPES.has(item.contentType) ? [item] : []));
}

function editOf(edit: ToolResultFileEditContent): { path: string; added: number; removed: number } {
  const uri = edit.after?.uri ?? edit.before?.uri ?? "";
  return { path: pathOf(uri) ?? uri, added: edit.diff?.added ?? 0, removed: edit.diff?.removed ?? 0 };
}

/** What an edit did to its file, as VS Code's snapshot controller reads the two sides. */
export function editKind(edit: ToolResultFileEditContent): FileEditKind {
  if (edit.before === undefined) return "create";
  if (edit.after === undefined) return "delete";
  return edit.before.uri === edit.after.uri ? "edit" : "rename";
}

/** One edit as a tool part lists it: its file, lines, kind, where a rename came from, and the ref its diff is read by. */
function shownEdit(edit: ToolResultFileEditContent, ref: string): ToolEdit {
  const kind = editKind(edit);
  const from = kind === "rename" ? pathOf(edit.before!.uri) ?? edit.before!.uri : null;
  return { ...editOf(edit), kind, ...(from !== null ? { from } : {}), ref };
}

/** The edit a part's ref (`<toolCallId>:<index>`, the index among the call's edits) names; null when the chat holds none. */
export function fileEditOf(chat: ChatState, ref: string): ToolResultFileEditContent | null {
  const at = ref.lastIndexOf(":");
  const digits = at < 0 ? "" : ref.slice(at + 1);
  if (!/^(?:0|[1-9]\d*)$/.test(digits)) return null;
  const tool = toolCallOf(chat, ref.slice(0, at));
  const edits = tool ? contentOf(tool).filter((item): item is ToolResultFileEditContent => item.type === ToolResultContentType.FileEdit) : [];
  return edits[Number(digits)] ?? null;
}

/** A turn's file edits in the order its calls made them (VS Code's checkpoint is these). */
export function turnEdits(turn: Turn | ActiveTurn): ToolResultFileEditContent[] {
  return turn.responseParts.flatMap((part) => part.kind === ResponsePartKind.ToolCall
    ? contentOf(part.toolCall).flatMap((item) => (item.type === ToolResultContentType.FileEdit ? [item] : []))
    : []);
}

/** Each loaded turn's checkpoint: its id and the files its edits touched, each file once, lines summed. */
export function checkpointsOf(chat: ChatState): HostCheckpoint[] {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  return all.map((turn) => {
    const files = new Map<string, { path: string; added: number; removed: number }>();
    for (const edit of turnEdits(turn).map(editOf)) {
      const seen = files.get(edit.path);
      if (seen) { seen.added += edit.added; seen.removed += edit.removed; } else files.set(edit.path, { ...edit });
    }
    return { turn: turn.id, files: [...files.values()] };
  });
}

const settled = (tool: ToolCallState): boolean => tool.status === ToolCallStatus.Completed || tool.status === ToolCallStatus.Cancelled || tool.status === ToolCallStatus.PendingResultConfirmation;

/** When the turn a part is in started and ended: tool call states carry no times of their own. */
interface TurnTimes { started: string | null; ended: string | null }

/**
 * What a read knows beyond the chat itself: a subagent's own chat when the bridge holds it (its
 * model, its times, what it does now), and a model's display name. Without it a subagent row has
 * its turn's times and no model.
 */
export interface ReadContext {
  chat(uri: string): ChatState | undefined;
  modelName(id: string): string;
  /** the picker's model ids: a served model's route prefix ("cc/") differs from the picker's ("omniroute/") */
  modelIds?(): readonly string[];
  /** the chat's session state, for its "/" commands (absent: none) */
  session?(): SessionState | undefined;
  /** the skills the host completes for "/" on the session (a plugin's skills are only there) */
  skills?(): HostCommand[];
  /** a model's whole context window as the host lists it (maxContextWindow), null when it has none */
  modelWindow?(id: string): number | null;
  /** the most a model writes in one answer as the host lists it (maxOutputTokens), null when it has none */
  modelOutput?(id: string): number | null;
  /** the session's todo list with when each row was written (server/agent-host/todos.ts), null when it has none */
  todos?(): StoredTodo[] | null;
}

/** The turn being read: its times, whether it runs, and its own model (for a subagent's to differ from). */
interface TurnRead { times: TurnTimes; running: boolean; model: string | null; context: ReadContext | undefined }

const AUTO_MODEL = "auto";

/**
 * Whether a subagent's model is worth saying: any concrete one, the chat's own too, unlike VS
 * Code's shouldShowSubagentModel (owner, ZAC-233: which model and effort a worker runs on was the
 * question; the same name as the chat's answers it). Auto names nothing.
 */
function shownModel(subagent: string | undefined): boolean {
  const own = subagent?.trim().toLowerCase();
  return !!own && own !== AUTO_MODEL;
}

/**
 * A served model's name: usage names it with its route's prefix ("cc/claude-opus-5-5", live
 * 2026-10-26), the picker by its own ("omniroute/claude-opus-5-5"). The longest tail the picker
 * knows, else the one picker model whose last part is the same, else the id as it came.
 */
function servedName(id: string, context: ReadContext): string {
  const parts = id.split("/");
  for (let at = 0; at < parts.length; at++) {
    const tail = parts.slice(at).join("/");
    const name = context.modelName(tail);
    if (name !== tail) return name;
  }
  const bare = parts.at(-1)!;
  const same = (context.modelIds?.() ?? []).filter((each) => each.split("/").at(-1) === bare);
  return same.length === 1 ? context.modelName(same[0]!) : id;
}

/** A model selection's effort: thinkingLevel, else its config's one string value (as modelOf reads it). */
function effortOfSelection(selection: { config?: Record<string, unknown> } | undefined): string | null {
  const config = selection?.config ?? {};
  const effort = config["thinkingLevel"] ?? Object.values(config).find((value) => typeof value === "string");
  return typeof effort === "string" && effort.trim() !== "" ? effort : null;
}

/**
 * A subagent chat's own times, as VS Code reads them (getSubagentTiming): from its first turn's
 * start to its last finished turn's end; no end while a turn runs.
 */
function chatTiming(chat: ChatState): { started: string | null; ended: string | null } {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  const starts = all.map((turn) => (turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN)).filter(Number.isFinite);
  if (starts.length === 0) return { started: null, ended: null };
  const started = Math.min(...starts);
  if (chat.activeTurn) return { started: new Date(started).toISOString(), ended: null };
  const ends = chat.turns.flatMap((turn) => {
    const at = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
    return Number.isFinite(at) && typeof turn.duration === "number" && Number.isFinite(turn.duration) ? [at + Math.max(0, turn.duration)] : [];
  });
  return { started: new Date(started).toISOString(), ended: ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : null };
}

/** What a running subagent does now: its newest tool call's words. */
function activityOf(chat: ChatState): string | undefined {
  const calls = (chat.activeTurn?.responseParts ?? []).flatMap((part) => (part.kind === ResponsePartKind.ToolCall ? [part.toolCall] : []));
  const newest = calls.at(-1);
  if (!newest) return undefined;
  const words = plain("pastTenseMessage" in newest && newest.status === ToolCallStatus.Completed ? newest.pastTenseMessage : newest.invocationMessage).trim();
  return words === "" ? newest.displayName : words;
}

/**
 * A subagent the call started. AHP gives a tool call no start or end time, so its times are its
 * turn's: started with the turn, ended when the turn ended (null while the turn runs on).
 */
/** The task call's own words: its short intent and whether it runs in the background (Copilot CLI's task tool). */
function taskInput(tool: ToolCallState): { intent: string | null; background: boolean } {
  let input: unknown;
  try { input = JSON.parse("toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : ""); } catch { return { intent: null, background: false }; }
  if (!isRecord(input)) return { intent: null, background: false };
  const intent = typeof input["description"] === "string" && input["description"].trim() !== "" ? input["description"].trim() : null;
  return { intent, background: input["mode"] === "background" };
}

function subagentPart(tool: ToolCallState, subagent: ToolResultSubagentContent, turn: TurnRead): ConversationPart {
  const failed = "success" in tool && tool.success === false;
  // its own chat, when the bridge holds it: the real times and model, and what it does now
  const own = turn.context?.chat(subagent.resource);
  const { intent, background } = taskInput(tool);
  // a background task's call settles as soon as it is launched: its own chat still running says it runs on
  const status = !settled(tool) || (!failed && own?.activeTurn !== undefined) ? "running" : failed || tool.status === ToolCallStatus.Cancelled ? "failed" : "done";
  const timing = own ? chatTiming(own) : null;
  const ownTurn = own ? own.activeTurn ?? own.turns.at(-1) : undefined;
  const ownSelection = ownTurn?.message.model;
  // a worker chat's turn may name no model in its message (live, 2026-10-26): its usage names the served one
  const servedModel = (ownTurn?.usage as { model?: unknown } | undefined)?.model;
  const ownModel = ownSelection?.id ?? (typeof servedModel === "string" && servedModel.trim() !== "" ? servedModel : undefined);
  // the host files a subagent's effort on its turn's usage (subagent.configured), else it is in the model's config
  const configured = (ownTurn?.usage as { _meta?: Record<string, unknown> } | undefined)?._meta?.["vscode.modelConfiguration"];
  const metaEffort = isRecord(configured) && typeof configured["reasoningEffort"] === "string" && configured["reasoningEffort"].trim() !== "" ? configured["reasoningEffort"] : null;
  const ownEffort = metaEffort ?? effortOfSelection(ownSelection as { config?: Record<string, unknown> } | undefined);
  const activity = own && status === "running" ? activityOf(own) : undefined;
  const started = timing?.started ?? turn.times.started;
  return {
    kind: "subagent",
    id: tool.toolCallId,
    agent: subagent.agentName ?? subagent.title,
    // the call's intent ("Fix the login bug"), as VS Code's row reads; the host's is the agent's own blurb
    description: intent ?? subagent.description ?? "",
    ...(intent !== null && subagent.description && subagent.description.trim() !== intent ? { about: subagent.description } : {}),
    ...(background || (status === "running" && settled(tool)) ? { background: true as const } : {}),
    model: ownModel !== undefined && shownModel(ownModel) ? `${servedName(ownModel, turn.context!)}${ownEffort !== null ? ` · ${ownEffort}` : ""}` : null,
    started,
    ended: status === "running" ? null : timing?.started ? timing.ended ?? turn.times.ended : turn.times.ended,
    status,
    chat: subagent.resource,
    ...(activity !== undefined ? { activity } : {}),
  };
}

/** A call that is not done, as the summary counts it (VS Code's skipped, denied and unfinished); none once completed. */
function stateOf(tool: ToolCallState): Extract<ConversationPart, { kind: "tool" }>["state"] {
  switch (tool.status) {
    case ToolCallStatus.Completed: return undefined;
    case ToolCallStatus.Cancelled: return tool.reason === ToolCallCancellationReason.Skipped ? "skipped" : "denied";
    case ToolCallStatus.PendingConfirmation:
    case ToolCallStatus.PendingResultConfirmation: return "awaiting";
    default: return "running";
  }
}

/**
 * The command line a terminal call ran, as VS Code's getTerminalInput reads it: the input's
 * `command`, else the whole input. The terminal content's title is the host's label for it.
 */
function commandLine(input: string): string | null {
  if (input.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(input);
    const command = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["command"] : undefined;
    return typeof command === "string" && command.trim() !== "" ? command : input;
  } catch {
    return input;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The ask tools a Copilot chat asks through: VS Code's ask_user and TaskSync's askUser. */
const ASK_TOOLS = new Set(["ask_user", "askUser"]);
// TaskSync appends its own reminder to the answer, after a blank line
const ASK_REMINDER = /\n\n(?:REQUIRED:|TaskSync assigned )[\s\S]*$/;

/** A line of markdown as plain words: emphasis, code ticks and a heading's or list's mark dropped. */
const plainLine = (line: string): string => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2").trim();

/**
 * A finished ask call as the question it was (QuestionSummary): its first line is the question, the
 * whole message the report it carried, kept when it holds more than that line; the answer as the
 * tool returned it. null while it runs (the prompt card asks it) or for an input it cannot read.
 */
function askPart(tool: ToolCallState, content: ToolResultContent[]): Extract<ConversationPart, { kind: "question" }> | null {
  if (!ASK_TOOLS.has(tool.toolName) || tool.status !== ToolCallStatus.Completed) return null;
  let input: unknown;
  try { input = JSON.parse("toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : ""); } catch { return null; }
  if (!isRecord(input)) return null;
  const message = typeof input["message"] === "string" ? input["message"] : typeof input["question"] === "string" ? input["question"] : "";
  const lines = message.split("\n").map(plainLine).filter((line) => line !== "");
  const text = lines[0] ?? "";
  const out = content.flatMap((item) => (item.type === ToolResultContentType.Text ? [item.text] : [])).join("\n").trim();
  const base = { kind: "question" as const, text, ...(lines.length > 1 ? { report: message } : {}), options: [], chosen: [] };
  const answer = tool.success === false || /^User (?:cancelled|declined|dismissed)\b/.test(out) ? null : answerOf(out);
  return answer === null ? { ...base, custom: null, skipped: true } : withUploads({ ...base, custom: answer, skipped: false });
}

/**
 * A picture this app uploaded for an answer: `@<folder>/.ovis/<name>` (lib/promptAnswer.ts), or
 * `.herdr-web-ui/` in a chat answered before the rename.
 */
const ANSWER_UPLOAD = /(?:^|\s)@(\S*\/\.(?:ovis|herdr-web-ui)\/([^\s/]+\.(png|jpe?g|gif|webp)))(?=\s|,|$)/gi;
const UPLOAD_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The ref an answer's uploaded picture is read by: `answer:<its file name>` (routes.ts readImage). */
export const ANSWER_REF = "answer:";

/**
 * A typed answer's uploaded pictures as images, and the answer without their paths: the path is
 * how the agent finds the file, not words for the user to read (VS Code shows its attachments).
 */
function withUploads<T extends Extract<ConversationPart, { kind: "question" }>>(part: T): T {
  if (part.custom === null) return part;
  const images = [...part.custom.matchAll(ANSWER_UPLOAD)].map((match) => ({ media_type: UPLOAD_TYPES[match[3]!.toLowerCase()]!, ref: `${ANSWER_REF}${match[2]}` }));
  if (images.length === 0) return part;
  // a form field the pictures were its whole answer to ("notes:") says nothing left alone
  const words = part.custom.replace(ANSWER_UPLOAD, "").replace(/\s{2,}/g, " ").split(/,\s*/).map((each) => each.trim())
    .filter((each) => each !== "" && !/^[^:]+:$/.test(each)).join(", ");
  return { ...part, custom: words === "" ? null : words, images };
}

/** The user's words in an ask tool's result: VS Code's "User responded:" field lines, or TaskSync's JSON. */
function answerOf(out: string): string | null {
  if (out.startsWith("User responded:")) {
    const fields = out.slice("User responded:".length).split("\n").map((line) => line.trim()).filter((line) => line !== "" && !/:\s*$/.test(line));
    return fields.length > 0 ? fields.join(", ") : null;
  }
  try {
    const parsed: unknown = JSON.parse(out);
    if (isRecord(parsed) && typeof parsed["response"] === "string") return parsed["response"].replace(ASK_REMINDER, "").trim() || null;
  } catch { /* plain text */ }
  return out === "" ? null : out;
}

function toolPart(tool: ToolCallState, turn: TurnRead): ConversationPart {
  const content = contentOf(tool);
  const asked = askPart(tool, content);
  if (asked) return asked;
  const subagent = content.find((item): item is ToolResultSubagentContent => item.type === ToolResultContentType.Subagent);
  if (subagent) return subagentPart(tool, subagent, turn);
  const state = stateOf(tool);
  const input = "toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : "";
  const terminal = content.find((item): item is ToolResultTerminalContent => item.type === ToolResultContentType.Terminal);
  const exitCode = terminal?.result?.exitCode;
  const images = imagesOf(tool).map((image, index) => ({ media_type: image.contentType, ref: `${tool.toolCallId}:${index}` }));
  const edits = content.filter((item): item is ToolResultFileEditContent => item.type === ToolResultContentType.FileEdit)
    .map((item, index) => shownEdit(item, `${tool.toolCallId}:${index}`));
  const part: Extract<ConversationPart, { kind: "tool" }> = {
    kind: "tool",
    name: tool.displayName,
    tool_id: tool.toolName,
    summary: plain(tool.invocationMessage),
    ...("pastTenseMessage" in tool ? { past: plain(tool.pastTenseMessage) } : {}),
    input,
    output: "",
    error: ("success" in tool && tool.success === false) || (exitCode !== undefined && exitCode !== 0),
    ...(terminal && commandLine(input) !== null ? { command: commandLine(input)! } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(edits.length > 0 ? { edits } : {}),
    ...(tool.intention ? { intention: tool.intention } : {}),
    ...(state !== undefined ? { state } : {}),
  };
  // the cut the pane readers make; the rest is GET /api/host-chats/tool-output?ref=<the call's id>
  trimOutput(part, toolOutput(tool), tool.toolCallId);
  return part;
}

function optionLabel(question: ChatInputQuestion, id: string): string {
  const options = "options" in question ? question.options : [];
  return options.find((option) => option.id === id)?.label ?? id;
}

const YES = "Yes";
const NO = "No";

/** The choices a question offered, by label: a yes-or-no question's are Yes and No. */
function offered(question: ChatInputQuestion): string[] {
  if ("options" in question) return question.options.map((option) => option.label);
  return question.kind === ChatInputQuestionKind.Boolean ? [YES, NO] : [];
}

const joined = (values: string[] | undefined): string | null => {
  const text = (values ?? []).filter((value) => value !== "").join(", ");
  return text === "" ? null : text;
};

/**
 * One answered (or skipped) question as the history reads it back. A draft counts once the request
 * was accepted with it; a question with no answer in a request that is over was skipped.
 */
function questionPart(question: ChatInputQuestion, answer: ChatInputAnswer | undefined, accepted: boolean): ConversationPart {
  const base = { kind: "question" as const, text: question.message, options: offered(question) };
  const given = answer && answer.state !== ChatInputAnswerState.Skipped && (answer.state === ChatInputAnswerState.Submitted || accepted) ? answer : undefined;
  if (!given) {
    return { ...base, chosen: [], custom: joined(answer?.state === ChatInputAnswerState.Skipped ? answer.freeformValues : undefined), skipped: true };
  }
  const value = given.value;
  switch (value.kind) {
    case ChatInputAnswerValueKind.Selected:
      return { ...base, chosen: value.value ? [optionLabel(question, value.value)] : [], custom: joined(value.freeformValues), skipped: false };
    case ChatInputAnswerValueKind.SelectedMany:
      return { ...base, chosen: value.value.map((id) => optionLabel(question, id)), custom: joined(value.freeformValues), skipped: false, multi: true };
    case ChatInputAnswerValueKind.Boolean:
      return { ...base, chosen: [value.value ? YES : NO], custom: null, skipped: false };
    default:
      return { ...base, chosen: [], custom: String(value.value), skipped: false };
  }
}

/**
 * An input request that is over, one part per question. One still open (no response, in the
 * running turn) is no history yet: the prompt card asks it (promptFrom).
 */
function questionParts(part: InputRequestResponsePart, running: boolean): ConversationPart[] {
  if (part.response === undefined && running) return [];
  const request = part.request;
  const accepted = part.response === ChatInputResponseKind.Accept;
  const questions = request.questions ?? [];
  if (questions.length === 0) {
    return [{ kind: "question", text: request.message ?? "", options: [], chosen: [], custom: null, skipped: !accepted }];
  }
  // the message a form came with (an ask_user report) leads the first question, once for the form
  const report = request.message !== undefined && request.message.trim() !== "" ? { report: request.message } : {};
  return questions.map((question, index) => withUploads({ ...questionPart(question, request.answers?.[question.id], accepted), ...(index === 0 ? report : {}) } as Extract<ConversationPart, { kind: "question" }>));
}

/**
 * The ask calls whose form the turn also holds as an input request (VS Code's ask_user with a
 * requestedSchema): that request reads as the report and its questions, so the call adds nothing.
 */
function askedThroughForm(parts: readonly ResponsePart[]): Set<string> {
  const messages = new Set(parts.flatMap((part) => part.kind === ResponsePartKind.InputRequest && (part.request.questions?.length ?? 0) > 0 && part.request.message ? [part.request.message] : []));
  return new Set(parts.flatMap((part) => {
    if (part.kind !== ResponsePartKind.ToolCall || !ASK_TOOLS.has(part.toolCall.toolName)) return [];
    try {
      const input: unknown = JSON.parse("toolInput" in part.toolCall && typeof part.toolCall.toolInput === "string" ? part.toolCall.toolInput : "");
      return isRecord(input) && typeof input["message"] === "string" && messages.has(input["message"]) ? [part.toolCall.toolCallId] : [];
    } catch { return []; }
  }));
}

/**
 * A reference to content elsewhere, as a markdown link named by its last path segment (a file:// one
 * reads as a file pill). The destination has its space, `(`, `)`, `<` and `>` percent-encoded: no
 * such character can end the link early, and the app's markdown reads no `<…>` destination.
 */
function linkTo(uri: string): string {
  let name = "";
  try { name = decodeURIComponent(new URL(uri).pathname.replace(/\/+$/, "").split("/").at(-1) ?? ""); } catch { /* the uri itself */ }
  const destination = uri.replace(/[\s()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${(name || uri).replace(/[[\]]/g, "\\$&")}](${destination})`;
}

function partsOf(part: ResponsePart, turn: TurnRead): ConversationPart[] {
  switch (part.kind) {
    case ResponsePartKind.Markdown: return [{ kind: "text", text: part.content }];
    case ResponsePartKind.Reasoning: return [{ kind: "thinking", text: part.content }];
    case ResponsePartKind.ToolCall: return [toolPart(part.toolCall, turn)];
    case ResponsePartKind.InputRequest: return questionParts(part, turn.running);
    case ResponsePartKind.ContentRef: return [{ kind: "text", text: linkTo(part.uri) }];
    case ResponsePartKind.SystemNotification: return [{ kind: "notice", text: plain(part.content), source: "system" }];
    default: return [];
  }
}

function endOf(turn: Turn | ActiveTurn): string | undefined {
  if (!("duration" in turn) || turn.duration === undefined || !turn.startedAt) return undefined;
  const start = Date.parse(turn.startedAt);
  return Number.isNaN(start) ? undefined : new Date(start + turn.duration).toISOString();
}

/** Each AHP turn as a user turn and an assistant turn; the running turn last. */
export function turnsFrom(chat: ChatState, context?: ReadContext): ConversationTurn[] {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  return all.flatMap((turn) => {
    const ts = turn.startedAt ?? null;
    const end = endOf(turn);
    const running = turn === chat.activeTurn;
    const read: TurnRead = { times: { started: ts, ended: end ?? null }, running, model: turn.message.model?.id ?? null, context };
    // VS Code's getTurnError: only the error a turn ended on is shown, and only the latest turn's
    // resumable one offers Try Again (chat/turnResume); an error the host retried past is history
    const stoppedAt = "state" in turn && turn.state === TurnState.Error ? turn.responseParts.at(-1) : undefined;
    const latest = !chat.activeTurn && turn === chat.turns.at(-1);
    const viaForm = askedThroughForm(turn.responseParts);
    const parts = turn.responseParts.flatMap((part): ConversationPart[] => part.kind === ResponsePartKind.ToolCall && viaForm.has(part.toolCall.toolCallId) ? []
      : part.kind !== ResponsePartKind.Error ? partsOf(part, read)
      : part !== stoppedAt ? []
        : [{ kind: "notice", text: part.error.message, source: "error", ...(latest && part.resumable === true ? { resumable: true as const } : {}) }]);
    return [
      { role: "user" as const, ts, parts: [{ kind: "text" as const, text: turn.message.text }, ...userImagesOf(turn.message).map((image, index) => ({ kind: "image" as const, media_type: image.media_type, ref: `${USER_REF}${turn.id}:${index}` }))] },
      { role: "assistant" as const, ts, ...(end ? { end_ts: end } : {}), parts, ...(read.model !== null ? { model: context?.modelName(read.model) ?? read.model } : {}) },
    ];
  });
}

/** A user image's ref is `turn:<turnId>:<index>`; a tool's is `<toolCallId>:<index>`. */
const USER_REF = "turn:";

/**
 * The images a user message carried, in order: the index in its ref counts these alone. One the
 * phone sent is embedded; one VS Code pasted or snapshotted is a file the host keeps (a resource
 * with displayKind image), read through the host when shown. Its type: the snapshot's own, else
 * the file's extension; an image of a type a browser may not draw is left out.
 */
type UserImage = { media_type: string; data: string } | { media_type: string; uri: string };
function userImagesOf(message: Message): UserImage[] {
  return (message.attachments ?? []).flatMap((each): UserImage[] => {
    if (each.type === MessageAttachmentKind.EmbeddedResource) return IMAGE_TYPES.has(each.contentType) ? [{ media_type: each.contentType, data: each.data }] : [];
    if (each.type !== MessageAttachmentKind.Resource || each.displayKind !== "image") return [];
    const snapshot = (each._meta as Record<string, { contentType?: unknown } | undefined> | undefined)?.[SNAPSHOT_META]?.contentType;
    const type = normalImageType(typeof snapshot === "string" ? snapshot : each.contentType) ?? imageTypeOfPath(each.uri);
    return type ? [{ media_type: type, uri: each.uri }] : [];
  });
}

const SNAPSHOT_META = "vscode.agentHost.snapshotAttachment";
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** `image/jpg` (VS Code's snapshot says so) is `image/jpeg`; any type not drawn here is none. */
function normalImageType(type: string | undefined): string | null {
  const lower = type?.toLowerCase();
  const normal = lower === "image/jpg" ? "image/jpeg" : lower;
  return normal && IMAGE_TYPES.has(normal) ? normal : null;
}
function imageTypeOfPath(uri: string): string | null {
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri);
  return match ? IMAGE_EXTENSIONS[match[1]!.toLowerCase()] ?? null : null;
}

/** A tool call of the chat by its id, in any turn it holds. */
function toolCallOf(chat: ChatState, toolCallId: string): ToolCallState | undefined {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  for (const turn of all) {
    for (const part of turn.responseParts) {
      if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId) return part.toolCall;
    }
  }
  return undefined;
}

/**
 * The image a part's ref (`<toolCallId>:<index>`) names, its bytes decoded from the mirror's copy;
 * null for a ref the chat has no image under.
 */
export function imageOf(chat: ChatState, ref: string): { media_type: string; bytes: Buffer } | { media_type: string; uri: string } | null {
  const at = ref.lastIndexOf(":");
  const digits = at < 0 ? "" : ref.slice(at + 1);
  // one spelling per image: `c1:0`, never `c1:`, `c1:00` or `c1:0x0`
  if (!/^(?:0|[1-9]\d*)$/.test(digits)) return null;
  const index = Number(digits);
  if (ref.startsWith(USER_REF)) {
    const id = ref.slice(USER_REF.length, at);
    const turn = (chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns).find((each) => each.id === id);
    const attached = turn ? userImagesOf(turn.message)[index] : undefined;
    if (!attached) return null;
    return "uri" in attached ? attached : { media_type: attached.media_type, bytes: Buffer.from(attached.data, "base64") };
  }
  const tool = toolCallOf(chat, ref.slice(0, at));
  const image = tool ? imagesOf(tool)[index] : undefined;
  if (!tool || !image) return null;
  return { media_type: image.contentType, bytes: Buffer.from(image.data, "base64") };
}

/** The whole output of the call an `output_ref` (its id) names; null for a call the chat does not hold. */
export function toolOutputOf(chat: ChatState, ref: string): string | null {
  const tool = toolCallOf(chat, ref);
  return tool ? toolOutput(tool) : null;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const submitted = (answer: ChatInputAnswer | undefined): boolean => answer?.state === ChatInputAnswerState.Submitted;
/** done with for the form: answered, or passed over with Skip */
export const answerSettled = (answer: ChatInputAnswer | undefined): boolean => submitted(answer) || answer?.state === ChatInputAnswerState.Skipped;

/** The question an open request asks now: its first one without a submitted answer. */
export function currentQuestion(request: ChatInputRequest): ChatInputQuestion | undefined {
  return (request.questions ?? []).find((question) => !answerSettled(request.answers?.[question.id]));
}

/** The chats the chat's subagent calls started, newest last: the bridge subscribes them to read their model and times. */
export function subagentChats(chat: ChatState): string[] {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  const found = new Set<string>();
  for (const turn of all) {
    for (const part of turn.responseParts) {
      if (part.kind !== ResponsePartKind.ToolCall) continue;
      for (const item of contentOf(part.toolCall)) if (item.type === ToolResultContentType.Subagent) found.add(item.resource);
    }
  }
  return [...found];
}

/** The open (unanswered) input requests of the running turn, in order. */
export function openRequests(chat: ChatState): ChatInputRequest[] {
  return (chat.activeTurn?.responseParts ?? []).flatMap((part) =>
    part.kind === ResponsePartKind.InputRequest && part.response === undefined ? [part.request] : []);
}

/** The running turn's tool calls waiting for a yes or no. */
export function pendingToolCalls(chat: ChatState): ToolCallState[] {
  return (chat.activeTurn?.responseParts ?? []).flatMap((part) =>
    part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.PendingConfirmation ? [part.toolCall] : []);
}

/**
 * An option as the card draws it: VS Code's carousel reads a label "Title - Description" as a title
 * over its description (chatQuestionCarouselPart.ts), which is how ask_user's choices carry one; an
 * option with its own description keeps its label whole. The host's `recommended` is kept.
 */
function optionOf(option: { label: string; description?: string; recommended?: boolean }): InteractivePromptOption {
  const cut = option.description === undefined ? option.label.indexOf(" - ") : -1;
  const split = cut > 0 ? { label: option.label.slice(0, cut), description: option.label.slice(cut + 3) } : { label: option.label, description: option.description ?? null };
  return option.recommended === true ? { ...split, recommended: true } : split;
}

/** The prompt's options and, parallel to them, the host's option ids. */
function questionOptions(question: ChatInputQuestion): { options: InteractivePromptOption[]; ids: string[]; custom: number | null } {
  switch (question.kind) {
    case ChatInputQuestionKind.SingleSelect:
    case ChatInputQuestionKind.MultiSelect: {
      const options = question.options.map(optionOf);
      const ids = question.options.map((option) => option.id);
      // VS Code's rule (chatQuestionCarouselPart.ts at 6d62b1d): a typed answer unless the question says no
      if (question.allowFreeformInput === false) return { options, ids, custom: null };
      return { options: [...options, { label: OTHER_LABEL, description: null }], ids: [...ids, NO_ID], custom: options.length };
    }
    case ChatInputQuestionKind.Boolean:
      return { options: [{ label: YES, description: null }, { label: NO, description: null }], ids: ["true", "false"], custom: null };
    default:
      return { options: [{ label: ANSWER_LABEL, description: null }], ids: [NO_ID], custom: 0 };
  }
}

/**
 * The option each ask_user field recommends, by field id: its schema's `default`. The host turns a
 * form's fields into questions and drops the default on the way (agentHostMain rbe, VS Code 1.142),
 * so the call's own input is read: the ask call whose message is the request's. Models mark their
 * pick this way far more often than in a label (owner's chats, 2026-10-25: 528 of 594 choice fields
 * had a default, 39 said "Recommended" in a label).
 */
function schemaDefaults(parts: readonly ResponsePart[], request: ChatInputRequest): Map<string, string> {
  const found = new Map<string, string>();
  if (!request.message) return found;
  for (const part of parts) {
    if (part.kind !== ResponsePartKind.ToolCall || !ASK_TOOLS.has(part.toolCall.toolName)) continue;
    let input: unknown;
    try { input = JSON.parse("toolInput" in part.toolCall && typeof part.toolCall.toolInput === "string" ? part.toolCall.toolInput : ""); } catch { continue; }
    if (!isRecord(input) || input["message"] !== request.message) continue;
    let schema = input["requestedSchema"];
    if (typeof schema === "string") { try { schema = JSON.parse(schema); } catch { continue; } }
    const properties = isRecord(schema) ? schema["properties"] : undefined;
    if (!isRecord(properties)) continue;
    for (const [id, field] of Object.entries(properties)) {
      if (isRecord(field) && typeof field["default"] === "string") found.set(id, field["default"]);
    }
  }
  return found;
}

/** The question's options with its recommended one marked, as the field's default names it by option id. */
function questionOptionsWith(question: ChatInputQuestion, defaults: Map<string, string>): ReturnType<typeof questionOptions> {
  const own = questionOptions(question);
  const pick = defaults.get(question.id);
  const at = pick === undefined ? -1 : own.ids.indexOf(pick);
  if (at < 0 || at === own.custom) return own;
  return { ...own, options: own.options.map((option, index) => index === at ? { ...option, recommended: true } : option) };
}

function questionPrompt(request: ChatInputRequest, question: ChatInputQuestion, defaults: Map<string, string> = new Map()): NonNullable<HostChatRead["prompt"]> {
  const questions = request.questions ?? [];
  const { options, ids, custom } = questionOptionsWith(question, defaults);
  // several questions: the whole form, paged and answered on the phone (VS Code's carousel)
  const form = questions.length > 1 ? questions.map((each) => {
    const own = questionOptionsWith(each, defaults);
    return {
      read: { title: each.title ?? "", question: each.message, options: own.options, multi_select: each.kind === ChatInputQuestionKind.MultiSelect, custom_option_index: own.custom, required: each.required === true },
      ref: { question_id: each.id, option_ids: own.ids },
    };
  }) : null;
  return {
    id: form ? `${request.id}:form` : `${request.id}:${question.id}`,
    agent: PROMPT_AGENT,
    kind: "question",
    title: question.title ?? "",
    question: question.message,
    body: request.message ?? null,
    options,
    multi_select: question.kind === ChatInputQuestionKind.MultiSelect,
    custom_option_index: custom,
    ...(form ? { form: form.map((each) => each.read) } : {}),
    host: { request_id: request.id, question_id: question.id, option_ids: ids, ...(form ? { form: form.map((each) => each.ref) } : {}) },
  };
}

function approvalPrompt(turnId: string, tool: ToolCallState): NonNullable<HostChatRead["prompt"]> {
  const own = tool.status === ToolCallStatus.PendingConfirmation ? tool.options ?? [] : [];
  const choices = own.length > 0
    ? own.map((option) => ({ label: option.label, id: option.id, approves: option.kind === ConfirmationOptionKind.Approve }))
    : [{ label: "Approve", id: NO_ID, approves: true }, { label: "Deny", id: NO_ID, approves: false }];
  const title = tool.status === ToolCallStatus.PendingConfirmation ? plain(tool.confirmationTitle) : "";
  const input = "toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : null;
  return {
    id: `${turnId}:${tool.toolCallId}`,
    agent: PROMPT_AGENT,
    kind: "approval",
    title: title || tool.displayName,
    question: plain(tool.invocationMessage),
    body: input,
    options: choices.map((choice) => ({ label: choice.label, description: null })),
    multi_select: false,
    custom_option_index: null,
    host: { tool_call_id: tool.toolCallId, turn_id: turnId, option_ids: choices.map((c) => c.id), approves: choices.map((c) => c.approves) },
  };
}

/** What the running turn waits on: its first open question, else its first tool call to confirm. */
export function promptFrom(chat: ChatState): HostChatRead["prompt"] {
  const active = chat.activeTurn;
  if (!active) return null;
  for (const request of openRequests(chat)) {
    const question = currentQuestion(request);
    if (question) return questionPrompt(request, question, schemaDefaults(active.responseParts, request));
  }
  const tool = pendingToolCalls(chat)[0];
  return tool ? approvalPrompt(active.id, tool) : null;
}

// ─── Models and agents ───────────────────────────────────────────────────────

/** The reasoning-effort property of a model's configSchema: `thinkingLevel`, else its first enum. */
function effortsOf(schema: HostModelSchema | undefined): HostModel["efforts"] {
  const properties = schema?.properties ?? {};
  const named = properties["thinkingLevel"];
  const entry: [string, { enum?: unknown[]; default?: unknown }] | undefined = Array.isArray(named?.enum)
    ? ["thinkingLevel", named]
    : Object.entries(properties).find(([, property]) => Array.isArray(property.enum));
  if (!entry) return null;
  const values = (entry[1].enum ?? []).map(String);
  const fallback = entry[1].default;
  return typeof fallback === "string" && values.includes(fallback) ? { key: entry[0], values, default: fallback } : { key: entry[0], values };
}
type HostModelSchema = { properties?: Record<string, { enum?: unknown[]; default?: unknown }> };

/** Copilot's own models carry these in `_meta` (probed 2026-10-19, VS Code 1.142); a custom endpoint's carry none. */
const COPILOT_META = ["multiplierNumeric", "discountPercent", "category"];

/** Where the picker files a model (HostModel.group). */
export function modelGroup(id: string, meta: Record<string, unknown> | undefined): string {
  if (meta?.["modelGroupId"] === "copilot" || COPILOT_META.some((key) => key in (meta ?? {}))) return "copilot";
  const at = id.indexOf("/");
  return at > 0 ? id.slice(0, at) : "other";
}

export function modelsFrom(root: RootState): HostModel[] {
  const agent = root.agents.find((each) => each.provider === PROVIDER);
  return (agent?.models ?? []).map((model) => {
    const meta = (model as { _meta?: Record<string, unknown> })._meta;
    const multiplier = meta?.["multiplierNumeric"];
    const warning = meta?.["rowWarning"];
    return {
      id: model.id, name: model.name, provider: model.provider, efforts: effortsOf(model.configSchema), context: model.maxContextWindow ?? null,
      group: modelGroup(model.id, meta), multiplier: typeof multiplier === "number" ? multiplier : null, warning: typeof warning === "string" && warning.trim() !== "" ? warning : null,
    };
  });
}

/** Each model's answer budget (maxOutputTokens), for the context window's reserved band. */
export function modelOutputs(root: RootState): [string, number][] {
  const agent = root.agents.find((each) => each.provider === PROVIDER);
  return (agent?.models ?? []).flatMap((model) => typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0 ? [[model.id, model.maxOutputTokens] as [string, number]] : []);
}

/** A model choice on the wire: the effort goes under the model's own effort key. */
export function modelSelection(root: RootState, model: { id: string; effort?: string }): ModelSelection {
  const key = modelsFrom(root).find((each) => each.id === model.id)?.efforts?.key;
  return model.effort !== undefined && key ? { id: model.id, config: { [key]: model.effort } } : { id: model.id };
}

/** Enabled custom agents, top-level or inside an enabled container, once each. */
export function agentsFrom(session: SessionState | undefined): HostAgent[] {
  const found = new Map<string, HostAgent>();
  const visit = (entries: readonly unknown[]): void => {
    for (const raw of entries) {
      const entry = raw as Customization & { enabled?: boolean; description?: string; children?: unknown[] };
      if (entry.enabled === false) continue;
      if ((entry.type as string) === CustomizationType.Agent) {
        if (!found.has(entry.uri)) found.set(entry.uri, { uri: entry.uri, name: entry.name, description: entry.description ?? null });
      } else if (Array.isArray(entry.children)) {
        visit(entry.children);
      }
    }
  };
  visit(session?.customizations ?? []);
  return [...found.values()];
}

/** VS Code's isCustomizationEnabled: the first enablement decision, else enabled (and the older `enabled: false`). */
function enabled(entry: { enabled?: boolean; enablement?: readonly { enabled?: boolean }[] }): boolean {
  return entry.enabled !== false && (entry.enablement?.[0]?.enabled ?? true);
}

const COMMAND_KINDS: Record<string, HostCommand["kind"]> = { [CustomizationType.Skill]: "skill", [CustomizationType.Prompt]: "prompt", [CustomizationType.Agent]: "agent" };

/** The session's skills, prompts and custom agents, enabled ones, each name once: a host chat's "/" commands. */
export function commandsFrom(session: SessionState | undefined): HostCommand[] {
  const found = new Map<string, HostCommand>();
  const visit = (entries: readonly unknown[]): void => {
    for (const raw of entries) {
      const entry = raw as Customization & { enabled?: boolean; enablement?: { enabled?: boolean }[]; description?: string; children?: unknown[] };
      if (!enabled(entry)) continue;
      const kind = COMMAND_KINDS[entry.type as string];
      if (kind) { if (!found.has(entry.name)) found.set(entry.name, { name: entry.name, description: entry.description ?? "", kind }); }
      else if (Array.isArray(entry.children)) visit(entry.children);
    }
  };
  visit(session?.customizations ?? []);
  return [...found.values()];
}

/**
 * The skills in a host's answer to `completions` for "/": the items VS Code marks `isSkill`
 * (copilotcli's runtime list, which holds the plugins' skills the customizations leave out).
 */
export function skillsFrom(items: readonly unknown[]): HostCommand[] {
  const found = new Map<string, HostCommand>();
  for (const raw of items) {
    const meta = (raw as { attachment?: { _meta?: { command?: unknown; isSkill?: unknown; description?: unknown } } }).attachment?._meta;
    if (meta?.isSkill !== true || typeof meta.command !== "string" || meta.command === "" || found.has(meta.command)) continue;
    found.set(meta.command, { name: meta.command, description: typeof meta.description === "string" ? meta.description : "", kind: "skill" });
  }
  return [...found.values()];
}

/** The customizations' commands, then the skills only the completions name. */
function withSkills(commands: HostCommand[], skills: readonly HostCommand[]): HostCommand[] {
  const named = new Set(commands.map((each) => each.name));
  return [...commands, ...skills.filter((each) => !named.has(each.name))];
}

// ─── A chat, read ────────────────────────────────────────────────────────────

/** The newest turn's model (its effort read from the config's one value), else the draft's. */
function modelOf(chat: ChatState): HostChatRead["model"] {
  const newest = chat.activeTurn ?? chat.turns.at(-1);
  const selection = newest?.message.model ?? chat.draft?.model;
  if (!selection) return null;
  return { id: selection.id, effort: effortOfSelection(selection as { config?: Record<string, unknown> }) };
}

/** The chat's background work by kind (AHP lists only work still running). */
function backgroundOf(chat: ChatState): HostChatRead["background"] {
  const work = (chat as { backgroundWork?: { kind: string }[] }).backgroundWork ?? [];
  return { subagents: work.filter((each) => each.kind === "subagent").length, commands: work.filter((each) => each.kind === "shell").length };
}

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * The context window Copilot reports on the session (`_meta["copilot.usageInfo"]`), by VS Code's
 * rules (copilotdMetadataReader readCopilotContextUsage): whole token counts, a limit above 0 and a
 * message count, else nothing; an optional count that is not a whole number is left out.
 */
/**
 * The context the newest turn's model call filled, as the host attributes it (`usage._meta.
 * contextAttribution`: totalTokens of limit, by category). VS Code reads this before the session's
 * usage info (agentUsageMeta.ts readAgentContextUsage); Copilot CLI hosts now report only this.
 */
function attributedContext(turn: Turn | ActiveTurn | undefined): HostContextUsage | null {
  const meta = (turn?.usage as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const value = meta?.["contextAttribution"];
  if (typeof value !== "object" || value === null) return null;
  const attribution = value as Record<string, unknown>;
  const currentTokens = count(attribution["totalTokens"]);
  const tokenLimit = count(attribution["limit"]) ?? count(attribution["promptTokenLimit"]);
  if (currentTokens === undefined || tokenLimit === undefined || tokenLimit === 0) return null;
  const usage: HostContextUsage = { currentTokens, tokenLimit };
  const categories = typeof attribution["categories"] === "object" && attribution["categories"] !== null ? attribution["categories"] as Record<string, unknown> : {};
  const messages = count(categories["messages"]);
  const system = count(categories["systemPrompt"]);
  const tools = [count(categories["systemTools"]), count(categories["mcpTools"])];
  if (messages !== undefined) usage.conversationTokens = messages;
  if (system !== undefined) usage.systemTokens = system;
  if (tools.some((each) => each !== undefined)) usage.toolDefinitionsTokens = tools.reduce<number>((sum, each) => sum + (each ?? 0), 0);
  const parts = attributedParts(attribution, currentTokens);
  if (parts.length > 0) usage.parts = parts;
  const buffer = count(attribution["bufferTokens"]);
  if (buffer !== undefined && buffer > 0) usage.reservedTokens = buffer;
  return usage;
}

/** VS Code's row names for a kind summed into one row (stateToProgressAdapter kindToAggregateLabel). */
const KIND_LABEL: Record<string, string> = {
  tool: "Tool Results", toolDefinition: "Tool Definitions", skill: "Skills", subagent: "Sub-agents", mcpServer: "MCP Tools", plugin: "Plugins",
};

/**
 * VS Code's breakdown of the attribution's entries (contextAttributionToPromptTokenDetails): a
 * `system` entry is its own row unless it is a parent (its children are summed instead), every
 * other kind is summed into one row, and what no entry covers is "Messages". Each row is a percent
 * of the prompt to one decimal, rows under 0.1% left out: whole percents (VS Code's rounding) could
 * add to more than 100 and leave the popup no room for its "Other" row.
 */
function attributedParts(attribution: Record<string, unknown>, total: number): NonNullable<HostContextUsage["parts"]> {
  const raw = Array.isArray(attribution["entries"]) ? attribution["entries"] : [];
  const entries = raw.flatMap((each): { kind: string; id: string; label: string; tokens: number; parent?: string }[] => {
    if (typeof each !== "object" || each === null) return [];
    const entry = each as Record<string, unknown>;
    const tokens = count(entry["tokens"]);
    if (typeof entry["kind"] !== "string" || typeof entry["id"] !== "string" || typeof entry["label"] !== "string" || tokens === undefined) return [];
    return [{ kind: entry["kind"], id: entry["id"], label: entry["label"], tokens, ...(typeof entry["parentId"] === "string" ? { parent: entry["parentId"] } : {}) }];
  });
  if (total <= 0 || entries.length === 0) return [];
  const parents = new Set(entries.flatMap((entry) => entry.parent ? [entry.parent] : []));
  const share = (tokens: number): number => Math.round((tokens / total) * 1000) / 10;
  const rows: NonNullable<HostContextUsage["parts"]> = [];
  const kinds = new Map<string, number>();
  let accounted = 0;
  for (const entry of entries) {
    if (entry.kind !== "system") { kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + entry.tokens); continue; }
    if (parents.has(entry.id)) continue;
    accounted += entry.tokens;
    if (share(entry.tokens) > 0) rows.push({ category: "system", label: entry.label, share: share(entry.tokens) });
  }
  for (const [kind, tokens] of kinds) {
    accounted += tokens;
    if (share(tokens) > 0) rows.push({ category: kind === "toolDefinition" ? "system" : "user", label: KIND_LABEL[kind] ?? kind, share: share(tokens) });
  }
  const messages = Math.max(0, total - accounted);
  if (share(messages) > 0) rows.push({ category: "user", label: "Messages", share: share(messages) });
  return rows;
}

/**
 * What VS Code's context meter shows for a turn the host attributed (chatContextUsageWidget
 * updateFromResponse): readAgentContextUsage gives nothing for such a turn, so the meter counts the
 * turn's own input and output tokens over the model's window (maxContextWindow). The attribution's
 * totalTokens is the CLI's running estimate and its limit the CLI's own prompt budget: on a long
 * chat it read 127% (509K / 400K) where VS Code showed 36% (192K / 528K). The breakdown keeps the
 * attribution's shares, scaled to the tokens used. Null when the model or the counts are unknown.
 */
function meteredContext(turn: Turn | ActiveTurn | undefined, attributed: HostContextUsage, window: ((id: string) => number | null) | undefined, budgetOf?: (id: string) => number | null): HostContextUsage | null {
  const model = turn?.message.model?.id;
  const limit = model && window ? window(model) : null;
  const input = count(turn?.usage?.inputTokens);
  const output = count(turn?.usage?.outputTokens) ?? 0;
  if (limit === null || limit <= 0 || input === undefined) return null;
  const used = input + output;
  const usage: HostContextUsage = { currentTokens: used, tokenLimit: limit };
  const scale = (part: number | undefined): number | undefined => part === undefined ? undefined : Math.floor((part / attributed.currentTokens) * used);
  for (const key of ["conversationTokens", "systemTokens", "toolDefinitionsTokens"] as const) {
    const each = attributed.currentTokens > 0 ? scale(attributed[key]) : undefined;
    if (each !== undefined) usage[key] = each;
  }
  // the shares are of the prompt, whichever count it is read by
  if (attributed.parts) usage.parts = attributed.parts;
  // VS Code's band: the model's answer budget less what the turn already wrote (chatContextUsageWidget)
  const budget = model && budgetOf ? budgetOf(model) : null;
  const reserved = budget !== null ? Math.max(0, budget - (count(turn?.usage?.outputTokens) ?? 0)) : attributed.reservedTokens;
  if (reserved !== undefined && reserved > 0) usage.reservedTokens = reserved;
  return usage;
}

export function contextUsageOf(session: SessionState | undefined, newest?: Turn | ActiveTurn, window?: (id: string) => number | null, output?: (id: string) => number | null): HostContextUsage | null {
  const attributed = attributedContext(newest);
  if (attributed !== null) return meteredContext(newest, attributed, window, output) ?? attributed;
  const info = (session as { _meta?: Record<string, unknown> } | undefined)?._meta?.["copilot.usageInfo"];
  if (typeof info !== "object" || info === null) return null;
  const value = info as Record<string, unknown>;
  const currentTokens = count(value["currentTokens"]);
  const tokenLimit = count(value["tokenLimit"]);
  if (currentTokens === undefined || tokenLimit === undefined || tokenLimit === 0 || count(value["messagesLength"]) === undefined) return null;
  const usage: HostContextUsage = { currentTokens, tokenLimit };
  for (const key of ["conversationTokens", "systemTokens", "toolDefinitionsTokens"] as const) {
    const each = count(value[key]);
    if (each !== undefined) usage[key] = each;
  }
  return usage;
}

/**
 * The chat's waiting messages, each once. VS Code's host keeps its steer in `steeringMessage` and
 * also in `queuedMessages` with `kind: "steering"` (its reducer's pendingMessageSet), so an entry
 * of that kind, or the steer's own id, is the Steering row and not a second, queued one.
 */
function pendingOf(chat: ChatState): NonNullable<HostChatRead["pending"]> {
  const steer = chat.steeringMessage;
  const queue = (chat.queuedMessages ?? []) as readonly (PendingMessage & { kind?: string })[];
  const steers = [...(steer ? [steer] : []), ...queue.filter((each) => each.kind === "steering" && each.id !== steer?.id)];
  const queued = queue.filter((each) => each.kind !== "steering" && each.id !== steer?.id);
  return [
    ...steers.map((each) => ({ id: each.id, kind: "steering" as const, text: each.message.text })),
    ...queued.map((each) => ({ id: each.id, kind: "queued" as const, text: each.message.text })),
  ];
}

/**
 * What the chat's loaded turns spent, by model: each turn's `turnTokenTotals` (VS Code's, sub-agents
 * included; per turn, not running). Partial when older turns are still to load, or a finished
 * turn reported none (a host that restarted keeps no usage of its own), so a sum is a floor.
 */
export function tokensOf(chat: ChatState): NonNullable<HostChatRead["tokens"]> {
  const sums = new Map<string, HostTokenTotal>();
  let missing = chat.turnsNextCursor != null;
  for (const turn of [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]) {
    const totals = (turn.usage as { _meta?: Record<string, unknown> } | undefined)?._meta?.["turnTokenTotals"];
    if (!Array.isArray(totals)) { if (turn !== chat.activeTurn) missing = true; continue; }
    for (const each of totals) {
      if (typeof each !== "object" || each === null) continue;
      const total = each as Record<string, unknown>;
      const model = total["model"];
      const input = count(total["inputTokens"]); const cached = count(total["cachedTokens"]) ?? 0; const output = count(total["outputTokens"]) ?? 0;
      if (typeof model !== "string" || model === "" || input === undefined) continue;
      const sum = sums.get(model) ?? { model, input: 0, cached: 0, output: 0 };
      sums.set(model, { model, input: sum.input + input, cached: sum.cached + cached, output: sum.output + output });
    }
  }
  return { totals: [...sums.values()], partial: missing };
}

export function readFrom(session: string, title: string, chat: ChatState, context?: ReadContext, restored: HostChatRead["restored"] = null): HostChatRead {
  const prompt = promptFrom(chat);
  const newest = chat.activeTurn ?? chat.turns.at(-1);
  const status = statusOf(chat.status);
  const turns = turnsFrom(chat, context);
  const read: Omit<HostChatRead, "signature"> = {
    session,
    // the session's title, the one the list shows and a rename sets (the host leaves the chat's own as it was)
    title: title || chat.title,
    status,
    turns,
    cursor: chat.turnsNextCursor ?? null,
    prompt,
    model: modelOf(chat),
    agent: newest?.message.agent?.uri ?? null,
    busy: chat.activeTurn !== undefined,
    commands: withSkills(commandsFrom(context?.session?.()), context?.skills?.() ?? []),
    background: backgroundOf(chat),
    work: workOf((chat as { backgroundWork?: readonly unknown[] }).backgroundWork),
    artifacts: artifactsOf((context?.session?.() as { _meta?: Record<string, unknown> } | undefined)?._meta),
    confirmations: pendingToolCalls(chat).length,
    // the running turn may have no usage yet: the newest turn that reported one
    context: contextUsageOf(context?.session?.(), [...(chat.activeTurn ? [chat.activeTurn] : []), ...[...chat.turns].reverse()].find((turn) => attributedContext(turn) !== null), context?.modelWindow, context?.modelOutput),
    tokens: tokensOf(chat),
    pending: pendingOf(chat),
    message_ids: [
      ...chat.turns.map((turn) => turn.id), ...(chat.activeTurn ? [chat.activeTurn.id] : []),
      ...pendingOf(chat).map((pending) => pending.id),
    ],
    checkpoints: checkpointsOf(chat),
    restored,
  };
  // as VS Code's list: it starts over at each message, so the newest turn's start cuts it (todosSince)
  const lastTurn = chat.turns.at(-1);
  const since = Date.parse(chat.activeTurn?.startedAt ?? lastTurn?.startedAt ?? "");
  const stopped = chat.activeTurn === undefined && lastTurn !== undefined && "state" in lastTurn && lastTurn.state === TurnState.Cancelled;
  const stored = context?.todos?.() ?? null;
  const todos = stored === null ? null : todosSince(stored, Number.isFinite(since) ? since : null, stopped);
  if (todos !== null && todos.length > 0) read.todos = todos;
  const shape = [
    read.title, read.status,
    chat.turns.map((turn) => [turn.id, JSON.stringify(turn.responseParts).length]),
    chat.activeTurn ? [chat.activeTurn.id, chat.activeTurn.responseParts.length, JSON.stringify(chat.activeTurn.responseParts).length] : null,
    prompt?.id ?? null, prompt?.steps ?? null, read.cursor, read.model, read.agent, read.message_ids, read.pending, read.commands,
    read.background, read.work, read.artifacts, read.confirmations, read.context, read.tokens, read.restored, read.todos ?? null,
    // what a subagent's own chat adds (its model, times, activity) is not in this chat's parts
    turns.flatMap((each) => each.parts.filter((part) => part.kind === "subagent")),
  ];
  return { ...read, signature: createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 16) };
}
