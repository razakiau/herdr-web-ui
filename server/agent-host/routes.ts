/**
 * `/api/host-chats/*`: this PC's host chats, read from its agent host (server/agent-host/connection.ts).
 * Off unless HERDR_WEB_AGENT_HOST=on: with no host every path answers 404 `host_chats_off`. A
 * connection server reaches a PC's routes through its bridge (MACHINE_PROXY_PATH).
 *
 * Invariants:
 * - A user's message is dispatched once, by its request; nothing here retries a send. The phone
 *   names each message (`id`, a UUID it reuses when the user sends the same words again after a
 *   failure): a send whose id the chat already has, as a turn or a pending message, dispatches
 *   nothing and answers as the first did, and so does a new chat whose session already exists.
 * - No response carries the host's token: errors are built from codes (AgentHostError), never from a
 *   transport's message.
 * - A chat stays subscribed while a phone holds its lease (a read or POST /chat/watch, renewed
 *   within LEASE_MS); the lease's expiry releases the watch.
 */
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ActionType,
  ChatSourceKind,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  CompletionItemKind,
  MessageAttachmentKind,
  MessageKind,
  PendingMessageKind,
  ResponsePartKind,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  TurnState,
  type Turn,
  type ChatInputAnswer,
  type ChatInputAnswerValue,
  type ChatInputQuestion,
  type ChatInputRequest,
  type ChatState,
  type ToolResultFileEditContent,
  type Changeset,
  type ChangesetState,
  type FileEdit,
  type CommandMap,
  type Message,
  type MessageAttachment,
  type ModelSelection,
  type RootState,
  type SessionState,
  type SessionSummary,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import type { AgentHostState, HostChanges, HostChatCost, HostCommand, HostCostCall } from "../../shared/host-chats.ts";
import { cliSessionOf, defaultAgentSessionDirs, peerChatSdkOf, readSessionTodos, sdkSessionOf } from "./todos.ts";
import { CostIndex, POLL_BYTES_PER_SCAN, POLL_READS_PER_TICK } from "./costs.ts";
import { defaultCopilotHome } from "../copilot.ts";
import type { FileEditKind } from "../../shared/protocol.ts";
import { paneFiles } from "../files.ts";
import { PasteImageError, pasteDirectory, saveAttachment } from "../paste.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { handoffCommand, resumeCommand } from "../../shared/handoff-command.ts";
import { nextHandoffTitle } from "../../shared/handoff-title.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "../http.ts";
import { workOf } from "./artifacts.ts";
import { agentsFrom, ANSWER_REF, commandsFrom, currentQuestion, editKind, fileEditOf, pathOf, turnEdits, imageOf, modelOutputs, modelSelection, modelsFrom, openRequests, pendingToolCalls, PROVIDER, readFrom, rowsFrom, answerSettled, skillsFrom, subagentChats, toolOutputOf, type ReadContext } from "./chats.ts";
import { AgentHostError } from "./connection.ts";
import { askHandoffText, HANDOFF_WAIT_MS, handoffJob, handoffRunning, startContinue, startHandoff } from "./handoff.ts";

/** What the routes use of a AgentHostConnection, so they can be tested against a stub. */
export interface AgentHost {
  state(): AgentHostState;
  mirror(): { readonly root: RootState; getSession(uri: string): SessionState | undefined };
  summaries(): SessionSummary[];
  chat(session: string): ChatState | undefined;
  watch(session: string): Promise<() => void>;
  /** False once the session's watch is gone (a resubscribe after a reconnect failed): a lease takes it again. */
  watching(session: string): boolean;
  request<M extends keyof CommandMap>(method: M, params: CommandMap[M]["params"]): Promise<CommandMap[M]["result"]>;
  dispatch(channel: string, action: StateAction): void;
  /** A subagent's worker chat, watched on its own for the session that started it (read only); a host without them reads no worker chat. */
  watchChat?(uri: string, session: string): Promise<() => void>;
  watchingChat?(uri: string): boolean;
  chatAt?(uri: string): ChatState | undefined;
  /** A channel's state once, not kept (a changeset); a host without it has no Changes pill. */
  snapshotOf?(uri: string): Promise<unknown>;
}

/** The timers a lease runs on; tests pass a clock they advance by hand. */
export interface LeaseClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const LEASE_MS = 90_000;
/** How long a read with `before` waits for the host's older turns to arrive after fetchTurns answers. */
const OLDER_TURNS_WAIT_MS = 5_000;
/** How long Stop and Send waits for the cancelled turn to end before it gives up and sends nothing. */
export const STOP_AND_SEND_WAIT_MS = 10_000;
/**
 * How long a turn started right after a cancel is watched for being ended by the cancelled turn's
 * late SDK idle (VS Code's Copilot host completes "the running replacement turn" when the abort's
 * idle lands after the new send; live 2026-10-24: idle 0.4-0.9 s after the send, the reply then
 * dropped as "delta with no active turn"). One that ends empty inside it is started again, once.
 */
export const REPLACEMENT_WATCH_MS = 8_000;
const PREFIX = "/api/host-chats/";

const realClock: LeaseClock = {
  setTimeout: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; },
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

interface Lease { taking: Promise<() => void>; timer: unknown }

/** What a lease holds: a session's watch, or a worker chat's. */
interface Watcher { watch(key: string): Promise<() => void>; watching(key: string): boolean }

/** Per session (or worker chat): one watch, held while a phone keeps renewing it. */
class Leases {
  private readonly held = new Map<string, Lease>();
  /** `onExpire`: a lease ran out (not renewed in LEASE_MS), after its watch is released. */
  constructor(private readonly host: Watcher, private readonly clock: LeaseClock, private readonly onExpire?: (key: string) => void) {}

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

  /** Lets the session's watch go now (its session is gone): the next take subscribes again. */
  release(session: string): void {
    const lease = this.held.get(session);
    if (!lease) return;
    this.clock.clearTimeout(lease.timer);
    this.held.delete(session);
    void lease.taking.then((release) => release(), () => {});
    this.onExpire?.(session);
  }

  private expire(session: string, lease: Lease): void {
    if (this.held.get(session) === lease) this.release(session);
  }
}

/** How many sends a host remembers by id, beside its mirror (a queued message that started since has another id there). */
const SENT_MAX = 500;

/** The messages this process dispatched, by the phone's id, and their chats. Oldest go first. */
class Sent {
  private readonly answered = new Map<string, { session: string }>();
  get(id: string): { session: string } | undefined { return this.answered.get(id); }
  forget(id: string): void { this.answered.delete(id); }
  has(session: string): boolean { for (const each of this.answered.values()) if (each.session === session) return true; return false; }
  add(id: string, session: string): void {
    this.answered.set(id, { session });
    if (this.answered.size > SENT_MAX) this.answered.delete(this.answered.keys().next().value!);
  }
}
const sentSets = new WeakMap<AgentHost, Sent>();
function sentOf(host: AgentHost): Sent {
  let sent = sentSets.get(host);
  if (!sent) { sent = new Sent(); sentSets.set(host, sent); }
  return sent;
}

/**
 * A checkpoint restored and not yet sent past (VS Code's restoreSnapshot before the next request):
 * by session, the turn restored to and the edits undone, newest first, so Redo can put them back.
 * Kept by this process alone: a bridge restart forgets it, and the chat is whole until a send.
 */
interface Restored { turn: string; previous: string | null; undone: ToolResultFileEditContent[] }
const restoredSets = new WeakMap<AgentHost, Map<string, Restored>>();
function restoredOf(host: AgentHost): Map<string, Restored> {
  let restored = restoredSets.get(host);
  if (!restored) { restored = new Map(); restoredSets.set(host, restored); }
  return restored;
}
/** what a read says of it: the turn, and how many files its undo changed */
const restoredRead = (host: AgentHost, session: string): { turn: string; files: number } | null => {
  const restored = restoredOf(host).get(session);
  return restored ? { turn: restored.turn, files: new Set(restored.undone.map(fileOf)).size } : null;
};
const fileOf = (edit: ToolResultFileEditContent): string => edit.after?.uri ?? edit.before?.uri ?? "";

/**
 * The chats this bridge made empty (VS Code's New Chat: the chat opens before its first message).
 * The host lists none of them until a message goes; one left without a message is disposed when
 * the phone leaves it (chat/discard) or when no phone keeps its watch, so nothing piles up.
 */
const emptySets = new WeakMap<AgentHost, Set<string>>();
function emptiesOf(host: AgentHost): Set<string> {
  let empties = emptySets.get(host);
  if (!empties) { empties = new Set(); emptySets.set(host, empties); }
  return empties;
}
/** Disposes `session` if this bridge made it empty and it still has no message: whether it went. */
async function dropIfEmpty(host: AgentHost, session: string): Promise<boolean> {
  const empties = emptiesOf(host);
  if (!empties.has(session)) return false;
  const chat = host.chat(session);
  if (chat && (chat.activeTurn !== undefined || chat.turns.length > 0 || chat.steeringMessage !== undefined || (chat.queuedMessages ?? []).length > 0)) { empties.delete(session); return false; }
  empties.delete(session);
  await host.request("disposeSession", { channel: session });
  return true;
}

/** A host's leases: its sessions', its worker chats', and which session each worker chat was found in. */
interface HostLeases { sessions: Leases; chats: Leases; workers: Map<string, string> }
const leaseSets = new WeakMap<AgentHost, HostLeases>();
function leasesOf(host: AgentHost, clock: LeaseClock | undefined): HostLeases {
  let leases = leaseSets.get(host);
  if (!leases) {
    const workers = new Map<string, string>();
    const chats: Watcher = {
      watch: (uri) => host.watchChat ? host.watchChat(uri, workers.get(uri) ?? "") : Promise.reject(new AgentHostError("rpc_error")),
      watching: (uri) => host.watchingChat?.(uri) ?? false,
    };
    // a session no phone keeps watching forgets its worker chats: its next read finds them again
    const forget = (session: string): void => {
      for (const [uri, owner] of workers) if (owner === session) workers.delete(uri);
      // an empty chat no phone keeps open was left: it goes (the host never listed it)
      void dropIfEmpty(host, session).catch(() => undefined);
    };
    leases = { sessions: new Leases(host, clock ?? realClock, forget), chats: new Leases(chats, clock ?? realClock), workers };
    leaseSets.set(host, leases);
  }
  return leases;
}

/** A refusal the route answers with; never built from a transport's text. */
class Refusal extends Error {
  constructor(readonly response: Response) { super("refusal"); }
}
const refuse = (response: Response): never => { throw new Refusal(response); };

/**
 * The answer for a `/api/host-chats/` path; null for any other path. `clock` is the lease timers' (tests);
 * it is read when a host's first route is answered.
 */
export function hostChatsRoute(request: Request, pathname: string, host: AgentHost | null, clock?: LeaseClock): Promise<Response> | null {
  if (!pathname.startsWith(PREFIX)) return null;
  return answer(request, pathname.slice(PREFIX.length), host, clock);
}

type Handler = (call: Call) => Promise<Response>;
interface Call { host: AgentHost; leases: HostLeases; clock: LeaseClock; url: URL; body: Record<string, unknown> }

const GETS: Record<string, Handler> = {
  // the connection keeps its last list after a disconnect: a down host says so instead of a stale list
  "chats": async ({ host }) => { connected(host); return jsonResponse({ chats: rowsFrom(host.summaries()) }); },
  "costs": readCosts,
  "chat": readChat,
  "models": listModels,
  "image": readImage,
  "tool-output": readToolOutput,
  "edit-diff": readEditDiff,
  "changes": readChanges,
  "changes/diff": readChangeDiff,
  "session/config": readConfig,
  "files": listFiles,
  "chat/handoff": readHandoff,
};
const POSTS: Record<string, Handler> = {
  "chat/watch": async (call) => { await watched(call, sessionOf(call.body)); return jsonResponse({ ok: true }); },
  "chat/send": sendMessage,
  "chat/upload": uploadFile,
  "chat/stop": stopTurn,
  "chat/resume": resumeTurn,
  "chat/checkpoint/restore": restoreCheckpoint,
  "chat/checkpoint/redo": redoCheckpoint,
  "chat/pending/remove": removePending,
  "chat/pending/send_now": sendPendingNow,
  "chat/background/stop": stopBackground,
  "chat/answer": answerQuestion,
  "chat/confirm": confirmTool,
  "chat/draft": writeDraft,
  "chat/new": newChat,
  "chat/fork": forkChat,
  "chat/rename": renameChat,
  "chat/read": markRead,
  "chat/archive": markArchived,
  "chat/delete": deleteChat,
  "chat/discard": discardChat,
  "chat/handoff": handOff,
  "chat/continue": continueChat,
  "session/config": writeConfig,
};

/** Every route a bridge answers under /api/host-chats/, which the server's PC proxy must pass. */
export const HOST_CHAT_ROUTES: readonly string[] = ["state", ...Object.keys(GETS), ...Object.keys(POSTS)];

async function answer(request: Request, route: string, host: AgentHost | null, clock: LeaseClock | undefined): Promise<Response> {
  if (!host) return jsonResponse({ error: { code: "host_chats_off", message: "host chats are off on this PC (HERDR_WEB_AGENT_HOST)" } }, 404);
  if (route === "state") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ host: host.state() });
  }
  // a route both reads and writes (session/config) takes its handler by method
  const get = request.method === "GET" || !POSTS[route] ? GETS[route] : undefined;
  const post = request.method === "POST" || !GETS[route] ? POSTS[route] : undefined;
  if (!get && !post) return jsonResponse({ error: { code: "not_found", message: `unknown endpoint /api/host-chats/${route}` } }, 404);
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
    return await (get ?? post)!({ host, leases: leasesOf(host, clock), clock: clock ?? realClock, url: new URL(request.url), body });
  } catch (error) {
    if (error instanceof Refusal) return error.response;
    return failure(error, host);
  }
}

function hostDown(host: AgentHost): Response {
  return jsonResponse({ error: { code: "agent_host_down", message: "the agent host is not connected" }, host: host.state() }, 503);
}

function failure(error: unknown, host: AgentHost): Response {
  if (error instanceof AgentHostError) {
    if (error.code === "not_connected") return hostDown(host);
    return jsonResponse({ error: { code: "agent_host_failed", message: `the agent host failed the request (${error.code})` } }, 502);
  }
  return errorResponse(error);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const text = (value: unknown): value is string => typeof value === "string";

function sessionOf(body: Record<string, unknown>): string {
  const session = body["session"];
  return text(session) && session !== "" ? session : refuse(badRequest("missing_session", "session is required"));
}

/** The owner's optional message for a hand-off's new chat (ZAC-267), trimmed; null when absent or blank. */
function handoffMessageOf(body: Record<string, unknown>): string | null {
  const value = body["message"];
  if (value === undefined || value === null) return null;
  if (!text(value)) return refuse(badRequest("bad_message", "message must be a string"));
  return value.trim() === "" ? null : value.trim();
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The phone's id for this message (or new chat): a UUID, reused on a retry of the same words. A
 * request without one (an older phone) gets a fresh one here: it goes, but a retry is not
 * recognised. An id that is there but no UUID is refused.
 */
function idOf(value: unknown): string {
  if (value === undefined) return randomUUID();
  return text(value) && UUID.test(value) ? value.toLowerCase() : refuse(badRequest("invalid_id", "id must be a UUID"));
}

/**
 * How a message goes (VS Code's send menu, ChatSendMode): `send` starts a turn, or queues behind a
 * running one; `steer` and `queue` set a pending message of that kind on a busy chat; `stop_and_send`
 * cancels the running turn and starts one with the text. On an idle chat each of them starts a turn.
 */
type SendMode = "send" | "steer" | "queue" | "stop_and_send";
const SEND_MODES: readonly SendMode[] = ["send", "steer", "queue", "stop_and_send"];
function modeOf(value: unknown): SendMode {
  if (value === undefined) return "send";
  return SEND_MODES.includes(value as SendMode) ? value as SendMode : refuse(badRequest("invalid_mode", `mode must be one of ${SEND_MODES.join(", ")}`));
}

function messageText(value: unknown, attached = false): string {
  // a message of attachments alone goes with no words, as VS Code sends a picked file on its own
  if (attached && (value === undefined || (text(value) && value.trim() === ""))) return "";
  return text(value) && value.trim() !== "" ? value : refuse(badRequest("missing_text", "text is required"));
}

// ─── Sessions and chats ──────────────────────────────────────────────────────

function connected(host: AgentHost): void {
  if (host.state().state !== "connected") refuse(hostDown(host));
}

const missing = (): never => refuse(jsonResponse({ error: { code: "host_chat_missing", message: "no such host chat on this PC" } }, 404));

/**
 * The session a chat id is in: a session's own URI is itself; a session's other chat (a fork, VS
 * Code's Fork Conversation) is listed by its chat URI, and is in the session whose catalog
 * (SessionSummary.chats) names it.
 */
function ownerOf(host: AgentHost, id: string): string {
  if (!id.startsWith("ahp-chat:")) return id;
  return host.summaries().find((summary) => summary.defaultChat !== id && (summary.chats ?? []).some((each) => each.resource === id))?.resource ?? id;
}
/** Whether `id` names a session's other chat (a fork) rather than a session. */
const isFork = (host: AgentHost, id: string): boolean => ownerOf(host, id) !== id;

/** A Copilot CLI session the host knows, or one of its forks; another provider's session is not one of these chats, whatever its id. */
function known(host: AgentHost, id: string): boolean {
  const session = ownerOf(host, id);
  if (session.startsWith("ahp-chat:")) return false;
  const provider = host.summaries().find((summary) => summary.resource === session)?.provider ?? host.mirror().getSession(session)?.provider;
  return provider === PROVIDER;
}

/** The channel a chat id's messages go on: a fork's own chat URI, else the session's default chat. */
const channelOf = (host: AgentHost, id: string): string | undefined =>
  isFork(host, id) ? id : host.mirror().getSession(id)?.defaultChat ?? undefined;

/** Takes or renews the session's lease, so its chat is in the mirror; the chat's channel and state. */
async function watched({ host, leases }: Call, session: string): Promise<{ channel: string; chat: ChatState }> {
  connected(host);
  if (!known(host, session)) missing();
  try {
    await leases.sessions.take(session);
  } catch (error) {
    if (error instanceof AgentHostError && error.code === "rpc_error") missing();
    throw error;
  }
  const channel = channelOf(host, session);
  const chat = host.chat(session);
  return channel && chat ? { channel, chat } : missing();
}

const titleOf = (host: AgentHost, id: string): string => {
  const session = ownerOf(host, id);
  if (session !== id) return host.summaries().find((summary) => summary.resource === session)?.chats?.find((each) => each.resource === id)?.title ?? "";
  return host.summaries().find((summary) => summary.resource === session)?.title ?? host.mirror().getSession(session)?.title ?? "";
};

/** Polls the mirror (the host's turnsLoaded follows its fetchTurns answer) until `ready`, or the deadline. */
async function settle(ready: () => boolean, ms: number): Promise<void> {
  for (const deadline = Date.now() + ms; !ready() && Date.now() < deadline;) await Bun.sleep(10);
}

/** How many of a chat's subagents a read subscribes: their own chats give their rows a model and times. */
export const SUBAGENTS_FOLLOWED = 20;

/**
 * Remembers every worker chat `chat`'s subagent calls started as `session`'s, so each reads through
 * the chat route (an older one subscribes when its row opens: workerChat), and leases the newest
 * SUBAGENTS_FOLLOWED now. One the host will not give is left out; its row keeps its turn's times.
 */
async function followSubagents(call: Call, session: string, chat: ChatState): Promise<void> {
  if (!call.host.watchChat) return;
  const uris = subagentChats(chat);
  for (const uri of uris) call.leases.workers.set(uri, session);
  await Promise.all(uris.slice(-SUBAGENTS_FOLLOWED).map((uri) => call.leases.chats.take(uri).catch(() => undefined)));
}

/** What a read of `session`'s chat knows beside it: its subagents' own chats, and the models' names. */
function contextOf(host: AgentHost, session?: string, skills?: HostCommand[]): ReadContext {
  const models = modelsFrom(host.mirror().root);
  const names = new Map(models.map((model) => [model.id, model.name]));
  const windows = new Map(models.map((model) => [model.id, model.context]));
  const outputs = new Map(modelOutputs(host.mirror().root));
  return {
    chat: (uri) => host.chatAt?.(uri), modelName: (id) => names.get(id) ?? id, modelIds: () => [...names.keys()], modelWindow: (id) => windows.get(id) ?? null, modelOutput: (id) => outputs.get(id) ?? null,
    ...(session ? { session: () => host.mirror().getSession(ownerOf(host, session)) } : {}),
    ...(skills ? { skills: () => skills } : {}),
    ...(session ? { todos: () => readSessionTodos(session) } : {}),
  };
}

/** How long a session's skills are kept before a read asks the host again (it answers from its own cache). */
export const SKILLS_TTL_MS = 5 * 60_000;
/** How long a read waits for a session's first skill list before it goes without (the next read has it). */
const SKILLS_WAIT_MS = 2_000;
interface SkillsEntry { skills: HostCommand[]; at: number; asking: Promise<void> | null }
const skillSets = new WeakMap<AgentHost, Map<string, SkillsEntry>>();

/**
 * The skills the host completes for "/" on `session`. VS Code's own "/" menu asks `completions`
 * with the session's URI: copilotcli's runtime list carries the plugins' skills, which the
 * session's customizations do not (on a Coder workspace none of them). A failed ask keeps the last list.
 *
 * A new chat's runtime starts with its first message: until then the host completes only its
 * built-in commands (measured 2026-10-20: 61 items, 0 skills, still none 10 s after createSession;
 * an older session on the same host: 182). That empty answer is not kept: the session is asked
 * again on its next read, and meanwhile lists the skills of another Copilot session, one in the
 * same folder first, else the newest.
 */
async function sessionSkills(host: AgentHost, session: string, borrow = true): Promise<HostCommand[]> {
  let sessions = skillSets.get(host);
  if (!sessions) { sessions = new Map(); skillSets.set(host, sessions); }
  const entry = sessions.get(session) ?? { skills: [], at: -Infinity, asking: null };
  sessions.set(session, entry);
  if (Date.now() - entry.at < SKILLS_TTL_MS) return entry.skills;
  const first = entry.skills.length === 0;
  entry.asking ??= host.request("completions", { kind: CompletionItemKind.UserMessage, channel: ownerOf(host, session), text: "/", offset: 1 })
    .then((result) => { entry.skills = skillsFrom(result.items ?? []); entry.at = entry.skills.length > 0 ? Date.now() : -Infinity; })
    .catch(() => { /* the last list stands; the next read asks again */ })
    .finally(() => { entry.asking = null; });
  // the first list is waited for (briefly); a stale one is shown while the new one comes
  if (first) await Promise.race([entry.asking, Bun.sleep(SKILLS_WAIT_MS)]);
  if (entry.skills.length > 0 || !borrow) return entry.skills;
  const lender = skillsLender(host, session);
  return lender ? sessionSkills(host, lender, false) : [];
}

/** The Copilot session whose skills a new chat lists meanwhile: one in its folder first, else the newest. */
function skillsLender(host: AgentHost, session: string): string | null {
  const rows = host.summaries().filter((row) => row.provider === PROVIDER && row.resource !== session);
  const folder = host.summaries().find((row) => row.resource === session)?.workingDirectories?.[0];
  const newest = (a: SessionSummary, b: SessionSummary) => String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? ""));
  const same = folder === undefined ? [] : rows.filter((row) => row.workingDirectories?.[0] === folder).sort(newest);
  return (same[0] ?? [...rows].sort(newest)[0])?.resource ?? null;
}

/**
 * A subagent's worker chat, by its URI, once a read of its session found it: the session's lease
 * and its own are taken, the session still a Copilot one. Read only: no write route takes it.
 */
async function workerChat(call: Call, uri: string): Promise<ChatState> {
  const session = call.leases.workers.get(uri) ?? missing();
  await watched(call, session);
  try {
    await call.leases.chats.take(uri);
  } catch (error) {
    if (error instanceof AgentHostError && error.code !== "rpc_error") throw error;
    missing();
  }
  return call.host.chatAt?.(uri) ?? missing();
}

/** A session's chat, else a worker chat one of them started. */
const isWorker = (call: Call, session: string): boolean => !known(call.host, session) && call.leases.workers.has(session);

async function readChat(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  connected(call.host);
  if (isWorker(call, session)) {
    const chat = await workerChat(call, session);
    // its questions and approvals are its parent's to show: a worker chat's read asks nothing
    return jsonResponse({ ...readFrom(session, chat.title, chat, contextOf(call.host)), prompt: null });
  }
  const before = call.url.searchParams.get("before");
  let { channel, chat } = await watched(call, session);
  if (before) {
    await call.host.request("fetchTurns", { channel, cursor: before });
    await settle(() => (call.host.chat(session)?.turnsNextCursor ?? null) !== before, OLDER_TURNS_WAIT_MS);
    chat = call.host.chat(session) ?? chat;
  }
  await followSubagents(call, session, chat);
  const skills = await sessionSkills(call.host, session);
  return jsonResponse(readFrom(session, titleOf(call.host, session), call.host.chat(session) ?? chat, contextOf(call.host, session, skills), restoredRead(call.host, session)));
}

/** `session` and `ref` of an image or tool-output GET; the chat read the same way a chat GET reads it (its lease). */
async function refRead(call: Call): Promise<{ chat: ChatState; ref: string }> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") refuse(badRequest("missing_session", "session is required"));
  const ref = call.url.searchParams.get("ref") ?? "";
  if (ref === "") refuse(badRequest("missing_ref", "ref is required"));
  connected(call.host);
  if (isWorker(call, session)) return { chat: await workerChat(call, session), ref };
  const { chat } = await watched(call, session);
  return { chat, ref };
}

const noRef = (what: string): Response => jsonResponse({ error: { code: "not_found", message: `no such ${what} in this host chat` } }, 404);

/** An image a tool call returned, by the ref its part names (`<toolCallId>:<index>`), from the chat in the mirror. */
async function readImage(call: Call): Promise<Response> {
  const { chat, ref } = await refRead(call);
  if (ref.startsWith(ANSWER_REF)) return answerImage(call, chat, ref);
  const image = imageOf(chat, ref);
  if (!image) return noRef("image");
  let bytes: Buffer;
  if ("uri" in image) {
    // a picture VS Code keeps as a file: gone from the host (a cleaned session), it is not found
    try {
      const read = await contentAt(call.host, image.uri);
      bytes = Buffer.from(read.data, read.encoding === "base64" ? "base64" : "utf8");
    } catch { return noRef("image"); }
    if (bytes.length > MAX_ATTACHMENT_BYTES) return noRef("image");
  } else bytes = image.bytes;
  // a running call's content can still change under the same ref
  return new Response(new Uint8Array(bytes), { headers: { "content-type": image.media_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

/**
 * A picture an answer carried, by `answer:<file name>`: read from the chat's `.ovis/`, the
 * folder chat/upload writes, and only when one of the chat's answers names that file. Any other
 * name, a path, or a file a link points out of the folder with, is not found.
 */
async function answerImage(call: Call, chat: ChatState, ref: string): Promise<Response> {
  const name = ref.slice(ANSWER_REF.length);
  const session = call.url.searchParams.get("session") ?? "";
  const named = readFrom(session, "", chat).turns.some((turn) => turn.parts.some((part) => part.kind === "question" && part.images?.some((image) => image.ref === ref)));
  const folder = named ? folderOf(call.host, session) : null;
  if (folder === null) return noRef("image");
  try {
    const dir = realpathSync(pasteDirectory(folder));
    const path = realpathSync(join(dir, name));
    if (dirname(path) !== dir) return noRef("image");
    const type = IMAGE_BY_EXTENSION[extname(path).toLowerCase()];
    if (!type || statSync(path).size > MAX_ATTACHMENT_BYTES) return noRef("image");
    return new Response(new Uint8Array(readFileSync(path)), { headers: { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return noRef("image");
  }
}

/** A tool call's whole output, by its `output_ref` (the call's id). */
async function readToolOutput(call: Call): Promise<Response> {
  const { chat, ref } = await refRead(call);
  const output = toolOutputOf(chat, ref);
  return output === null ? noRef("tool call") : jsonResponse({ output });
}

/** Past this a side is not drawn as a diff: a phone would lay out a megabyte of lines. */
export const EDIT_SIDE_BYTES = 512 * 1024;

/** A side's text, or why there is none to draw: too big, or not UTF-8 text (a NUL, or bytes that do not decode). */
function sideText(read: { data: string; encoding: string }): string | "binary" {
  const bytes = read.encoding === "base64" ? Buffer.from(read.data, "base64") : Buffer.from(read.data);
  if (bytes.length > EDIT_SIDE_BYTES || bytes.includes(0)) return "binary";
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return "binary"; }
}

/**
 * One edit's two sides, by the ref its part names (`<toolCallId>:<index>`), read through the host
 * (the session-db refs VS Code's own diff reads): what the file was before the call and after it.
 * A created file has no before, a deleted one no after. A side the host no longer holds makes the
 * answer `unavailable`; one that is not text, `binary`: the client says so instead of a diff.
 */
async function readEditDiff(call: Call): Promise<Response> {
  const { chat, ref } = await refRead(call);
  const edit = fileEditOf(chat, ref);
  if (edit === null) return noRef("edit");
  return diffOf(call.host, edit);
}

async function diffOf(host: AgentHost, edit: ToolResultFileEditContent): Promise<Response> {
  const uri = edit.after?.uri ?? edit.before?.uri ?? "";
  const head = { path: pathOf(uri) ?? uri, kind: editKind(edit) };
  let sides: (string | "binary" | null)[];
  try {
    sides = await Promise.all([edit.before, edit.after].map(async (side) => side === undefined ? null : sideText(await contentAt(host, side.content.uri))));
  } catch {
    return jsonResponse({ ...head, before: null, after: null, unavailable: true });
  }
  if (sides.includes("binary")) return jsonResponse({ ...head, before: null, after: null, binary: true });
  return jsonResponse({ ...head, before: sides[0], after: sides[1] });
}

/**
 * The changeset VS Code's Changes pill shows (agentHostSessionInputPills, 1.142): a URI template
 * with a `{placeholder}` is skipped (a turn's or a comparison's), the "session" kind is preferred,
 * else the first left. Its state is read once (subscribe, snapshot, unsubscribe): the pill is a
 * count, read again when the chat's turn ends, not a live view.
 */
async function changesetOf(call: Call, session: string): Promise<{ label: string; state: ChangesetState } | null> {
  const { chat } = await watched(call, session);
  const listed = ((chat as { changesets?: readonly Changeset[] }).changesets ?? []).filter((each) => !each.uriTemplate.includes("{"));
  const chosen = listed.find((each) => each.changeKind === "session") ?? listed[0];
  if (!chosen || !call.host.snapshotOf) return null;
  let state: unknown;
  // a changeset the host cannot compute now (no git, a lost folder) is no pill, not a failed read
  try { state = await call.host.snapshotOf(chosen.uriTemplate); } catch { return null; }
  const files = (state as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return null;
  return { label: chosen.label, state: state as ChangesetState };
}

const changeKindOf = (edit: FileEdit): FileEditKind => editKind(edit as ToolResultFileEditContent);
const changePath = (edit: FileEdit): string => { const uri = edit.after?.uri ?? edit.before?.uri ?? ""; return pathOf(uri) ?? uri; };

// ─── Costs ───────────────────────────────────────────────────────────────────

/** One index per process: it keeps each log's offset, so a request reads only what was written since. */
let costIndex: { index: CostIndex; agentDirs: readonly string[] } | null = null;
function costsOf(): { index: CostIndex; agentDirs: readonly string[] } {
  if (!costIndex) { const agentDirs = defaultAgentSessionDirs(); costIndex = { index: new CostIndex(defaultCopilotHome(), agentDirs), agentDirs }; }
  return costIndex;
}
/** Tests: the index (and the VS Code stores it maps chats through) the route reads; null for this PC's own. */
export function setCostIndexForTests(index: CostIndex | null, agentDirs: readonly string[] = []): void {
  costIndex = index === null ? null : { index, agentDirs };
}

/**
 * The SDK session a host row runs on: a CLI chat's own uuid, a VS Code chat's through its store. A
 * `copilotcli:/` row is a VS Code Agent Host chat too on the Mac's host: its uuid is not its log's
 * folder (ZAC-267, live 2026-10-31: copilotcli:/a2f6c49b-… runs on 17fea190-…, and 43 of the Mac's
 * 78 logs were answered under no row, so no ring and no kept-warm flame), so its store is asked when
 * no log carries its own uuid, as the index's costOf and cliSessionOf already do.
 */
function sdkOfRow(session: string, agentDirs: readonly string[], parent: string | null = null, hasLog: (uuid: string) => boolean = () => true): string | null {
  if (session.startsWith("ahp-chat:")) return peerChatSdkOf(session, agentDirs, parent);
  const at = session.indexOf(":/");
  if (at < 0) return null;
  const uuid = session.slice(at + 2);
  if (!UUID.test(uuid)) return null;
  if (session.startsWith(`${PROVIDER}:/`) && hasLog(uuid)) return uuid;
  return sdkSessionOf(uuid, agentDirs) ?? (session.startsWith(`${PROVIDER}:/`) ? uuid : null);
}

/**
 * GET costs: every chat the index has read, each under the session id of the host row it belongs
 * to (a VS Code chat's `ahp-session:/` id, not its SDK one) so the phone matches rows directly; a
 * log no listed row runs on (a CLI chat not open in the host) keeps its `copilotcli:/` id. With
 * `?session=`, that chat alone and its calls. A log that fails to read answers what was read.
 */
async function readCosts(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session");
  if (session !== null) {
    if (session === "") return badRequest("missing_session", "session is required");
    let chat: HostChatCost | null = null;
    let calls: HostCostCall[] = [];
    // a fork or peer chat whose id names no parent: the host's row says whose it is
    const parent = call.host.state().state === "connected" ? rowsFrom(call.host.summaries()).find((row) => row.session === session)?.fork_of ?? null : null;
    const { index } = costsOf();
    try { chat = index.costOf(session, parent); calls = chat === null ? [] : index.calls(session, parent); } catch { chat = null; calls = []; }
    return jsonResponse({ chat: chat === null ? null : withModelWindow(chat, call.host), calls });
  }
  // `?poll=1`: a server's cold-cache poll (server/machines.ts), read with the small budget; a page keeps its own
  return jsonResponse(call.url.searchParams.get("poll") === "1" ? await hostCostsPolled(call.host) : hostCosts(call.host));
}

/**
 * The log's split measured against the model's window, as the host's own breakdown is (chats.ts
 * meteredContext, review of phase 1b): the CLI's `maxPromptTokens` (400K) is its prompt budget, not
 * the window VS Code's meter shows (528K), so an ask_user chat read 52% during its turn and ~40%
 * once it ended with nothing changed. The window of the log's last model (matched by its name after
 * the route prefix, "cc/x" = "omniroute/x"); the budget stays when the host lists none.
 */
function withModelWindow(chat: HostChatCost, host: AgentHost): HostChatCost {
  if (!chat.split || !chat.lastModel || host.state().state !== "connected") return chat;
  const bare = chat.lastModel.split("/").at(-1);
  const windows = modelsFrom(host.mirror().root).filter((model) => model.context !== null && model.context > 0 && model.id.split("/").at(-1) === bare);
  const window = windows.length > 0 ? windows[0]!.context! : null;
  return window === null ? chat : { ...chat, split: { ...chat.split, tokenLimit: window } };
}

/**
 * hostCosts for a server-driven poll (ZAC-260 review): reads of POLL_BYTES_PER_SCAN at most, a
 * yield between them, up to POLL_READS_PER_TICK while the index is not complete, so the first
 * scan of a big store never holds the event loop for more than one small read.
 */
export async function hostCostsPolled(host: Pick<AgentHost, "state" | "summaries">): Promise<{ chats: HostChatCost[]; complete: boolean }> {
  let answer = hostCosts(host, POLL_BYTES_PER_SCAN);
  for (let reads = 1; !answer.complete && reads < POLL_READS_PER_TICK; reads++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer = hostCosts(host, POLL_BYTES_PER_SCAN);
  }
  return answer;
}

/**
 * Every chat this PC's index has read, under its host row's session id (what GET costs answers):
 * the local PC's cold-cache alert reads it directly (server/index.ts, ZAC-260).
 */
export function hostCosts(host: Pick<AgentHost, "state" | "summaries">, bytes?: number): { chats: HostChatCost[]; complete: boolean } {
  const { index, agentDirs } = costsOf();
  let answer: { chats: HostChatCost[]; complete: boolean };
  try { answer = index.all(bytes); } catch { return { chats: [], complete: false }; }
  // the host's rows by the SDK session they run on; a host that is down has none to name
  const rowBySdk = new Map<string, string>();
  const rows = host.state().state === "connected" ? rowsFrom(host.summaries()) : [];
  const logged = new Set(answer.chats.map((chat) => chat.session.slice(chat.session.indexOf(":/") + 2)));
  for (const row of rows) {
    const sdk = sdkOfRow(row.session, agentDirs, row.fork_of ?? null, (uuid) => logged.has(uuid));
    // the first row wins: one log is never answered twice
    if (sdk !== null && !rowBySdk.has(sdk)) rowBySdk.set(sdk, row.session);
  }
  const chats = answer.chats.map((chat) => {
    const sdk = chat.session.slice(chat.session.indexOf(":/") + 2);
    const row = rowBySdk.get(sdk);
    return row === undefined ? chat : { ...chat, session: row };
  });
  return { chats, complete: answer.complete };
}

async function readChanges(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  connected(call.host);
  const found = await changesetOf(call, session);
  if (found === null) return jsonResponse({ changes: null });
  const files = found.state.files.map((file) => ({
    id: file.id, path: changePath(file.edit), kind: changeKindOf(file.edit), added: file.edit.diff?.added ?? 0, removed: file.edit.diff?.removed ?? 0,
  }));
  const changes: HostChanges = {
    label: found.label, status: found.state.status, files,
    added: files.reduce((sum, each) => sum + each.added, 0), removed: files.reduce((sum, each) => sum + each.removed, 0),
  };
  return jsonResponse({ changes });
}

/** One changed file's two sides, by its id in the changeset: what it was at the changeset's base, and now. */
async function readChangeDiff(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  const ref = call.url.searchParams.get("ref") ?? "";
  if (ref === "") return badRequest("missing_ref", "ref is required");
  connected(call.host);
  const file = (await changesetOf(call, session))?.state.files.find((each) => each.id === ref);
  if (!file) return noRef("changed file");
  return diffOf(call.host, file.edit as ToolResultFileEditContent);
}

async function listModels(call: Call): Promise<Response> {
  connected(call.host);
  const session = call.url.searchParams.get("session");
  // a session's agents are in its state, which the mirror holds while the session is watched
  if (session) await watched(call, session);
  const agents = session ? agentsFrom(call.host.mirror().getSession(ownerOf(call.host, session))) : [];
  return jsonResponse({ models: modelsFrom(call.host.mirror().root), agents });
}

// ─── Sends ───────────────────────────────────────────────────────────────────

function messageFrom(root: RootState, words: string, model: { id: string; effort?: string } | undefined, agent: string | null, attachments: MessageAttachment[] = []): Message {
  return {
    text: words,
    origin: { kind: MessageKind.User },
    ...(model ? { model: modelSelection(root, model) } : {}),
    ...(agent ? { agent: { uri: agent } } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** The chat's working folder on this PC, or null. */
const folderOf = (host: AgentHost, session: string): string | null => {
  const listed = rowsFrom(host.summaries()).find((row) => row.session === session);
  if (listed) return listed.cwd;
  // a chat made empty is not listed before its first message: its own state names the folder
  const uri = host.mirror().getSession(ownerOf(host, session))?.workingDirectories?.[0];
  if (!uri?.startsWith("file:")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
};

/** The image types an attachment is embedded as, by extension, when the phone names none (an "@" pick). */
const IMAGE_BY_EXTENSION: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * The message's attachments, as VS Code sends them: an image embedded (base64, read back from the
 * file), any other file a resource the host reads by its file:// URI. Only files inside the chat's
 * own folder are taken: one chat/upload wrote (under `.ovis/`), or one picked with "@"
 * (a path relative to the folder, as the file source gives it). Symlinks are followed before the
 * check, so a link inside cannot hand out a file outside.
 */
function attachmentsOf(value: unknown, host: AgentHost, session: string): MessageAttachment[] {
  if (value === undefined) return [];
  const bad = (): never => refuse(badRequest("invalid_attachment", "attachments must be files of this chat's folder: [{ path, media_type?, name? }]"));
  if (!Array.isArray(value)) return bad();
  const folder = folderOf(host, session);
  if (folder === null) return bad();
  let root: string;
  try { root = realpathSync(folder); } catch { return bad(); }
  return value.map((each): MessageAttachment => {
    if (!isJsonObject(each) || !text(each["path"]) || each["path"] === "") return bad();
    const mediaType = each["media_type"];
    const name = each["name"];
    if ((mediaType !== undefined && !text(mediaType)) || (name !== undefined && !text(name))) return bad();
    let path: string;
    try { path = realpathSync(resolve(root, each["path"])); } catch { return bad(); }
    if (!path.startsWith(root + sep)) return bad();
    // the file's own name, as the user picked it; an uploaded one is stored under a stamped name
    const label = name && name.trim() !== "" ? name : basename(path);
    const contentType = mediaType && mediaType !== "" ? mediaType : IMAGE_BY_EXTENSION[extname(path).toLowerCase()];
    if (contentType?.startsWith("image/")) {
      // embedded whole in the message: refused past the attachment limit before it is read
      if (statSync(path).size > MAX_ATTACHMENT_BYTES) refuse(jsonResponse({ error: { code: "image_too_large", message: `file exceeds ${MAX_ATTACHMENT_BYTES} bytes` } }, 413));
      return { type: MessageAttachmentKind.EmbeddedResource, label, displayKind: "image", data: readFileSync(path).toString("base64"), contentType } as MessageAttachment;
    }
    return { type: MessageAttachmentKind.Resource, label, displayKind: "document", uri: pathToFileURL(path).href, ...(contentType ? { contentType } : {}) } as MessageAttachment;
  });
}

/** Writes an attached file into the chat's folder (`<cwd>/.ovis/`, as a pane's): its path. */
async function uploadFile(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const { name, media_type: mediaType, data } = call.body;
  if (!text(mediaType) || mediaType === "" || !text(data) || (name !== undefined && !text(name))) return badRequest("invalid_upload", "give media_type and data (base64), and name");
  connected(call.host);
  if (!known(call.host, session)) missing();
  const folder = folderOf(call.host, session);
  // a folder that is gone is not made again: the chat's own folder is the PC's to have
  let isFolder = false;
  try { isFolder = folder !== null && statSync(folder).isDirectory(); } catch { /* gone */ }
  if (!isFolder) return conflictResponse("no_folder", "this chat has no folder on its PC to put a file in");
  try {
    return jsonResponse({ path: await saveAttachment({ cwd: async () => folder, contentType: mediaType, dataBase64: data, ...(name ? { name } : {}) }) });
  } catch (error) {
    if (error instanceof PasteImageError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    const code = (error as { code?: unknown }).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return conflictResponse("folder_not_writable", "this chat's folder on its PC cannot be written to");
    throw error;
  }
}

/** The chat's shared draft with this model: its text and attachments kept. */
function draftWith(chat: ChatState, model: ModelSelection): StateAction {
  const current = chat.draft;
  return { type: ActionType.ChatDraftChanged, draft: { ...current, text: current?.text ?? "", origin: { kind: MessageKind.User }, model } } as StateAction;
}

/** What the chat already has under `id`: a turn (active or past), a pending message, or nothing. */
function alreadyHas(chat: ChatState, id: string): { queued: boolean } | null {
  if (chat.activeTurn?.id === id || chat.turns.some((turn) => turn.id === id)) return { queued: false };
  if (chat.steeringMessage?.id === id || (chat.queuedMessages ?? []).some((pending) => pending.id === id)) return { queued: true };
  return null;
}

/**
 * Dispatches `message` once under the phone's `id`: a new turn on an idle chat (its turnId), else
 * a queued message (its id). An id this host already sent, or the chat already has, dispatches
 * nothing: the answer is the first one's (queued while still pending).
 */
function send(host: AgentHost, session: string, channel: string, chat: ChatState, message: Message, id: string, mode: "send" | "steer" | "queue" = "send"): { queued: boolean; joined?: true } {
  const had = alreadyHas(chat, id);
  if (had) return had;
  // sent by this bridge, and no longer in the chat under its id: a queued message that has since
  // started its turn (under a turn id of the host's own)
  if (sentOf(host).get(id)) return { queued: false };
  const queued = chat.activeTurn !== undefined;
  // after a restore the chat is cut back to before the restored turn first (VS Code's chat/truncated
  // ahead of chat/turnStarted); Start Over clears it all
  const restored = queued ? undefined : restoredOf(host).get(session);
  if (restored) {
    host.dispatch(channel, (restored.previous === null ? { type: ActionType.ChatTruncated } : { type: ActionType.ChatTruncated, turnId: restored.previous }) as StateAction);
    restoredOf(host).delete(session);
  }
  // a chat holds one steering message: a second steer joins it, under its id (VS Code's rule)
  const steering = queued && mode === "steer" ? chat.steeringMessage : undefined;
  // the joined steer keeps both messages' attachments, the first's first: nothing given is dropped
  const joinedAttachments = [...(steering?.message.attachments ?? []), ...(message.attachments ?? [])];
  const pending = steering ? { ...message, text: `${steering.message.text}\n\n${message.text}`, ...(joinedAttachments.length > 0 ? { attachments: joinedAttachments } : {}) } : message;
  host.dispatch(channel, (queued
    ? { type: ActionType.ChatPendingMessageSet, kind: mode === "steer" ? PendingMessageKind.Steering : PendingMessageKind.Queued, id: steering?.id ?? id, message: pending }
    : { type: ActionType.ChatTurnStarted, turnId: id, startedAt: new Date().toISOString(), message }) as StateAction);
  sentOf(host).add(id, session);
  if (message.model) {
    // the message is out; a draft that fails to follow must not make the phone think it was not sent
    try { host.dispatch(channel, draftWith(chat, message.model)); } catch { /* the next model choice writes it */ }
  }
  return steering ? { queued, joined: true } : { queued };
}

async function sendMessage(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const id = idOf(call.body["id"]);
  const listed = Array.isArray(call.body["attachments"]) && call.body["attachments"].length > 0;
  const words = messageText(call.body["text"], listed);
  const model = modelOf(call.body["model"]);
  const agent = agentOf(call.body["agent"]);
  const mode = modeOf(call.body["mode"]);
  const { channel, chat } = await watched(call, session);
  const message = messageFrom(call.host.mirror().root, words, model, agent, attachmentsOf(call.body["attachments"], call.host, session));
  if (mode !== "stop_and_send" || chat.activeTurn === undefined || alreadyHas(chat, id) || sentOf(call.host).get(id)) {
    return jsonResponse(send(call.host, session, channel, chat, message, id, mode === "stop_and_send" ? "send" : mode));
  }
  // Stop and Send: the running turn is cancelled, and the text starts the next one once it has ended
  // (queued messages stay queued); a turn that does not end in time sends nothing
  call.host.dispatch(channel, { type: ActionType.ChatTurnCancelled, turnId: chat.activeTurn.id, duration: 0 } as StateAction);
  await ended(call, session);
  const now = call.host.chat(session);
  if (!now || now.activeTurn !== undefined) return conflictResponse("turn_still_running", "the turn did not stop in time: nothing was sent");
  const sent = send(call.host, session, channel, now, message, id);
  void restartIfStolen(call, session, channel, message, id);
  return jsonResponse(sent);
}

/**
 * After a cancel the host's SDK abort settles in the background, and its idle can land on the turn
 * started next and complete it before any reply (REPLACEMENT_WATCH_MS). The turn under `id` that ends
 * with no response within the window is started again once, under a fresh id, with the same message:
 * what the owner did by hand. A turn that replies, is still running at the deadline, or was cut by a
 * later send is left alone.
 */
async function restartIfStolen(call: Call, session: string, channel: string, message: Message, id: string): Promise<void> {
  let late = false;
  const timer = call.clock.setTimeout(() => { late = true; }, REPLACEMENT_WATCH_MS);
  try {
    while (!late) {
      const chat = call.host.chat(session);
      if (!chat) return;
      if (chat.activeTurn?.id === id) {
        if (chat.activeTurn.responseParts.length > 0) return;
      } else {
        const done = chat.turns.find((turn) => turn.id === id);
        // ended empty, and nothing else has started since: the late idle took it
        if (done && done.responseParts.length === 0 && chat.activeTurn === undefined) {
          const again = randomUUID();
          sentOf(call.host).add(again, session);
          call.host.dispatch(channel, { type: ActionType.ChatTurnStarted, turnId: again, startedAt: new Date().toISOString(), message } as StateAction);
        }
        if (done || chat.activeTurn !== undefined) return;
      }
      await Bun.sleep(10); // fixed wait: one poll step
    }
  } finally { call.clock.clearTimeout(timer); }
}

/** Polls the mirror until the session's turn has ended, or STOP_AND_SEND_WAIT_MS on the call's clock. */
async function ended(call: Call, session: string): Promise<void> {
  let late = false;
  const timer = call.clock.setTimeout(() => { late = true; }, STOP_AND_SEND_WAIT_MS);
  try {
    // a poll of the mirror, bounded by the clock's deadline above
    while (!late && call.host.chat(session)?.activeTurn !== undefined) await Bun.sleep(10); // fixed wait: one poll step
  } finally { call.clock.clearTimeout(timer); }
}

// ─── The session's mode and permissions ──────────────────────────────────────

/** The host's config keys for the chat's mode and its approvals (VS Code's SessionConfigKey). */
const MODE_KEY = "mode";
const APPROVALS_KEY = "autoApprove";
const APPROVAL_MODES_KEY = "availableApprovalModes";

interface SessionConfig { schema: { properties: Record<string, { enum?: unknown[] }> }; values: Record<string, unknown> }
const configOf = (host: AgentHost, session: string): SessionConfig | undefined =>
  (host.mirror().getSession(ownerOf(host, session)) as { config?: SessionConfig } | undefined)?.config;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** What the chat's mode and approvals can be, and are: approvals the host offers this session (availableApprovalModes), else its schema's. */
/** The chat's approvals for a new chat to start on (a hand-off's): only a value the host offers, else none (its default). */
function inheritedApprovals(host: AgentHost, session: string): string | null {
  const { approvals, approvalModes } = configChoices(configOf(host, session));
  return approvals !== null && approvalModes.includes(approvals) ? approvals : null;
}

function configChoices(config: SessionConfig | undefined): { mode: string | null; approvals: string | null; modes: string[]; approvalModes: string[] } {
  const value = (key: string): string | null => typeof config?.values[key] === "string" ? config.values[key] as string : null;
  const offered = strings(config?.values[APPROVAL_MODES_KEY]);
  return {
    mode: value(MODE_KEY),
    approvals: value(APPROVALS_KEY),
    modes: strings(config?.schema.properties[MODE_KEY]?.enum),
    approvalModes: offered.length > 0 ? offered : strings(config?.schema.properties[APPROVALS_KEY]?.enum),
  };
}

/** The chat's folder's files for "@", as a pane chat lists its own (server/files.ts paneFiles). */
async function listFiles(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  connected(call.host);
  if (!known(call.host, session)) missing();
  const limit = Number(call.url.searchParams.get("limit") ?? "20");
  if (!Number.isInteger(limit) || limit < 1) return badRequest("invalid_limit", "limit must be a positive integer");
  const cwd = rowsFrom(call.host.summaries()).find((row) => row.session === session)?.cwd ?? null;
  if (cwd === null) return jsonResponse({ files: [] });
  return jsonResponse({ files: await paneFiles(cwd, call.url.searchParams.get("q") ?? "", Math.min(limit, 100)) });
}

async function readConfig(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  await watched(call, session);
  return jsonResponse(configChoices(configOf(call.host, session)));
}

/** Sets the chat's mode or approvals: only the keys given, merged (session/configChanged), as VS Code's pickers do. */
async function writeConfig(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  await watched(call, session);
  const choices = configChoices(configOf(call.host, session));
  const config: Record<string, string> = {};
  const mode = call.body["mode"];
  if (mode !== undefined) {
    if (!text(mode) || !choices.modes.includes(mode)) return badRequest("invalid_mode", `mode must be one of ${choices.modes.join(", ") || "(none on this chat)"}`);
    config[MODE_KEY] = mode;
  }
  const approvals = call.body["approvals"];
  if (approvals !== undefined) {
    if (!text(approvals) || !choices.approvalModes.includes(approvals)) return badRequest("invalid_approvals", `approvals must be one of ${choices.approvalModes.join(", ") || "(none on this chat)"}`);
    config[APPROVALS_KEY] = approvals;
  }
  if (Object.keys(config).length === 0) return badRequest("missing_config", "give mode or approvals");
  // the mode and approvals are the session's: a fork's are its session's
  call.host.dispatch(ownerOf(call.host, session), { type: ActionType.SessionConfigChanged, config } as StateAction);
  return jsonResponse({ ok: true });
}

async function stopTurn(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const { channel, chat } = await watched(call, session);
  if (chat.activeTurn) call.host.dispatch(channel, { type: ActionType.ChatTurnCancelled, turnId: chat.activeTurn.id, duration: 0 } as StateAction);
  return jsonResponse({ ok: true });
}

/** VS Code's Try Again: chat/turnResume on the latest turn, only while it stands stopped at a resumable error. */
async function resumeTurn(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const { channel, chat } = await watched(call, session);
  const last = chat.activeTurn ? undefined : chat.turns.at(-1);
  const stop = last?.state === TurnState.Error ? last.responseParts.at(-1) : undefined;
  if (!last || stop?.kind !== ResponsePartKind.Error || stop.resumable !== true) return conflictResponse("not_resumable", "the chat's last turn did not stop at an error it can resume from");
  call.host.dispatch(channel, { type: ActionType.ChatTurnResume, turnId: last.id } as StateAction);
  return jsonResponse({ ok: true });
}

// ─── Checkpoints (VS Code's Restore Checkpoint, Start Over and Redo) ─────────

/** The file a side of an edit names, its content read through the host (session-db: refs). */
/**
 * A resource's bytes through the host, asked for as base64: unasked, VS Code's host sends a file as
 * UTF-8 text, which turns a picture's (or a binary edit side's) bytes into replacement characters.
 */
async function contentAt(host: AgentHost, uri: string): Promise<{ data: string; encoding: string }> {
  const read = await host.request("resourceRead", { channel: "ahp-root://", uri, encoding: "base64" } as never) as { data: string; encoding: string };
  return { data: read.data, encoding: read.encoding };
}

/**
 * Puts one edit's file as it was before it (undo) or after it (redo), as VS Code's
 * AgentHostSnapshotController does: a created file is deleted on undo, a deleted one written back,
 * a renamed one moved; an edit writes the side's content.
 */
async function applySide(host: AgentHost, edit: ToolResultFileEditContent, side: "before" | "after"): Promise<void> {
  const other = side === "before" ? edit.after : edit.before;
  const target = edit[side];
  // the other side's file is not this side's (a create, a delete, a rename): it goes
  if (other !== undefined && other.uri !== target?.uri) await host.request("resourceDelete", { channel: "ahp-root://", uri: other.uri } as never);
  if (target === undefined) return;
  const content = await contentAt(host, target.content.uri);
  await host.request("resourceWrite", { channel: "ahp-root://", uri: target.uri, data: content.data, encoding: content.encoding } as never);
}

async function restoreCheckpoint(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const turn = call.body["turn"];
  if (!text(turn) || turn === "") return badRequest("missing_turn", "turn is required");
  const { chat } = await watched(call, session);
  if (chat.activeTurn) return conflictResponse("turn_running", "stop the running turn before restoring a checkpoint");
  const at = chat.turns.findIndex((each) => each.id === turn);
  if (at < 0) return jsonResponse({ error: { code: "unknown_turn", message: "the chat has no such turn loaded" } }, 404);
  // a checkpoint restored before is redone first: the files start from the chat's last turn
  const earlier = restoredOf(call.host).get(session);
  if (earlier) for (const edit of [...earlier.undone].reverse()) await applySide(call.host, edit, "after");
  restoredOf(call.host).delete(session);
  const undone = chat.turns.slice(at).flatMap((each) => turnEdits(each)).reverse();
  for (const edit of undone) await applySide(call.host, edit, "before");
  restoredOf(call.host).set(session, { turn, previous: chat.turns[at - 1]?.id ?? null, undone });
  return jsonResponse({ files: new Set(undone.map(fileOf)).size });
}

async function redoCheckpoint(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  await watched(call, session);
  const restored = restoredOf(call.host).get(session);
  if (!restored) return conflictResponse("nothing_to_redo", "no checkpoint is restored on this chat");
  for (const edit of [...restored.undone].reverse()) await applySide(call.host, edit, "after");
  restoredOf(call.host).delete(session);
  return jsonResponse({ files: new Set(restored.undone.map(fileOf)).size });
}

/** The chat's pending message under `id`, and its kind; null when the chat holds none. */
function pendingById(chat: ChatState, id: string): { kind: PendingMessageKind; message: Message } | null {
  if (chat.steeringMessage?.id === id) return { kind: PendingMessageKind.Steering, message: chat.steeringMessage.message as Message };
  // VS Code's host also lists its steer in the queue, as kind "steering", and removes by kind
  const listed = (chat.queuedMessages ?? []).find((pending) => pending.id === id) as { kind?: string; message: Message } | undefined;
  if (!listed) return null;
  return { kind: listed.kind === "steering" ? PendingMessageKind.Steering : PendingMessageKind.Queued, message: listed.message };
}

async function removePending(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const id = call.body["id"];
  if (!text(id) || id === "") return badRequest("missing_id", "id is required");
  const { channel, chat } = await watched(call, session);
  const held = pendingById(chat, id);
  if (held === null) return conflictResponse("pending_gone", "the chat no longer holds that message");
  call.host.dispatch(channel, { type: ActionType.ChatPendingMessageRemoved, kind: held.kind, id } as StateAction);
  return jsonResponse({ ok: true });
}

/**
 * VS Code's Send Immediately on a waiting message (chatServiceImpl sendPendingRequestImmediately,
 * server-managed queue): take it off first, so the host does not also send it as the turn ends,
 * cancel the running turn, then start a turn with it under its own id. A turn that does not end in
 * time puts it back as it was, so a refused send loses nothing.
 */
async function sendPendingNow(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const id = call.body["id"];
  if (!text(id) || id === "") return badRequest("missing_id", "id is required");
  const { channel, chat } = await watched(call, session);
  const held = pendingById(chat, id);
  if (held === null) return conflictResponse("pending_gone", "the chat no longer holds that message");
  call.host.dispatch(channel, { type: ActionType.ChatPendingMessageRemoved, kind: held.kind, id } as StateAction);
  if (chat.activeTurn !== undefined) {
    call.host.dispatch(channel, { type: ActionType.ChatTurnCancelled, turnId: chat.activeTurn.id, duration: 0 } as StateAction);
    await ended(call, session);
  }
  const now = call.host.chat(session);
  if (!now || now.activeTurn !== undefined) {
    call.host.dispatch(channel, { type: ActionType.ChatPendingMessageSet, kind: held.kind, id, message: held.message } as StateAction);
    return conflictResponse("turn_still_running", "the turn did not stop in time: the message waits as it was");
  }
  // a steer or queued message the phone sent through this bridge is remembered as sent under the
  // same id, and send() takes a remembered id for a repeat: without this Send now stopped the turn
  // and sent nothing
  sentOf(call.host).forget(id);
  send(call.host, session, channel, now, held.message, id);
  void restartIfStolen(call, session, channel, held.message, id);
  return jsonResponse({ ok: true });
}

/**
 * VS Code's Stop on a background shell: its extension request `vscode/stopBackgroundWork {chat, id}`,
 * only for a shell the host marks stoppable (`_meta["vscode.stopBackgroundWork"]`), as VS Code offers it.
 */
async function stopBackground(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const id = call.body["id"];
  if (!text(id) || id === "") return badRequest("missing_id", "id is required");
  const { channel, chat } = await watched(call, session);
  const entry = workOf((chat as { backgroundWork?: readonly unknown[] }).backgroundWork).find((each) => each.id === id);
  if (entry?.stoppable !== true) return conflictResponse("not_stoppable", "the chat runs no work by that id that can be stopped");
  const answer = await call.host.request("vscode/stopBackgroundWork" as never, { chat: channel, id } as never) as { stopped?: unknown };
  return jsonResponse({ stopped: answer?.stopped === true });
}

async function writeDraft(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const model = modelOf(call.body["model"]) ?? refuse(badRequest("invalid_model", "model is required"));
  const { channel, chat } = await watched(call, session);
  call.host.dispatch(channel, draftWith(chat, modelSelection(call.host.mirror().root, model)));
  return jsonResponse({ ok: true });
}

/** The phone left a chat it opened empty: it goes if it still has no message; any other chat is left be. */
async function discardChat(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  connected(call.host);
  const discarded = await dropIfEmpty(call.host, session);
  if (discarded) call.leases.sessions.release(session);
  return jsonResponse({ discarded });
}

async function newChat(call: Call): Promise<Response> {
  const cwd = call.body["cwd"];
  if (!text(cwd) || !isAbsolute(cwd)) return badRequest("invalid_cwd", "cwd must be an absolute path");
  const id = idOf(call.body["id"]);
  // no text: VS Code's New Chat, the chat opened empty for its own composer to send the first message
  const empty = call.body["text"] === undefined;
  const words = empty ? "" : messageText(call.body["text"]);
  const model = modelOf(call.body["model"]);
  const agent = agentOf(call.body["agent"]);
  connected(call.host);
  return jsonResponse(await createChatWith(call, id, cwd, empty ? null : messageFrom(call.host.mirror().root, words, model, agent)));
}

/**
 * Makes the session the id names in `cwd` and sends `message` as its first turn (none: VS Code's
 * New Chat, left empty). The phone's id names the session: a retry of a chat already made makes
 * nothing. `sent: false` when the session exists but its message did not go.
 */
/**
 * `approvals`: the new chat's autoApprove, a hand-off's taken from the chat it continues. Without it
 * the host starts the chat on Manual permissions, and the next chat's first command (digest.py,
 * `git log`) waited on "Run in terminal?" while the owner thought it was reading (ZAC-266, 2026-10-31).
 */
async function createChatWith(call: Call, id: string, cwd: string, message: Message | null, approvals: string | null = null, title: string | null = null, then: Message | null = null): Promise<{ session: string; sent?: false }> {
  const session = `${PROVIDER}:/${id}`;
  if (known(call.host, session)) return message === null ? { session } : await madeBefore(call, session);
  await call.host.request("createSession", {
    channel: session, provider: PROVIDER, workingDirectories: [pathToFileURL(cwd).href], config: { isolation: "folder", ...(approvals ? { [APPROVALS_KEY]: approvals } : {}) },
  });
  if (message === null) {
    emptiesOf(call.host).add(session);
    await call.leases.sessions.take(session);
    return { session };
  }
  // the session exists from here on: whatever fails next, the phone is told which one, so it opens
  // that chat (the message still in its composer) instead of retrying into a second, empty one
  try {
    await call.leases.sessions.take(session);
    const channel = call.host.mirror().getSession(session)?.defaultChat;
    const chat = call.host.chat(session);
    if (!channel || !chat) return { session, sent: false };
    if (title !== null) nameChat(call, session, title);
    send(call.host, session, channel, chat, message, id);
  } catch (error) {
    console.warn(`agent-host: chat/new made ${session} but its first message did not go (${errorName(error)})`);
    return { session, sent: false };
  }
  // a hand-off's message (ZAC-267): queued behind the first, so it runs once /resume has read the old
  // chat. Losing it leaves the new chat working on its /resume: the hand-off itself went
  if (then !== null) queueAfterFirst(call, session, then);
  return { session };
}

function queueAfterFirst(call: Call, session: string, message: Message): void {
  try {
    const channel = call.host.mirror().getSession(session)?.defaultChat;
    if (!channel) throw new Error("no chat");
    call.host.dispatch(channel, { type: ActionType.ChatPendingMessageSet, kind: PendingMessageKind.Queued, id: randomUUID(), message } as StateAction);
  } catch (error) {
    console.warn(`agent-host: ${session}'s hand-off message was not queued (${errorName(error)})`);
  }
}

/**
 * Names a new chat as the user's rename does (renameChat): the host marks the title renamed, so
 * neither its seed from the first message nor its title reminders replace it (VS Code 1.142's
 * title controller, markTitleRenamed). Sent before the first message, so the seed never lands.
 * A failure leaves the host's own title: the chat itself is made.
 */
function nameChat(call: Call, session: string, title: string): void {
  try {
    call.host.dispatch(session, { type: ActionType.SessionTitleChanged, title } as StateAction);
  } catch (error) {
    console.warn(`agent-host: could not name ${session} (${errorName(error)})`);
  }
}

/** How long a fork waits for the host's catalog to list it after createChat answers. */
const FORK_WAIT_MS = 5_000;

/**
 * VS Code's Fork Conversation: a new chat in the same session with the chat's turns before `turn`
 * (the request it is forked at, as VS Code forks "before" a request: createChat with the turn
 * before it), listed beside it by its chat URI. The phone's id names the fork, so a retry makes
 * nothing. Refused on the first turn (nothing before it) and on an agent that does not fork.
 */
async function forkChat(call: Call): Promise<Response> {
  const id = sessionOf(call.body);
  const turn = call.body["turn"];
  if (!text(turn) || turn === "") return badRequest("missing_turn", "turn is required");
  const forkId = idOf(call.body["id"]);
  const { channel, chat } = await watched(call, id);
  const session = ownerOf(call.host, id);
  const provider = call.host.summaries().find((summary) => summary.resource === session)?.provider ?? PROVIDER;
  const agent = call.host.mirror().root.agents.find((each) => each.provider === provider);
  if (agent?.capabilities?.multipleChats?.fork !== true) return conflictResponse("fork_unsupported", "this PC's agent does not fork chats");
  const at = chat.turns.findIndex((each) => each.id === turn);
  if (at < 0) return jsonResponse({ error: { code: "unknown_turn", message: "the chat has no such turn loaded" } }, 404);
  if (at === 0) return conflictResponse("first_turn", "there is nothing before the first request to fork");
  const tail = (call.host.mirror().getSession(session)?.defaultChat ?? "").replace(/^ahp-chat:\/\/[^/]*\//, "");
  const fork = `ahp-chat://${forkId}/${tail}`;
  if (!isFork(call.host, fork)) {
    await call.host.request("createChat", { channel: session, chat: fork, source: { kind: ChatSourceKind.Fork, chat: channel, turnId: chat.turns[at - 1]!.id } } as never);
    await settle(() => isFork(call.host, fork), FORK_WAIT_MS);
    if (!isFork(call.host, fork)) return jsonResponse({ error: { code: "agent_host_failed", message: "the agent host did not list the fork" } }, 502);
  }
  return jsonResponse({ session: fork });
}

/**
 * A new chat asked for again (its answer was lost): nothing is made or sent. `sent: false` when the
 * chat has no turn and no pending message, so the phone keeps the words for the user to send once.
 */
async function madeBefore(call: Call, session: string): Promise<{ session: string; sent?: false }> {
  if (sentOf(call.host).has(session)) return { session };
  try {
    await call.leases.sessions.take(session);
    const chat = call.host.chat(session);
    if (chat && (chat.activeTurn !== undefined || chat.turns.length > 0 || chat.steeringMessage !== undefined || (chat.queuedMessages ?? []).length > 0)) return { session };
  } catch { /* it cannot be read now: the words stay with the phone */ }
  return { session, sent: false };
}

/** An error's name for a log line: never its message, which can carry a transport's URL. */
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;

// ─── Hand off & continue ─────────────────────────────────────────────────────

/** A `/handoff` this recent as the chat's newest message refuses another: a re-tap after a lost job writes no second note. */
const RECENT_HANDOFF_MS = 60 * 60_000;
/** The commands that write a hand-off note: the harness plugin's skill, by either name (costs.ts counts both). */
const HANDOFF_MESSAGE = /^\/(?:harness:)?handoff\b/;
/** A question answered with the hand-off words (askHandoffText): the same ask as a `/handoff` message. */
const HANDOFF_ANSWER = /^Hand off now: run \//;

/** The question a running turn waits on that takes a typed answer: the first open request's current one, else null. */
function askedQuestion(chat: ChatState): { request: ChatInputRequest; question: ChatInputQuestion } | null {
  const request = openRequests(chat)[0];
  const question = request && currentQuestion(request);
  if (!request || !question) return null;
  // the hand-off words go as a typed answer: a yes/no, a number or a closed choice cannot take them
  try { valueFor(question, [], askHandoffText("/handoff")); } catch { return null; }
  return { request, question };
}

/** The typed answers of the questions a turn asked, answered or still drafted. */
function typedAnswers(turn: { responseParts: Turn["responseParts"] }): string[] {
  return turn.responseParts.flatMap((part) => {
    if (part.kind !== ResponsePartKind.InputRequest) return [];
    return Object.values(part.request.answers ?? {}).flatMap((answer) => {
      if (answer.state !== ChatInputAnswerState.Submitted) return [];
      const value = answer.value;
      return value.kind === ChatInputAnswerValueKind.Text ? [value.value]
        : value.kind === ChatInputAnswerValueKind.Selected || value.kind === ChatInputAnswerValueKind.SelectedMany ? value.freeformValues ?? [] : [];
    });
  });
}

/**
 * A hand-off asked for less than RECENT_HANDOFF_MS ago: the newest turn's message is a `/handoff`,
 * or one of its questions was answered with the hand-off words (the running turn's, or the last
 * one's when it ended that recently).
 */
function recentHandoff(chat: ChatState): boolean {
  const newest = chat.turns.at(-1);
  const at = Date.parse(newest?.startedAt ?? "");
  if (newest && HANDOFF_MESSAGE.test(newest.message.text.trim()) && Date.now() - at < RECENT_HANDOFF_MS) return true;
  if (chat.activeTurn) return typedAnswers(chat.activeTurn).some((each) => HANDOFF_ANSWER.test(each.trim()));
  return newest !== undefined && Date.now() - (at + (newest.duration ?? 0)) < RECENT_HANDOFF_MS && typedAnswers(newest).some((each) => HANDOFF_ANSWER.test(each.trim()));
}

/**
 * Hand off & continue (handoff.ts): answers at once with the job, which runs on. A job already
 * running for the chat is that job (its own `/handoff` turn makes the chat busy). A chat whose turn
 * waits on its own question (ask_user) is asked through it: the question is answered with the
 * hand-off words (askHandoffText) and the job reads the agent's text after them. Refused: a busy
 * chat that asks nothing, one without the hand-off skill (handoffCommand: `handoff` or
 * `harness:handoff`), and one that asked for a hand-off within RECENT_HANDOFF_MS (recentHandoff).
 */
async function handOff(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const then = handoffMessageOf(call.body);
  const running = handoffJob(call.host, session);
  if (handoffRunning(running)) return jsonResponse({ job: running });
  const { channel, chat: watchedChat } = await watched(call, session);
  if (watchedChat.activeTurn !== undefined && askedQuestion(watchedChat) === null) return conflictResponse("busy", "the chat is working: hand off when it asks or stops");
  // the customizations first; the plugins' skills are only in the host's "/" completions (sessionSkills)
  // a plugin's skill is listed namespaced there (`harness:handoff`): handoffCommand names what to send from both
  // lists, as the chat's own "/" commands join them. A plain `handoff` among the customizations needs no completions
  const customized = commandsFrom(call.host.mirror().getSession(ownerOf(call.host, session)));
  const plain = handoffCommand(customized);
  const named = plain?.handoff === "/handoff" ? plain : handoffCommand([...customized, ...await sessionSkills(call.host, session)]);
  if (named === null) return conflictResponse("no_handoff", "this chat has no /handoff");
  if (recentHandoff(watchedChat)) return conflictResponse("recent_handoff", "a hand-off note was asked for less than an hour ago");
  const cwd = folderOf(call.host, session);
  if (cwd === null) return conflictResponse("no_folder", "this chat has no folder on its PC to start the next chat in");
  // the chat's current model, effort included (as HostChatRead.model reads it); its agent stays the same
  const latest = (watchedChat.activeTurn ?? watchedChat.turns.at(-1))?.message;
  const model = latest?.model ?? watchedChat.draft?.model;
  const agent = latest?.agent;
  const message = (words: string): Message => ({ text: words, origin: { kind: MessageKind.User }, ...(model ? { model } : {}) });
  // the checks above awaited: a second tap may have started the job, or a turn begun, meanwhile.
  // Nothing awaits from here to startHandoff, which holds the job at once
  const again = handoffJob(call.host, session);
  if (handoffRunning(again)) return jsonResponse({ job: again });
  const chat = call.host.chat(session) ?? missing();
  const asked = chat.activeTurn === undefined ? null : askedQuestion(chat);
  if (chat.activeTurn !== undefined && asked === null) return conflictResponse("busy", "the chat is working: hand off when it asks or stops");
  // the job's turn: a new `/handoff` one, or the running one whose question it answers. The agent's
  // text after the answer is what counts: its parts from `from` on
  const turnId = chat.activeTurn?.id ?? randomUUID();
  const from = chat.activeTurn?.responseParts.length ?? 0;
  const job = startHandoff(call.host, call.clock, session, {
    send: async () => {
      if (asked) answerWith(call.host, channel, asked.request, asked.question, typedAnswer(asked.question, askHandoffText(named.handoff)), true);
      else send(call.host, session, channel, chat, { ...message(named.handoff), ...(agent ? { agent } : {}) }, turnId);
    },
    ended: () => handoffEnded(call, session, turnId, asked ? from : null),
    start: async (topic) => {
      const made = await createChatWith(call, randomUUID(), cwd, message(`${named.resume} ${topic}`), inheritedApprovals(call.host, session), nextHandoffTitle(titleOf(call.host, session)),
        then === null ? null : { ...message(then), ...(agent ? { agent } : {}) });
      return { session: made.session, sent: made.sent !== false };
    },
    // as Stop does (stopTurn), on the job's channel; a turn the user started since is theirs. The
    // lease is taken again first: the chat must be in the mirror to know which turn runs
    cancel: async () => {
      const now = await watched(call, session);
      if (now.chat.activeTurn?.id === turnId) call.host.dispatch(now.channel, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 } as StateAction);
    },
  }, (error) => error instanceof AgentHostError ? error.code : error instanceof Refusal ? "refused" : errorName(error));
  return jsonResponse({ job });
}

/**
 * Continue in a new chat (ZAC-266, handoff.ts startContinue): the next chat starts with
 * `<resume> <cli session id>`, the old chat's CLI record read whole by the resume skill; no
 * `/handoff`, so no model call on the old side, and nothing archived. Answers at once with the job;
 * a job already running for the chat (either mode) is that job. A chat whose turn waits on a
 * question is stopped (as stopTurn), its question left unanswered. Refused (409), all before
 * anything is stopped: `busy` (a turn runs that asks nothing), `no_resume` (no `resume` or
 * `harness:resume` listed), `no_record` (no CLI session-state for the chat: cliSessionOf),
 * `no_folder`.
 */
async function continueChat(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const then = handoffMessageOf(call.body);
  const running = handoffJob(call.host, session);
  if (handoffRunning(running)) return jsonResponse({ job: running });
  const { chat: watchedChat } = await watched(call, session);
  const busy = (chat: ChatState): boolean => chat.activeTurn !== undefined && openRequests(chat).length === 0;
  if (busy(watchedChat)) return conflictResponse("busy", "the chat is working: continue when it asks or stops");
  // as handOff names its commands: the customizations first, then the plugins' skills in the "/" completions
  const customized = commandsFrom(call.host.mirror().getSession(ownerOf(call.host, session)));
  const resume = resumeCommand(customized) ?? resumeCommand(await sessionSkills(call.host, session));
  if (resume === null) return conflictResponse("no_resume", "this chat has no /resume");
  // a fork or peer chat whose id names no parent: the host's row says whose it is (as GET costs reads it)
  const parent = rowsFrom(call.host.summaries()).find((row) => row.session === session)?.fork_of ?? null;
  const cliSession = cliSessionOf(session, undefined, undefined, parent);
  if (cliSession === null) return conflictResponse("no_record", "this chat has no CLI record on its PC to resume from");
  const cwd = folderOf(call.host, session);
  if (cwd === null) return conflictResponse("no_folder", "this chat has no folder on its PC to start the next chat in");
  // the chat's current model, effort included, and its agent, as handOff takes them
  const latest = (watchedChat.activeTurn ?? watchedChat.turns.at(-1))?.message;
  const model = latest?.model ?? watchedChat.draft?.model;
  const agent = latest?.agent;
  // the checks above awaited: a second tap may have started a job, or a turn begun, meanwhile.
  // Nothing awaits from here to startContinue, which holds the job at once
  const again = handoffJob(call.host, session);
  if (handoffRunning(again)) return jsonResponse({ job: again });
  const chat = call.host.chat(session) ?? missing();
  if (busy(chat)) return conflictResponse("busy", "the chat is working: continue when it asks or stops");
  const turnId = chat.activeTurn?.id;
  const approvals = inheritedApprovals(call.host, session);
  // named after the chat it continues (ZAC-267), read now: the old chat is the one in hand
  const title = nextHandoffTitle(titleOf(call.host, session));
  const job = startContinue(call.host, call.clock, session, {
    // as Stop does (stopTurn): a cancel on a turn waiting on ask_user is no model call (verified 2026-10-31)
    stop: async () => {
      if (turnId === undefined) return;
      const now = await watched(call, session);
      if (now.chat.activeTurn?.id === turnId) call.host.dispatch(now.channel, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 } as StateAction);
    },
    start: async () => {
      const first: Message = { text: `${resume} ${cliSession}`, origin: { kind: MessageKind.User }, ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
      const made = await createChatWith(call, randomUUID(), cwd, first, approvals, title, then === null ? null : { ...first, text: then });
      return { session: made.session, sent: made.sent !== false };
    },
  }, (error) => error instanceof AgentHostError ? error.code : error instanceof Refusal ? "refused" : errorName(error));
  return jsonResponse({ job });
}

/** A response part's words: a reply's markdown, a question's message and its questions' own. */
function partText(part: Turn["responseParts"][number]): string[] {
  if (part.kind === ResponsePartKind.Markdown) return [part.content];
  if (part.kind !== ResponsePartKind.InputRequest) return [];
  return [part.request.message ?? "", ...(part.request.questions ?? []).flatMap((question) => [question.title ?? "", question.message])].filter((each) => each !== "");
}

/**
 * The text of turn `turnId`'s reply once it has ended, polled from the mirror as ended() does, or
 * null at HANDOFF_WAIT_MS on the call's clock. A question it asks is not an end: it keeps waiting,
 * except for a job that answered one (`after` set, the turn's part count when it answered): only
 * the parts from `after` on count, and a new question among them is taken as soon as it appears,
 * its words included. The chat's lease is renewed meanwhile, so its watch (and the mirror's copy) stays.
 */
async function handoffEnded(call: Call, session: string, turnId: string, after: number | null = null): Promise<string | null> {
  let late = false;
  const timer = call.clock.setTimeout(() => { late = true; }, HANDOFF_WAIT_MS);
  const textOf = (parts: Turn["responseParts"]): string => parts.slice(after ?? 0).flatMap(partText).join("\n");
  try {
    while (!late) {
      const chat = call.host.chat(session);
      const running = chat?.activeTurn?.id === turnId ? chat.activeTurn : undefined;
      if (running && after !== null && running.responseParts.slice(after).some((part) => part.kind === ResponsePartKind.InputRequest && part.response === undefined)) {
        return textOf(running.responseParts);
      }
      const done = running ? undefined : chat?.turns.find((turn) => turn.id === turnId);
      if (done) return after === null ? done.responseParts.flatMap((part) => part.kind === ResponsePartKind.Markdown ? [part.content] : []).join("\n") : textOf(done.responseParts);
      await call.leases.sessions.take(session).catch(() => undefined);
      await Bun.sleep(50); // fixed wait: one poll step
    }
    return null;
  } finally { call.clock.clearTimeout(timer); }
}

async function readHandoff(call: Call): Promise<Response> {
  const session = call.url.searchParams.get("session") ?? "";
  if (session === "") return badRequest("missing_session", "session is required");
  const job = handoffJob(call.host, session);
  return job ? jsonResponse({ job }) : jsonResponse({ error: { code: "job_not_found", message: "no hand-off job for this chat on this PC" } }, 404);
}

// ─── Questions and tool calls ────────────────────────────────────────────────

const gone = (): never => refuse(conflictResponse("prompt_changed", "the chat no longer asks that"));

const submittedAs = (value: ChatInputAnswerValue): ChatInputAnswer => ({ state: ChatInputAnswerState.Submitted, value });

/** The answer value a question takes from the phone's option ids and typed text. */
function valueFor(question: ChatInputQuestion, optionIds: string[], typed: string | undefined): ChatInputAnswerValue {
  const free = typed !== undefined && typed.trim() !== "" ? [typed] : [];
  const noAnswer = (): never => refuse(badRequest("missing_answer", "pick an option or type an answer"));
  // VS Code's rule, as the card offers it (chats.ts questionOptions): typed text unless the question says no
  const freeform = (question as { allowFreeformInput?: boolean }).allowFreeformInput !== false;
  switch (question.kind) {
    case ChatInputQuestionKind.SingleSelect: {
      const known = optionIds.find((id) => question.options.some((option) => option.id === id));
      if (!known && (free.length === 0 || !freeform)) return noAnswer();
      return { kind: ChatInputAnswerValueKind.Selected, value: known ?? "", ...(free.length && freeform ? { freeformValues: free } : {}) };
    }
    case ChatInputQuestionKind.MultiSelect: {
      const picked = optionIds.filter((id) => question.options.some((option) => option.id === id));
      if (picked.length === 0 && (free.length === 0 || !freeform)) return noAnswer();
      return { kind: ChatInputAnswerValueKind.SelectedMany, value: picked, ...(free.length && freeform ? { freeformValues: free } : {}) };
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

/**
 * A whole form's answers, as VS Code's carousel submits them: each question's from the phone; an
 * optional one left empty goes as skipped (the host reads it as no answer), a required one refuses
 * the lot before anything reaches the host.
 */
function formAnswers(questions: readonly ChatInputQuestion[], given: Record<string, unknown>): Record<string, ChatInputAnswer> {
  return Object.fromEntries(questions.map((question): [string, ChatInputAnswer] => {
    const entry = given[question.id];
    if (entry !== undefined && entry !== null && (typeof entry !== "object" || Array.isArray(entry))) refuse(badRequest("invalid_answer", "each answer must be an object or null"));
    const ids = (entry as { option_ids?: unknown } | null | undefined)?.option_ids;
    const typed = (entry as { text?: unknown } | null | undefined)?.text;
    if (ids !== undefined && !(Array.isArray(ids) && ids.every(text))) refuse(badRequest("invalid_answer", "option_ids must be strings"));
    if (typed !== undefined && !text(typed)) refuse(badRequest("invalid_answer", "text must be a string"));
    const picked = (ids as string[] | undefined)?.filter((id) => id !== "") ?? [];
    const empty = picked.length === 0 && (typeof typed !== "string" || typed.trim() === "");
    if (empty && question.required !== true) return [question.id, { state: ChatInputAnswerState.Skipped }];
    return [question.id, submittedAs(valueFor(question, picked, typed as string | undefined))];
  }));
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
  const whole = call.body["answers"];
  if (whole !== undefined && (whole === null || typeof whole !== "object" || Array.isArray(whole))) return badRequest("invalid_answer", "answers must be an object");
  if (!skip && whole === undefined && (!text(questionId) || questionId === "")) return badRequest("missing_question_id", "question_id is required");
  const { channel, chat } = await watched(call, session);
  const request = openRequests(chat).find((each) => each.id === requestId) ?? gone();
  if (skip) {
    call.host.dispatch(channel, { type: ActionType.ChatInputCompleted, requestId, response: ChatInputResponseKind.Decline } as StateAction);
    return jsonResponse({ ok: true });
  }
  const questions = request.questions ?? [];
  if (whole !== undefined) {
    call.host.dispatch(channel, { type: ActionType.ChatInputCompleted, requestId, response: ChatInputResponseKind.Accept, answers: formAnswers(questions, whole as Record<string, unknown>) } as StateAction);
    return jsonResponse({ ok: true });
  }
  const question = questions.find((each) => each.id === questionId) ?? gone();
  if (currentQuestion(request)?.id !== question.id) gone();
  answerWith(call.host, channel, request, question, submittedAs(valueFor(question, (rawIds as string[] | undefined)?.filter((id) => id !== "") ?? [], typed as string | undefined)));
  return jsonResponse({ ok: true });
}

/** A typed answer to `question`, as the card's own "type your answer" sends it. */
const typedAnswer = (question: ChatInputQuestion, words: string): ChatInputAnswer => submittedAs(valueFor(question, [], words));

/**
 * Answers `request`'s `question`. Every step is shown, `required` or not: the form completes on its
 * last unsettled question. `finish` completes it now (Hand off & continue): the questions left go as skipped.
 */
function answerWith(host: AgentHost, channel: string, request: ChatInputRequest, question: ChatInputQuestion, answer: ChatInputAnswer, finish = false): void {
  const answers = request.answers ?? {};
  const left = (request.questions ?? []).filter((each) => each.id !== question.id && !answerSettled(answers[each.id]));
  if (left.length > 0 && !finish) {
    host.dispatch(channel, { type: ActionType.ChatInputAnswerChanged, requestId: request.id, questionId: question.id, answer } as StateAction);
    return;
  }
  const done = Object.fromEntries(Object.entries(answers).filter(([, each]) => answerSettled(each)));
  const skipped = Object.fromEntries(left.map((each): [string, ChatInputAnswer] => [each.id, { state: ChatInputAnswerState.Skipped }]));
  host.dispatch(channel, { type: ActionType.ChatInputCompleted, requestId: request.id, response: ChatInputResponseKind.Accept, answers: { ...done, ...skipped, [question.id]: answer } } as StateAction);
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

// ─── Session actions ─────────────────────────────────────────────────────────
// What VS Code 1.142 sends a host at protocol 1.0 for the same menu items
// (baseAgentHostSessionsProvider.ts): the title on the session's channel (renameSession, as its
// sessions list renames), read and archived on the chat's channel (setChatReadState, archiveChat),
// and delete as disposeSession. Each takes the session's lease first: a known Copilot session only.

const flag = (value: unknown, name: string): boolean =>
  typeof value === "boolean" ? value : refuse(badRequest(`invalid_${name}`, `${name} must be true or false`));

async function renameChat(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const raw = call.body["title"];
  const title = text(raw) ? raw.trim() : "";
  if (title === "") return badRequest("missing_title", "title is required");
  await watched(call, session);
  // a fork's id is its chat's URI: the same action there renames that chat alone (probed on 1.142)
  call.host.dispatch(session, { type: ActionType.SessionTitleChanged, title } as StateAction);
  return jsonResponse({ ok: true });
}

async function markRead(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const isRead = flag(call.body["read"], "read");
  const { channel } = await watched(call, session);
  call.host.dispatch(channel, { type: ActionType.ChatIsReadChanged, isRead } as StateAction);
  return jsonResponse({ ok: true });
}

async function markArchived(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const isArchived = flag(call.body["archived"], "archived");
  const { channel } = await watched(call, session);
  archive(call.host, session, channel, isArchived);
  return jsonResponse({ ok: true });
}

function archive(host: AgentHost, session: string, channel: string, isArchived: boolean): void {
  // a fork is archived on its own chat's channel, as VS Code's archiveChat: the host takes it there
  if (isFork(host, session)) {
    host.dispatch(channel, { type: ActionType.ChatIsArchivedChanged, isArchived } as StateAction);
    return;
  }
  // on the session, as VS Code's setSessionArchived: the host refuses chat/isArchivedChanged on a
  // session's default chat ("Only a known independently manageable non-default chat can be
  // archived"), so that marked nothing and the chat came back after a reload
  host.dispatch(session, { type: ActionType.SessionIsArchivedChanged, isArchived } as StateAction);
}

/**
 * A running turn is cancelled first (VS Code's archive cancels a chat's active request the same
 * way), so the agent stops before its session goes. The duration is 0: this bridge did not time the
 * turn, and AHP forbids deriving it from timestamps (VS Code sends 0 without its own stopwatch).
 */
async function deleteChat(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  connected(call.host);
  if (!known(call.host, session)) missing();
  // a running turn is cancelled first; a listed chat the host will not open (an old one) is disposed all the same
  const open = await watched(call, session).catch((error: unknown) => {
    if (error instanceof Refusal && error.response.status === 404) return null;
    throw error;
  });
  if (open?.chat.activeTurn) call.host.dispatch(open.channel, { type: ActionType.ChatTurnCancelled, turnId: open.chat.activeTurn.id, duration: 0 } as StateAction);
  // a fork goes alone (disposeChat); its session and other chats stay
  if (isFork(call.host, session)) await call.host.request("disposeChat", { channel: session });
  else await call.host.request("disposeSession", { channel: session });
  // its watch would keep the gone session in the mirror, and known() with it
  call.leases.sessions.release(session);
  return jsonResponse({ ok: true });
}
