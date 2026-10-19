/**
 * Pure mappers from the agent host's state (AHP) to what the phone draws: the chat list, a chat's
 * turns in herdr's conversation shape, the question or approval it waits on, and the models and
 * agents it can be sent with. No I/O; routes.ts feeds them the connection's mirror.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ChatInputAnswerState,
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
  type InputRequestResponsePart,
  type Message,
  type MessageEmbeddedResourceAttachment,
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
import type { ConversationPart, ConversationTurn, InteractivePromptOption } from "../../shared/protocol.ts";
import type { HostAgent, HostChatRead, HostChatRow, HostCommand, HostContextUsage, HostModel } from "../../shared/host-chats.ts";
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

function pathOf(uri: string | undefined): string | null {
  if (!uri?.startsWith("file:")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

/** The chat list: Copilot CLI sessions only, newest first. */
export function rowsFrom(summaries: SessionSummary[]): HostChatRow[] {
  return summaries
    .filter((summary) => summary.provider === PROVIDER)
    .map((summary) => ({
      session: summary.resource,
      title: summary.title,
      status: statusOf(summary.status),
      modified_at: summary.modifiedAt,
      cwd: pathOf(summary.workingDirectories?.[0] ?? summary.project?.uri),
      // the flags beside the activity bits (VS Code's isSessionStatusRead / isSessionStatusArchived)
      unread: (summary.status & SessionStatus.IsRead) === 0,
      archived: (summary.status & SessionStatus.IsArchived) !== 0,
    }))
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
  /** the chat's session state, for its "/" commands (absent: none) */
  session?(): SessionState | undefined;
  /** the skills the host completes for "/" on the session (a plugin's skills are only there) */
  skills?(): HostCommand[];
  /** a model's whole context window as the host lists it (maxContextWindow), null when it has none */
  modelWindow?(id: string): number | null;
}

/** The turn being read: its times, whether it runs, and its own model (for a subagent's to differ from). */
interface TurnRead { times: TurnTimes; running: boolean; model: string | null; context: ReadContext | undefined }

const AUTO_MODEL = "auto";

/**
 * Whether a subagent's model is worth saying: VS Code's shouldShowSubagentModel by id. Not when it
 * is the chat's own or Auto; always under an Auto chat (the concrete one is news).
 */
function shownModel(subagent: string | undefined, parent: string | null): boolean {
  const own = subagent?.trim().toLowerCase();
  if (!own || own === AUTO_MODEL) return false;
  const parentId = parent?.trim().toLowerCase() ?? null;
  if (parentId !== null && (parentId === AUTO_MODEL || parentId.slice(parentId.lastIndexOf(":") + 1) === AUTO_MODEL)) return true;
  return own !== parentId;
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
function subagentPart(tool: ToolCallState, subagent: ToolResultSubagentContent, turn: TurnRead): ConversationPart {
  const failed = "success" in tool && tool.success === false;
  const status = !settled(tool) ? "running" : failed || tool.status === ToolCallStatus.Cancelled ? "failed" : "done";
  // its own chat, when the bridge holds it: the real times and model, and what it does now
  const own = turn.context?.chat(subagent.resource);
  const timing = own ? chatTiming(own) : null;
  const ownModel = own ? (own.activeTurn ?? own.turns.at(-1))?.message.model?.id : undefined;
  const activity = own && status === "running" ? activityOf(own) : undefined;
  const started = timing?.started ?? turn.times.started;
  return {
    kind: "subagent",
    id: tool.toolCallId,
    agent: subagent.agentName ?? subagent.title,
    description: subagent.description ?? "",
    model: ownModel !== undefined && shownModel(ownModel, turn.model) ? turn.context!.modelName(ownModel) : null,
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

function toolPart(tool: ToolCallState, turn: TurnRead): ConversationPart {
  const content = contentOf(tool);
  const subagent = content.find((item): item is ToolResultSubagentContent => item.type === ToolResultContentType.Subagent);
  if (subagent) return subagentPart(tool, subagent, turn);
  const state = stateOf(tool);
  const input = "toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : "";
  const terminal = content.find((item): item is ToolResultTerminalContent => item.type === ToolResultContentType.Terminal);
  const exitCode = terminal?.result?.exitCode;
  const images = imagesOf(tool).map((image, index) => ({ media_type: image.contentType, ref: `${tool.toolCallId}:${index}` }));
  const edits = content.flatMap((item) => (item.type === ToolResultContentType.FileEdit ? [editOf(item)] : []));
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
  return questions.map((question) => questionPart(question, request.answers?.[question.id], accepted));
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
    const parts = turn.responseParts.flatMap((part): ConversationPart[] => part.kind !== ResponsePartKind.Error ? partsOf(part, read)
      : part !== stoppedAt ? []
        : [{ kind: "notice", text: part.error.message, source: "error", ...(latest && part.resumable === true ? { resumable: true as const } : {}) }]);
    return [
      { role: "user" as const, ts, parts: [{ kind: "text" as const, text: turn.message.text }, ...userImagesOf(turn.message).map((image, index) => ({ kind: "image" as const, media_type: image.contentType, ref: `${USER_REF}${turn.id}:${index}` }))] },
      { role: "assistant" as const, ts, ...(end ? { end_ts: end } : {}), parts },
    ];
  });
}

/** A user image's ref is `turn:<turnId>:<index>`; a tool's is `<toolCallId>:<index>`. */
const USER_REF = "turn:";

/** The images a user message carried (pasted or attached), in order: the index in its ref counts these alone. */
function userImagesOf(message: Message): MessageEmbeddedResourceAttachment[] {
  return (message.attachments ?? []).flatMap((each) => (each.type === MessageAttachmentKind.EmbeddedResource && IMAGE_TYPES.has(each.contentType) ? [each] : []));
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
export function imageOf(chat: ChatState, ref: string): { media_type: string; bytes: Buffer } | null {
  const at = ref.lastIndexOf(":");
  const digits = at < 0 ? "" : ref.slice(at + 1);
  // one spelling per image: `c1:0`, never `c1:`, `c1:00` or `c1:0x0`
  if (!/^(?:0|[1-9]\d*)$/.test(digits)) return null;
  const index = Number(digits);
  if (ref.startsWith(USER_REF)) {
    const id = ref.slice(USER_REF.length, at);
    const turn = (chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns).find((each) => each.id === id);
    const attached = turn ? userImagesOf(turn.message)[index] : undefined;
    return attached ? { media_type: attached.contentType, bytes: Buffer.from(attached.data, "base64") } : null;
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

function questionPrompt(request: ChatInputRequest, question: ChatInputQuestion): NonNullable<HostChatRead["prompt"]> {
  const questions = request.questions ?? [];
  const { options, ids, custom } = questionOptions(question);
  // several questions: the whole form, paged and answered on the phone (VS Code's carousel)
  const form = questions.length > 1 ? questions.map((each) => {
    const own = questionOptions(each);
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
    if (question) return questionPrompt(request, question);
  }
  const tool = pendingToolCalls(chat)[0];
  return tool ? approvalPrompt(active.id, tool) : null;
}

// ─── Models and agents ───────────────────────────────────────────────────────

/** The reasoning-effort property of a model's configSchema: `thinkingLevel`, else its first enum. */
function effortsOf(schema: HostModelSchema | undefined): HostModel["efforts"] {
  const properties = schema?.properties ?? {};
  const named = properties["thinkingLevel"];
  const entry: [string, { enum?: unknown[] }] | undefined = Array.isArray(named?.enum)
    ? ["thinkingLevel", named]
    : Object.entries(properties).find(([, property]) => Array.isArray(property.enum));
  if (!entry) return null;
  return { key: entry[0], values: (entry[1].enum ?? []).map(String) };
}
type HostModelSchema = { properties?: Record<string, { enum?: unknown[] }> };

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
  const config = selection.config ?? {};
  const effort = config["thinkingLevel"] ?? Object.values(config).find((value) => typeof value === "string");
  return { id: selection.id, effort: typeof effort === "string" ? effort : null };
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
  return usage;
}

/**
 * What VS Code's context meter shows for a turn the host attributed (chatContextUsageWidget
 * updateFromResponse): readAgentContextUsage gives nothing for such a turn, so the meter counts the
 * turn's own input and output tokens over the model's window (maxContextWindow). The attribution's
 * totalTokens is the CLI's running estimate and its limit the CLI's own prompt budget: on a long
 * chat it read 127% (509K / 400K) where VS Code showed 36% (192K / 528K). The breakdown keeps the
 * attribution's shares, scaled to the tokens used. Null when the model or the counts are unknown.
 */
function meteredContext(turn: Turn | ActiveTurn | undefined, attributed: HostContextUsage, window: ((id: string) => number | null) | undefined): HostContextUsage | null {
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
  return usage;
}

export function contextUsageOf(session: SessionState | undefined, newest?: Turn | ActiveTurn, window?: (id: string) => number | null): HostContextUsage | null {
  const attributed = attributedContext(newest);
  if (attributed !== null) return meteredContext(newest, attributed, window) ?? attributed;
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

export function readFrom(session: string, title: string, chat: ChatState, context?: ReadContext): HostChatRead {
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
    confirmations: pendingToolCalls(chat).length,
    // the running turn may have no usage yet: the newest turn that reported one
    context: contextUsageOf(context?.session?.(), [...(chat.activeTurn ? [chat.activeTurn] : []), ...[...chat.turns].reverse()].find((turn) => attributedContext(turn) !== null), context?.modelWindow),
    pending: [
      ...(chat.steeringMessage ? [{ id: chat.steeringMessage.id, kind: "steering" as const, text: chat.steeringMessage.message.text }] : []),
      ...(chat.queuedMessages ?? []).map((each) => ({ id: each.id, kind: "queued" as const, text: each.message.text })),
    ],
    message_ids: [
      ...chat.turns.map((turn) => turn.id), ...(chat.activeTurn ? [chat.activeTurn.id] : []),
      ...(chat.steeringMessage ? [chat.steeringMessage.id] : []), ...(chat.queuedMessages ?? []).map((pending) => pending.id),
    ],
  };
  const shape = [
    read.title, read.status,
    chat.turns.map((turn) => [turn.id, JSON.stringify(turn.responseParts).length]),
    chat.activeTurn ? [chat.activeTurn.id, chat.activeTurn.responseParts.length, JSON.stringify(chat.activeTurn.responseParts).length] : null,
    prompt?.id ?? null, prompt?.steps ?? null, read.cursor, read.model, read.agent, read.message_ids, read.pending, read.commands,
    read.background, read.confirmations, read.context,
    // what a subagent's own chat adds (its model, times, activity) is not in this chat's parts
    turns.flatMap((each) => each.parts.filter((part) => part.kind === "subagent")),
  ];
  return { ...read, signature: createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 16) };
}
