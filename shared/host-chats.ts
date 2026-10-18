/**
 * The host chats contract between a bridge and the browser: types only, so the client can
 * import it without pulling in the server's AHP client.
 */
import type { ConversationTurn, InteractivePrompt } from "./protocol.ts";

/** Where a bridge stands with its PC's agent host. */
export type AgentHostState =
  | { state: "off" } | { state: "unsupported" } | { state: "no_server" }
  | { state: "starting" } | { state: "waiting" }          // start disabled, no host yet
  | { state: "refused"; server_version: string | null }   // handshake refused
  | { state: "connected"; signed_in: boolean; protocol: string };

/** One host chat in the sidebar: GET /api/host-chats/chats. */
export interface HostChatRow {
  session: string; title: string; status: "working" | "asks" | "idle" | "error";
  modified_at: string; cwd: string | null;
}

/**
 * A model the PC's Copilot offers: `provider` is the host's (SessionModelInfo.provider), `efforts`
 * its reasoning-effort choice when it has one, `context` its maxContextWindow in tokens when known.
 */
export interface HostModel { id: string; name: string; provider: string; efforts: { key: string; values: string[] } | null; context: number | null }

/** A custom agent enabled in a chat's session. */
export interface HostAgent { uri: string; name: string; description: string | null }

/**
 * What the card answers through: a question's request and question ids, or a tool call's. Both
 * also carry, parallel to the prompt's `options`, each option's host id (`""` for the typed-answer
 * slot); an approval also says which options approve.
 */
export type HostPromptRef =
  | { request_id: string; question_id: string; option_ids: string[] }
  | { tool_call_id: string; turn_id: string; option_ids: string[]; approves: boolean[] };

/** GET /api/host-chats/chat: one chat, read. */
export interface HostChatRead {
  session: string; title: string; status: HostChatRow["status"];
  turns: ConversationTurn[];
  /** the host's cursor for older turns (`turnsNextCursor`): pass it as `before` to load them */
  cursor: string | null;
  prompt: (InteractivePrompt & { host: HostPromptRef }) | null;
  /** from the newest turn's message.model, else the draft's */
  model: { id: string; effort: string | null } | null;
  /** the newest turn's message.agent.uri */
  agent: string | null;
  /** a turn is running: a send now queues */
  busy: boolean;
  /**
   * The ids the chat holds its messages under: its turns' (past, the loaded page, and the running
   * one) and its pending messages'. A phone whose send lost its answer sees here that it went.
   */
  message_ids: string[];
  /** changes when anything shown changes */
  signature: string;
}

/**
 * `id`: the phone's UUID for this message, reused when the same words are sent again after a
 * failure: the bridge dispatches an id once (it becomes the turn's id, or the queued message's).
 * Send one to make a retry safe; without it the bridge mints one, and a retry may go twice.
 */
export interface HostSend { session: string; id?: string; text: string; model?: { id: string; effort?: string }; agent?: string | null }
export interface HostAnswer { session: string; request_id: string; question_id: string; option_ids?: string[]; text?: string; skip?: true }
/** `option_id`: the host's confirmation option the user picked, when it offered some. */
export interface HostConfirm { session: string; turn_id: string; tool_call_id: string; approved: boolean; option_id?: string }
/**
 * `id`: the phone's UUID for this attempt; the chat made is `copilotcli:/<id>`, so a retry makes
 * none. Send one to make a retry safe; without it the bridge mints one, and a retry makes another.
 */
export interface HostNew { id?: string; cwd: string; text: string; model?: { id: string; effort?: string }; agent?: string | null }
/**
 * POST /api/host-chats/chat/new: the chat made. `sent: false` when it was created but its first message
 * did not go out: open that chat (keep the text in its composer), never create another.
 */
export interface HostNewResult { session: string; sent?: false }
