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
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ActionType,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  MessageAttachmentKind,
  MessageKind,
  PendingMessageKind,
  ResponsePartKind,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  TurnState,
  type ChatInputAnswer,
  type ChatInputAnswerValue,
  type ChatInputQuestion,
  type ChatState,
  type CommandMap,
  type Message,
  type MessageAttachment,
  type ModelSelection,
  type RootState,
  type SessionState,
  type SessionSummary,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import type { AgentHostState } from "../../shared/host-chats.ts";
import { paneFiles } from "../files.ts";
import { PasteImageError, saveAttachment } from "../paste.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "../http.ts";
import { agentsFrom, currentQuestion, imageOf, modelSelection, modelsFrom, openRequests, pendingToolCalls, PROVIDER, readFrom, rowsFrom, subagentChats, toolOutputOf, type ReadContext } from "./chats.ts";
import { AgentHostError } from "./connection.ts";

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
    const forget = (session: string): void => { for (const [uri, owner] of workers) if (owner === session) workers.delete(uri); };
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
  "chat": readChat,
  "models": listModels,
  "image": readImage,
  "tool-output": readToolOutput,
  "session/config": readConfig,
  "files": listFiles,
};
const POSTS: Record<string, Handler> = {
  "chat/watch": async (call) => { await watched(call, sessionOf(call.body)); return jsonResponse({ ok: true }); },
  "chat/send": sendMessage,
  "chat/upload": uploadFile,
  "chat/stop": stopTurn,
  "chat/resume": resumeTurn,
  "chat/pending/remove": removePending,
  "chat/answer": answerQuestion,
  "chat/confirm": confirmTool,
  "chat/draft": writeDraft,
  "chat/new": newChat,
  "chat/rename": renameChat,
  "chat/read": markRead,
  "chat/archive": markArchived,
  "chat/delete": deleteChat,
  "session/config": writeConfig,
};

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

function messageText(value: unknown): string {
  return text(value) && value.trim() !== "" ? value : refuse(badRequest("missing_text", "text is required"));
}

// ─── Sessions and chats ──────────────────────────────────────────────────────

function connected(host: AgentHost): void {
  if (host.state().state !== "connected") refuse(hostDown(host));
}

const missing = (): never => refuse(jsonResponse({ error: { code: "host_chat_missing", message: "no such host chat on this PC" } }, 404));

/** A Copilot CLI session the host knows; another provider's session is not one of these chats, whatever its id. */
function known(host: AgentHost, session: string): boolean {
  const provider = host.summaries().find((summary) => summary.resource === session)?.provider ?? host.mirror().getSession(session)?.provider;
  return provider === PROVIDER;
}

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
  const channel = host.mirror().getSession(session)?.defaultChat;
  const chat = host.chat(session);
  return channel && chat ? { channel, chat } : missing();
}

const titleOf = (host: AgentHost, session: string): string =>
  host.summaries().find((summary) => summary.resource === session)?.title ?? host.mirror().getSession(session)?.title ?? "";

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
function contextOf(host: AgentHost, session?: string): ReadContext {
  const names = new Map(modelsFrom(host.mirror().root).map((model) => [model.id, model.name]));
  return { chat: (uri) => host.chatAt?.(uri), modelName: (id) => names.get(id) ?? id, ...(session ? { session: () => host.mirror().getSession(session) } : {}) };
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
  return jsonResponse(readFrom(session, titleOf(call.host, session), call.host.chat(session) ?? chat, contextOf(call.host, session)));
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
  const image = imageOf(chat, ref);
  if (!image) return noRef("image");
  // a running call's content can still change under the same ref
  return new Response(new Uint8Array(image.bytes), { headers: { "content-type": image.media_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

/** A tool call's whole output, by its `output_ref` (the call's id). */
async function readToolOutput(call: Call): Promise<Response> {
  const { chat, ref } = await refRead(call);
  const output = toolOutputOf(chat, ref);
  return output === null ? noRef("tool call") : jsonResponse({ output });
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
const folderOf = (host: AgentHost, session: string): string | null => rowsFrom(host.summaries()).find((row) => row.session === session)?.cwd ?? null;

/** The image types an attachment is embedded as, by extension, when the phone names none (an "@" pick). */
const IMAGE_BY_EXTENSION: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * The message's attachments, as VS Code sends them: an image embedded (base64, read back from the
 * file), any other file a resource the host reads by its file:// URI. Only files inside the chat's
 * own folder are taken: one chat/upload wrote (under `.herdr-web-ui/`), or one picked with "@"
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

/** Writes an attached file into the chat's folder (`<cwd>/.herdr-web-ui/`, as a pane's): its path. */
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
  const words = messageText(call.body["text"]);
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
  return jsonResponse(send(call.host, session, channel, now, message, id));
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
  (host.mirror().getSession(session) as { config?: SessionConfig } | undefined)?.config;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** What the chat's mode and approvals can be, and are: approvals the host offers this session (availableApprovalModes), else its schema's. */
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
  call.host.dispatch(session, { type: ActionType.SessionConfigChanged, config } as StateAction);
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

async function removePending(call: Call): Promise<Response> {
  const session = sessionOf(call.body);
  const id = call.body["id"];
  if (!text(id) || id === "") return badRequest("missing_id", "id is required");
  const { channel, chat } = await watched(call, session);
  const kind = chat.steeringMessage?.id === id ? PendingMessageKind.Steering
    : (chat.queuedMessages ?? []).some((pending) => pending.id === id) ? PendingMessageKind.Queued : null;
  if (kind === null) return conflictResponse("pending_gone", "the chat no longer holds that message");
  call.host.dispatch(channel, { type: ActionType.ChatPendingMessageRemoved, kind, id } as StateAction);
  return jsonResponse({ ok: true });
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
  const id = idOf(call.body["id"]);
  const words = messageText(call.body["text"]);
  const model = modelOf(call.body["model"]);
  const agent = agentOf(call.body["agent"]);
  connected(call.host);
  // the phone's id names the session: a retry of a chat already made makes nothing
  const session = `${PROVIDER}:/${id}`;
  if (known(call.host, session)) return jsonResponse(await madeBefore(call, session));
  await call.host.request("createSession", {
    channel: session, provider: PROVIDER, workingDirectories: [pathToFileURL(cwd).href], config: { isolation: "folder" },
  });
  // the session exists from here on: whatever fails next, the phone is told which one, so it opens
  // that chat (the message still in its composer) instead of retrying into a second, empty one
  try {
    await call.leases.sessions.take(session);
    const channel = call.host.mirror().getSession(session)?.defaultChat;
    const chat = call.host.chat(session);
    if (!channel || !chat) return jsonResponse({ session, sent: false });
    send(call.host, session, channel, chat, messageFrom(call.host.mirror().root, words, model, agent), id);
  } catch (error) {
    console.warn(`agent-host: chat/new made ${session} but its first message did not go (${errorName(error)})`);
    return jsonResponse({ session, sent: false });
  }
  return jsonResponse({ session });
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
  call.host.dispatch(channel, { type: ActionType.ChatIsArchivedChanged, isArchived } as StateAction);
  return jsonResponse({ ok: true });
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
  await call.host.request("disposeSession", { channel: session });
  // its watch would keep the gone session in the mirror, and known() with it
  call.leases.sessions.release(session);
  return jsonResponse({ ok: true });
}
