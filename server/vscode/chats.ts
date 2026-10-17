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
  type ModelSelection,
  type ResponsePart,
  type RootState,
  type SessionState,
  type SessionSummary,
  type StringOrMarkdown,
  type ToolCallState,
  type Turn,
} from "@microsoft/agent-host-protocol";
import type { ConversationPart, ConversationTurn, InteractivePromptOption } from "../../shared/protocol.ts";
import type { VscodeAgent, VscodeChatRead, VscodeChatRow, VscodeModel } from "../../shared/vscode.ts";

export const PROVIDER = "copilotcli";
/** InteractivePrompt.agent for every VS Code card. */
const PROMPT_AGENT = "copilot";
/** The typed-answer slot's label, after a question's own options. */
export const OTHER_LABEL = "Other";
/** A text, number or integer question has only the typed-answer slot. */
const ANSWER_LABEL = "Answer";
/** In `option_ids`: the slot that has no host id (the typed answer, or a default Approve/Deny). */
const NO_ID = "";

type Status = VscodeChatRow["status"];

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
export function rowsFrom(summaries: SessionSummary[]): VscodeChatRow[] {
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

function toolOutput(tool: ToolCallState): string {
  const content = "content" in tool ? tool.content ?? [] : [];
  return content.flatMap((item) => (item.type === ToolResultContentType.Text ? [item.text] : [])).join("\n");
}

function toolPart(tool: ToolCallState): ConversationPart {
  const input = "toolInput" in tool && typeof tool.toolInput === "string" ? tool.toolInput : "";
  return {
    kind: "tool",
    name: tool.displayName,
    summary: plain(tool.invocationMessage),
    input,
    output: toolOutput(tool),
    error: "success" in tool && tool.success === false,
  };
}

function optionLabel(question: ChatInputQuestion, id: string): string {
  const options = "options" in question ? question.options : [];
  return options.find((option) => option.id === id)?.label ?? id;
}

/** An answer as the user would read it back. */
function answerText(question: ChatInputQuestion, answer: ChatInputAnswer | undefined): string | null {
  if (!answer || answer.state !== ChatInputAnswerState.Submitted) return null;
  const value = answer.value;
  switch (value.kind) {
    case ChatInputAnswerValueKind.Selected:
      return [...(value.value ? [optionLabel(question, value.value)] : []), ...(value.freeformValues ?? [])].join(", ");
    case ChatInputAnswerValueKind.SelectedMany:
      return [...value.value.map((id) => optionLabel(question, id)), ...(value.freeformValues ?? [])].join(", ");
    default:
      return String(value.value);
  }
}

function requestText(request: ChatInputRequest): string {
  const questions = request.questions ?? [];
  if (questions.length === 0) return request.message ?? "";
  return questions.map((question) => {
    const answer = answerText(question, request.answers?.[question.id]);
    return answer === null ? question.message : `${question.message}\n→ ${answer}`;
  }).join("\n\n");
}

function partOf(part: ResponsePart): ConversationPart | null {
  switch (part.kind) {
    case ResponsePartKind.Markdown: return { kind: "text", text: part.content };
    case ResponsePartKind.Reasoning: return { kind: "thinking", text: part.content };
    case ResponsePartKind.ToolCall: return toolPart(part.toolCall);
    case ResponsePartKind.InputRequest: return { kind: "text", text: requestText(part.request) };
    case ResponsePartKind.Error: return { kind: "text", text: part.error.message, phase: "final_answer" };
    default: return null;
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
    const parts = turn.responseParts.flatMap((part) => partOf(part) ?? []);
    return [
      { role: "user" as const, ts, parts: [{ kind: "text" as const, text: turn.message.text }] },
      { role: "assistant" as const, ts, ...(end ? { end_ts: end } : {}), parts },
    ];
  });
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
      return { options: [{ label: "Yes", description: null }, { label: "No", description: null }], ids: ["true", "false"], custom: null };
    default:
      return { options: [{ label: ANSWER_LABEL, description: null }], ids: [NO_ID], custom: 0 };
  }
}

function questionPrompt(request: ChatInputRequest, question: ChatInputQuestion): NonNullable<VscodeChatRead["prompt"]> {
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
    vscode: { request_id: request.id, question_id: question.id, option_ids: ids },
  };
}

function approvalPrompt(turnId: string, tool: ToolCallState): NonNullable<VscodeChatRead["prompt"]> {
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
    vscode: { tool_call_id: tool.toolCallId, turn_id: turnId, option_ids: choices.map((c) => c.id), approves: choices.map((c) => c.approves) },
  };
}

/** What the running turn waits on: its first open question, else its first tool call to confirm. */
export function promptFrom(chat: ChatState): VscodeChatRead["prompt"] {
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
function effortsOf(schema: VscodeModelSchema | undefined): VscodeModel["efforts"] {
  const properties = schema?.properties ?? {};
  const named = properties["thinkingLevel"];
  const entry: [string, { enum?: unknown[] }] | undefined = Array.isArray(named?.enum)
    ? ["thinkingLevel", named]
    : Object.entries(properties).find(([, property]) => Array.isArray(property.enum));
  if (!entry) return null;
  return { key: entry[0], values: (entry[1].enum ?? []).map(String) };
}
type VscodeModelSchema = { properties?: Record<string, { enum?: unknown[] }> };

export function modelsFrom(root: RootState): VscodeModel[] {
  const agent = root.agents.find((each) => each.provider === PROVIDER);
  return (agent?.models ?? []).map((model) => ({ id: model.id, name: model.name, efforts: effortsOf(model.configSchema) }));
}

/** A model choice on the wire: the effort goes under the model's own effort key. */
export function modelSelection(root: RootState, model: { id: string; effort?: string }): ModelSelection {
  const key = modelsFrom(root).find((each) => each.id === model.id)?.efforts?.key;
  return model.effort !== undefined && key ? { id: model.id, config: { [key]: model.effort } } : { id: model.id };
}

/** Enabled custom agents, top-level or inside an enabled container, once each. */
export function agentsFrom(session: SessionState | undefined): VscodeAgent[] {
  const found = new Map<string, VscodeAgent>();
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
function modelOf(chat: ChatState): VscodeChatRead["model"] {
  const newest = chat.activeTurn ?? chat.turns.at(-1);
  const selection = newest?.message.model ?? chat.draft?.model;
  if (!selection) return null;
  const config = selection.config ?? {};
  const effort = config["thinkingLevel"] ?? Object.values(config).find((value) => typeof value === "string");
  return { id: selection.id, effort: typeof effort === "string" ? effort : null };
}

export function readFrom(session: string, title: string, chat: ChatState): VscodeChatRead {
  const prompt = promptFrom(chat);
  const newest = chat.activeTurn ?? chat.turns.at(-1);
  const status = statusOf(chat.status);
  const read: Omit<VscodeChatRead, "signature"> = {
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
