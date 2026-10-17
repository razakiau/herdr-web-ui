/**
 * `/api/vscode/*`: this PC's VS Code chats, read from its agent host (server/vscode/connection.ts).
 * Off unless HERDR_WEB_AGENT_HOST=on: with no host every path answers 404 `vscode_off`. A
 * connection server reaches a PC's routes through its bridge (MACHINE_PROXY_PATH).
 *
 * Invariants:
 * - A user's message is dispatched once, by its request; nothing here retries a send.
 * - No response carries the host's token: errors are built from codes (VscodeError), never from a
 *   transport's message.
 * - A chat stays subscribed while a phone holds its lease (a read or POST /chat/watch, renewed
 *   within LEASE_MS); the lease's expiry releases the watch.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ActionType,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  MessageKind,
  PendingMessageKind,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  type ChatInputAnswer,
  type ChatInputAnswerValue,
  type ChatInputQuestion,
  type ChatState,
  type CommandMap,
  type Message,
  type ModelSelection,
  type RootState,
  type SessionState,
  type SessionSummary,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import type { VscodeHostState } from "../../shared/vscode.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "../http.ts";
import { agentsFrom, currentQuestion, modelSelection, modelsFrom, openRequests, pendingToolCalls, PROVIDER, readFrom, rowsFrom } from "./chats.ts";
import { VscodeError } from "./connection.ts";

/** What the routes use of a VscodeConnection, so they can be tested against a stub. */
export interface VscodeHost {
  state(): VscodeHostState;
  mirror(): { readonly root: RootState; getSession(uri: string): SessionState | undefined };
  summaries(): SessionSummary[];
  chat(session: string): ChatState | undefined;
  watch(session: string): Promise<() => void>;
  /** False once the session's watch is gone (a resubscribe after a reconnect failed): a lease takes it again. */
  watching(session: string): boolean;
  request<M extends keyof CommandMap>(method: M, params: CommandMap[M]["params"]): Promise<CommandMap[M]["result"]>;
  dispatch(channel: string, action: StateAction): void;
}

/** The timers a lease runs on; tests pass a clock they advance by hand. */
export interface LeaseClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const LEASE_MS = 90_000;
/** How long a read with `before` waits for the host's older turns to arrive after fetchTurns answers. */
const OLDER_TURNS_WAIT_MS = 5_000;
const PREFIX = "/api/vscode/";

const realClock: LeaseClock = {
  setTimeout: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; },
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

interface Lease { taking: Promise<() => void>; timer: unknown }

/** Per session: one watch, held while a phone keeps renewing it. */
class Leases {
  private readonly held = new Map<string, Lease>();
  constructor(private readonly host: VscodeHost, private readonly clock: LeaseClock) {}

  async take(session: string): Promise<void> {
    let lease = this.held.get(session);
    if (lease && !this.host.watching(session)) {
      // its watch was dropped under it: the lease goes, and this take subscribes again
      this.clock.clearTimeout(lease.timer);
      this.held.delete(session);
      lease = undefined;
    }
    if (lease) {
      this.clock.clearTimeout(lease.timer);
    } else {
      lease = { taking: this.host.watch(session), timer: null };
      this.held.set(session, lease);
    }
    const own = lease;
    own.timer = this.clock.setTimeout(() => this.expire(session, own), LEASE_MS);
    try {
      await own.taking;
    } catch (error) {
      if (this.held.get(session) === own) { this.clock.clearTimeout(own.timer); this.held.delete(session); }
      throw error;
    }
  }

  private expire(session: string, lease: Lease): void {
    if (this.held.get(session) !== lease) return;
    this.held.delete(session);
    void lease.taking.then((release) => release(), () => {});
  }
}

const leaseSets = new WeakMap<VscodeHost, Leases>();
function leasesOf(host: VscodeHost, clock: LeaseClock | undefined): Leases {
  let leases = leaseSets.get(host);
  if (!leases) { leases = new Leases(host, clock ?? realClock); leaseSets.set(host, leases); }
  return leases;
}

/** A refusal the route answers with; never built from a transport's text. */
class Refusal extends Error {
  constructor(readonly response: Response) { super("refusal"); }
}
const refuse = (response: Response): never => { throw new Refusal(response); };

/**
 * The answer for a `/api/vscode/` path; null for any other path. `clock` is the lease timers' (tests);
 * it is read when a host's first route is answered.
 */
export function vscodeRoute(request: Request, pathname: string, host: VscodeHost | null, clock?: LeaseClock): Promise<Response> | null {
  if (!pathname.startsWith(PREFIX)) return null;
  return answer(request, pathname.slice(PREFIX.length), host, clock);
}

type Handler = (call: Call) => Promise<Response>;
interface Call { host: VscodeHost; leases: Leases; url: URL; body: Record<string, unknown> }

const GETS: Record<string, Handler> = {
  // the connection keeps its last list after a disconnect: a down host says so instead of a stale list
  "chats": async ({ host }) => { connected(host); return jsonResponse({ chats: rowsFrom(host.summaries()) }); },
  "chat": readChat,
  "models": listModels,
};
const POSTS: Record<string, Handler> = {
  "chat/watch": async (call) => { await watched(call, sessionOf(call.body)); return jsonResponse({ ok: true }); },
  "chat/send": sendMessage,
  "chat/answer": answerQuestion,
  "chat/confirm": confirmTool,
  "chat/draft": writeDraft,
  "chat/new": newChat,
};

async function answer(request: Request, route: string, host: VscodeHost | null, clock: LeaseClock | undefined): Promise<Response> {
  if (!host) return jsonResponse({ error: { code: "vscode_off", message: "VS Code chats are off on this PC (HERDR_WEB_AGENT_HOST)" } }, 404);
  if (route === "state") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ host: host.state() });
  }
  const get = GETS[route];
  const post = POSTS[route];
  if (!get && !post) return jsonResponse({ error: { code: "not_found", message: `unknown endpoint /api/vscode/${route}` } }, 404);
  if (get && request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  if (post && request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  let body: Record<string, unknown> = {};
  if (post) {
    let payload: unknown;
    try { payload = await request.json(); } catch { return badRequest("invalid_body", "request body must be a JSON object"); }
    if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
    body = payload;
  }
  try {
    return await (get ?? post)!({ host, leases: leasesOf(host, clock), url: new URL(request.url), body });
  } catch (error) {
    if (error instanceof Refusal) return error.response;
    return failure(error, host);
  }
}

function hostDown(host: VscodeHost): Response {
  return jsonResponse({ error: { code: "vscode_host", message: "VS Code's agent host is not connected" }, host: host.state() }, 503);
}

function failure(error: unknown, host: VscodeHost): Response {
  if (error instanceof VscodeError) {
    if (error.code === "not_connected") return hostDown(host);
    return jsonResponse({ error: { code: "vscode_failed", message: `VS Code's agent host failed the request (${error.code})` } }, 502);
  }
  return errorResponse(error);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const text = (value: unknown): value is string => typeof value === "string";

function sessionOf(body: Record<string, unknown>): string {
  const session = body["session"];
  return text(session) && session !== "" ? session : refuse(badRequest("missing_session", "session is required"));
}

function modelOf(value: unknown): { id: string; effort?: string } | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value) || !text(value["id"]) || value["id"] === "" || (value["effort"] !== undefined && !text(value["effort"]))) {
    return refuse(badRequest("invalid_model", "model must be { id, effort? } with strings"));
  }
  return { id: value["id"], ...(text(value["effort"]) ? { effort: value["effort"] } : {}) };
}

function agentOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return text(value) && value !== "" ? value : refuse(badRequest("invalid_agent", "agent must be an agent's uri, or null"));
}

function messageText(value: unknown): string {
  return text(value) && value.trim() !== "" ? value : refuse(badRequest("missing_text", "text is required"));
}

// ─── Sessions and chats ──────────────────────────────────────────────────────

function connected(host: VscodeHost): void {
  if (host.state().state !== "connected") refuse(hostDown(host));
}

const missing = (): never => refuse(jsonResponse({ error: { code: "vscode_chat_missing", message: "no such VS Code chat on this PC" } }, 404));

/** A Copilot CLI session the host knows; another provider's session is not one of these chats, whatever its id. */
function known(host: VscodeHost, session: string): boolean {
  const provider = host.summaries().find((summary) => summary.resource === session)?.provider ?? host.mirror().getSession(session)?.provider;
  return provider === PROVIDER;
}

/** Takes or renews the session's lease, so its chat is in the mirror; the chat's channel and state. */
async function watched({ host, leases }: Call, session: string): Promise<{ channel: string; chat: ChatState }> {
  connected(host);
  if (!known(host, session)) missing();
  try {
    await leases.take(session);
  } catch (error) {
    if (error instanceof VscodeError && error.code === "rpc_error") missing();
    throw error;
  }
  const channel = host.mirror().getSession(session)?.defaultChat;
  const chat = host.chat(session);
  return channel && chat ? { channel, chat } : missing();
}

const titleOf = (host: VscodeHost, session: string): string =>
  host.summaries().find((summary) => summary.resource === session)?.title ?? host.mirror().getSession(session)?.title ?? "";

/** Polls the mirror (the host's turnsLoaded follows its fetchTurns answer) until `ready`, or the deadline. */
async function settle(ready: () => boolean, ms: number): Promise<void> {
  for (const deadline = Date.now() + ms; !ready() && Date.now() < deadline;) await Bun.sleep(10);
}

async function readChat(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  const before = call.url.searchParams.get("before");
  let { channel, chat } = await watched(call, session);
  if (before) {
    await call.host.request("fetchTurns", { channel, cursor: before });
    await settle(() => (call.host.chat(session)?.turnsNextCursor ?? null) !== before, OLDER_TURNS_WAIT_MS);
    chat = call.host.chat(session) ?? chat;
  }
  return jsonResponse(readFrom(session, titleOf(call.host, session), chat));
}

async function listModels(call: Call): Promise<Response> {
  connected(call.host);
  const session = call.url.searchParams.get("session");
  // a session's agents are in its state, which the mirror holds while the session is watched
  if (session) await watched(call, session);
  const agents = session ? agentsFrom(call.host.mirror().getSession(session)) : [];
  return jsonResponse({ models: modelsFrom(call.host.mirror().root), agents });
}

// ─── Sends ───────────────────────────────────────────────────────────────────

function messageFrom(root: RootState, words: string, model: { id: string; effort?: string } | undefined, agent: string | null): Message {
  return {
    text: words,
    origin: { kind: MessageKind.User },
    ...(model ? { model: modelSelection(root, model) } : {}),
    ...(agent ? { agent: { uri: agent } } : {}),
  };
}

/** The chat's shared draft with this model: its text and attachments kept. */
function draftWith(chat: ChatState, model: ModelSelection): StateAction {
  const current = chat.draft;
  return { type: ActionType.ChatDraftChanged, draft: { ...current, text: current?.text ?? "", origin: { kind: MessageKind.User }, model } } as StateAction;
}

/** Dispatches `message` once: a new turn on an idle chat, else a queued message. */
function send(host: VscodeHost, channel: string, chat: ChatState, message: Message): { queued: boolean } {
  const queued = chat.activeTurn !== undefined;
  host.dispatch(channel, (queued
    ? { type: ActionType.ChatPendingMessageSet, kind: PendingMessageKind.Queued, id: randomUUID(), message }
    : { type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(), message }) as StateAction);
  if (message.model) {
    // the message is out; a draft that fails to follow must not make the phone think it was not sent
    try { host.dispatch(channel, draftWith(chat, message.model)); } catch { /* the next model choice writes it */ }
  }
  return { queued };
}

async function sendMessage(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const words = messageText(call.body["text"]);
  const model = modelOf(call.body["model"]);
  const agent = agentOf(call.body["agent"]);
  const { channel, chat } = await watched(call, session);
  return jsonResponse(send(call.host, channel, chat, messageFrom(call.host.mirror().root, words, model, agent)));
}

async function writeDraft(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const model = modelOf(call.body["model"]) ?? refuse(badRequest("invalid_model", "model is required"));
  const { channel, chat } = await watched(call, session);
  call.host.dispatch(channel, draftWith(chat, modelSelection(call.host.mirror().root, model)));
  return jsonResponse({ ok: true });
}

async function newChat(call: Call): Promise<Response> {
  const cwd = call.body["cwd"];
  if (!text(cwd) || !isAbsolute(cwd)) return badRequest("invalid_cwd", "cwd must be an absolute path");
  const words = messageText(call.body["text"]);
  const model = modelOf(call.body["model"]);
  const agent = agentOf(call.body["agent"]);
  connected(call.host);
  const session = `${PROVIDER}:/${randomUUID()}`;
  await call.host.request("createSession", {
    channel: session, provider: PROVIDER, workingDirectories: [pathToFileURL(cwd).href], config: { isolation: "folder" },
  });
  // the session exists from here on: whatever fails next, the phone is told which one, so it opens
  // that chat (the message still in its composer) instead of retrying into a second, empty one
  try {
    await call.leases.take(session);
    const channel = call.host.mirror().getSession(session)?.defaultChat;
    const chat = call.host.chat(session);
    if (!channel || !chat) return jsonResponse({ session, sent: false });
    send(call.host, channel, chat, messageFrom(call.host.mirror().root, words, model, agent));
  } catch {
    return jsonResponse({ session, sent: false });
  }
  return jsonResponse({ session });
}

// ─── Questions and tool calls ────────────────────────────────────────────────

const gone = (): never => refuse(conflictResponse("prompt_changed", "the chat no longer asks that"));

const submittedAs = (value: ChatInputAnswerValue): ChatInputAnswer => ({ state: ChatInputAnswerState.Submitted, value });

/** The answer value a question takes from the phone's option ids and typed text. */
function valueFor(question: ChatInputQuestion, optionIds: string[], typed: string | undefined): ChatInputAnswerValue {
  const free = typed !== undefined && typed.trim() !== "" ? [typed] : [];
  const noAnswer = (): never => refuse(badRequest("missing_answer", "pick an option or type an answer"));
  switch (question.kind) {
    case ChatInputQuestionKind.SingleSelect: {
      const known = optionIds.find((id) => question.options.some((option) => option.id === id));
      if (!known && (free.length === 0 || !question.allowFreeformInput)) return noAnswer();
      return { kind: ChatInputAnswerValueKind.Selected, value: known ?? "", ...(free.length && question.allowFreeformInput ? { freeformValues: free } : {}) };
    }
    case ChatInputQuestionKind.MultiSelect: {
      const picked = optionIds.filter((id) => question.options.some((option) => option.id === id));
      if (picked.length === 0 && (free.length === 0 || !question.allowFreeformInput)) return noAnswer();
      return { kind: ChatInputAnswerValueKind.SelectedMany, value: picked, ...(free.length && question.allowFreeformInput ? { freeformValues: free } : {}) };
    }
    case ChatInputQuestionKind.Boolean: {
      const picked = optionIds.find((id) => id === "true" || id === "false");
      return picked ? { kind: ChatInputAnswerValueKind.Boolean, value: picked === "true" } : noAnswer();
    }
    case ChatInputQuestionKind.Number:
    case ChatInputQuestionKind.Integer: {
      const number = free.length ? Number(free[0]!.trim()) : Number.NaN;
      if (!Number.isFinite(number) || (question.kind === ChatInputQuestionKind.Integer && !Number.isInteger(number))) {
        return refuse(badRequest("invalid_answer", "the answer must be a number"));
      }
      return { kind: ChatInputAnswerValueKind.Number, value: number };
    }
    default:
      return free.length ? { kind: ChatInputAnswerValueKind.Text, value: free[0]! } : noAnswer();
  }
}

async function answerQuestion(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const requestId = call.body["request_id"];
  const questionId = call.body["question_id"];
  if (!text(requestId) || requestId === "") return badRequest("missing_request_id", "request_id is required");
  const skip = call.body["skip"] === true;
  const rawIds = call.body["option_ids"];
  const typed = call.body["text"];
  if (rawIds !== undefined && !(Array.isArray(rawIds) && rawIds.every(text))) return badRequest("invalid_answer", "option_ids must be strings");
  if (typed !== undefined && !text(typed)) return badRequest("invalid_answer", "text must be a string");
  if (!skip && (!text(questionId) || questionId === "")) return badRequest("missing_question_id", "question_id is required");
  const { channel, chat } = await watched(call, session);
  const request = openRequests(chat).find((each) => each.id === requestId) ?? gone();
  if (skip) {
    call.host.dispatch(channel, { type: ActionType.ChatInputCompleted, requestId, response: ChatInputResponseKind.Decline } as StateAction);
    return jsonResponse({ ok: true });
  }
  const questions = request.questions ?? [];
  const question = questions.find((each) => each.id === questionId) ?? gone();
  if (currentQuestion(request)?.id !== question.id) gone();
  const answer = submittedAs(valueFor(question, (rawIds as string[] | undefined)?.filter((id) => id !== "") ?? [], typed as string | undefined));
  const answers = request.answers ?? {};
  // every step is shown, `required` or not: the form completes on its last unanswered question
  const more = questions.some((each) => each.id !== question.id && answers[each.id]?.state !== ChatInputAnswerState.Submitted);
  if (more) {
    call.host.dispatch(channel, { type: ActionType.ChatInputAnswerChanged, requestId, questionId: question.id, answer } as StateAction);
  } else {
    const done = Object.fromEntries(Object.entries(answers).filter(([, each]) => each.state === ChatInputAnswerState.Submitted));
    call.host.dispatch(channel, { type: ActionType.ChatInputCompleted, requestId, response: ChatInputResponseKind.Accept, answers: { ...done, [question.id]: answer } } as StateAction);
  }
  return jsonResponse({ ok: true });
}

async function confirmTool(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const turnId = call.body["turn_id"];
  const toolCallId = call.body["tool_call_id"];
  const approved = call.body["approved"];
  const optionId = call.body["option_id"];
  if (!text(turnId) || turnId === "" || !text(toolCallId) || toolCallId === "") return badRequest("missing_tool_call", "turn_id and tool_call_id are required");
  if (typeof approved !== "boolean") return badRequest("invalid_approved", "approved must be true or false");
  if (optionId !== undefined && !text(optionId)) return badRequest("invalid_option", "option_id must be a string");
  const { channel, chat } = await watched(call, session);
  if (chat.activeTurn?.id !== turnId) gone();
  const tool = pendingToolCalls(chat).find((each) => each.toolCallId === toolCallId) ?? gone();
  const selected = optionId && tool.status === "pending-confirmation" && tool.options?.some((option) => option.id === optionId) ? { selectedOptionId: optionId } : {};
  call.host.dispatch(channel, (approved
    ? { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved: true, confirmed: ToolCallConfirmationReason.UserAction, ...selected }
    : { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved: false, reason: ToolCallCancellationReason.Denied, ...selected }) as StateAction);
  return jsonResponse({ ok: true });
}
