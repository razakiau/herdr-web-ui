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
  ResponsePartKind,
  SessionStatus,
  ToolCallStatus,
  ToolResultContentType,
  type ActiveTurn,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
  type ChatState,
  type Customization,
  type InputRequestResponsePart,
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
import type { HostAgent, HostChatRead, HostChatRow, HostModel } from "../../shared/host-chats.ts";
import { IMAGE_TYPES } from "../conversation.ts";
import { trimOutput } from "../tool-output.ts";

export const PROVIDER = "copilotcli";
/** InteractivePrompt.agent for every host chat card. */
const PROMPT_AGENT = "copilot";
/** The typed-answer slot's label, after a question's own options. */
export const OTHER_LABEL = "Other";
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
 * A subagent the call started. AHP gives a tool call no start or end time, so its times are its
 * turn's: started with the turn, ended when the turn ended (null while the turn runs on).
 */
function subagentPart(tool: ToolCallState, subagent: ToolResultSubagentContent, times: TurnTimes): ConversationPart {
  const failed = "success" in tool && tool.success === false;
  const status = !settled(tool) ? "running" : failed || tool.status === ToolCallStatus.Cancelled ? "failed" : "done";
  return {
    kind: "subagent",
    id: tool.toolCallId,
    agent: subagent.agentName ?? subagent.title,
    description: subagent.description ?? "",
    model: null,
    started: times.started,
    ended: status === "running" ? null : times.ended,
    status,
    chat: subagent.resource,
  };
}

function toolPart(tool: ToolCallState, times: TurnTimes): ConversationPart {
  const content = contentOf(tool);
  const subagent = content.find((item): item is ToolResultSubagentContent => item.type === ToolResultContentType.Subagent);
  if (subagent) return subagentPart(tool, subagent, times);
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
    ...(terminal ? { command: terminal.title } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(edits.length > 0 ? { edits } : {}),
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
      return { ...base, chosen: value.value.map((id) => optionLabel(question, id)), custom: joined(value.freeformValues), skipped: false };
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

/** A reference to content elsewhere, as a markdown link named by its last path segment (a file:// one reads as a file pill). */
function linkTo(uri: string): string {
  let name = "";
  try { name = decodeURIComponent(new URL(uri).pathname.replace(/\/+$/, "").split("/").at(-1) ?? ""); } catch { /* the uri itself */ }
  return `[${(name || uri).replace(/[[\]]/g, "\\$&")}](${uri})`;
}

function partsOf(part: ResponsePart, times: TurnTimes, running: boolean): ConversationPart[] {
  switch (part.kind) {
    case ResponsePartKind.Markdown: return [{ kind: "text", text: part.content }];
    case ResponsePartKind.Reasoning: return [{ kind: "thinking", text: part.content }];
    case ResponsePartKind.ToolCall: return [toolPart(part.toolCall, times)];
    case ResponsePartKind.InputRequest: return questionParts(part, running);
    case ResponsePartKind.ContentRef: return [{ kind: "text", text: linkTo(part.uri) }];
    case ResponsePartKind.SystemNotification: return [{ kind: "notice", text: plain(part.content), source: "system" }];
    // the turn stopped at it: never the turn's answer
    case ResponsePartKind.Error: return [{ kind: "notice", text: part.error.message, source: "error" }];
    default: return [];
  }
}

function endOf(turn: Turn | ActiveTurn): string | undefined {
  if (!("duration" in turn) || turn.duration === undefined || !turn.startedAt) return undefined;
  const start = Date.parse(turn.startedAt);
  return Number.isNaN(start) ? undefined : new Date(start + turn.duration).toISOString();
}

/** Each AHP turn as a user turn and an assistant turn; the running turn last. */
export function turnsFrom(chat: ChatState): ConversationTurn[] {
  const all: Array<Turn | ActiveTurn> = chat.activeTurn ? [...chat.turns, chat.activeTurn] : chat.turns;
  return all.flatMap((turn) => {
    const ts = turn.startedAt ?? null;
    const end = endOf(turn);
    const running = turn === chat.activeTurn;
    const parts = turn.responseParts.flatMap((part) => partsOf(part, { started: ts, ended: end ?? null }, running));
    return [
      { role: "user" as const, ts, parts: [{ kind: "text" as const, text: turn.message.text }] },
      { role: "assistant" as const, ts, ...(end ? { end_ts: end } : {}), parts },
    ];
  });
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
  const index = at < 0 ? NaN : Number(ref.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
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

/** The question an open request asks now: its first one without a submitted answer. */
export function currentQuestion(request: ChatInputRequest): ChatInputQuestion | undefined {
  return (request.questions ?? []).find((question) => !submitted(request.answers?.[question.id]));
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

/** The prompt's options and, parallel to them, the host's option ids. */
function questionOptions(question: ChatInputQuestion): { options: InteractivePromptOption[]; ids: string[]; custom: number | null } {
  switch (question.kind) {
    case ChatInputQuestionKind.SingleSelect:
    case ChatInputQuestionKind.MultiSelect: {
      const options = question.options.map((option) => ({ label: option.label, description: option.description ?? null }));
      const ids = question.options.map((option) => option.id);
      if (!question.allowFreeformInput) return { options, ids, custom: null };
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
  return {
    id: `${request.id}:${question.id}`,
    agent: PROMPT_AGENT,
    kind: "question",
    title: question.title ?? "",
    question: question.message,
    body: request.message ?? null,
    options,
    multi_select: question.kind === ChatInputQuestionKind.MultiSelect,
    custom_option_index: custom,
    ...(questions.length > 1 ? {
      steps: questions.map((each) => ({
        label: each.title ?? each.message,
        answered: submitted(request.answers?.[each.id]),
        current: each.id === question.id,
      })),
    } : {}),
    host: { request_id: request.id, question_id: question.id, option_ids: ids },
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

export function modelsFrom(root: RootState): HostModel[] {
  const agent = root.agents.find((each) => each.provider === PROVIDER);
  return (agent?.models ?? []).map((model) => ({
    id: model.id, name: model.name, provider: model.provider, efforts: effortsOf(model.configSchema), context: model.maxContextWindow ?? null,
  }));
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

export function readFrom(session: string, title: string, chat: ChatState): HostChatRead {
  const prompt = promptFrom(chat);
  const newest = chat.activeTurn ?? chat.turns.at(-1);
  const status = statusOf(chat.status);
  const read: Omit<HostChatRead, "signature"> = {
    session,
    title: chat.title || title,
    status,
    turns: turnsFrom(chat),
    cursor: chat.turnsNextCursor ?? null,
    prompt,
    model: modelOf(chat),
    agent: newest?.message.agent?.uri ?? null,
    busy: chat.activeTurn !== undefined,
    message_ids: [
      ...chat.turns.map((turn) => turn.id), ...(chat.activeTurn ? [chat.activeTurn.id] : []),
      ...(chat.steeringMessage ? [chat.steeringMessage.id] : []), ...(chat.queuedMessages ?? []).map((pending) => pending.id),
    ],
  };
  const shape = [
    read.title, read.status,
    chat.turns.map((turn) => [turn.id, JSON.stringify(turn.responseParts).length]),
    chat.activeTurn ? [chat.activeTurn.id, chat.activeTurn.responseParts.length, JSON.stringify(chat.activeTurn.responseParts).length] : null,
    prompt?.id ?? null, prompt?.steps ?? null, read.cursor, read.model, read.agent, read.message_ids,
  ];
  return { ...read, signature: createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 16) };
}
