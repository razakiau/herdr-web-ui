/**
 * The VS Code chats contract between a bridge and the browser: types only, so the client can
 * import it without pulling in the server's AHP client.
 */
import type { ConversationTurn, InteractivePrompt } from "./protocol.ts";

/** Where a bridge stands with its PC's VS Code agent host. */
export type VscodeHostState =
  | { state: "off" } | { state: "unsupported" } | { state: "no_server" }
  | { state: "starting" } | { state: "waiting" }          // start disabled, no host yet
  | { state: "refused"; server_version: string | null }   // handshake refused
  | { state: "connected"; signed_in: boolean; protocol: string };

/** One VS Code chat in the sidebar: GET /api/vscode/chats. */
export interface VscodeChatRow {
  session: string; title: string; status: "working" | "asks" | "idle" | "error";
  modified_at: string; cwd: string | null;
}

/** A model the PC's Copilot offers; `efforts` is its reasoning-effort choice, when it has one. */
export interface VscodeModel { id: string; name: string; efforts: { key: string; values: string[] } | null }

/** A custom agent enabled in a chat's session. */
export interface VscodeAgent { uri: string; name: string; description: string | null }

/**
 * What the card answers through: a question's request and question ids, or a tool call's. Both
 * also carry, parallel to the prompt's `options`, each option's host id (`""` for the typed-answer
 * slot); an approval also says which options approve.
 */
export type VscodePromptRef =
  | { request_id: string; question_id: string; option_ids: string[] }
  | { tool_call_id: string; turn_id: string; option_ids: string[]; approves: boolean[] };

/** GET /api/vscode/chat: one chat, read. */
export interface VscodeChatRead {
  session: string; title: string; status: VscodeChatRow["status"];
  turns: ConversationTurn[];
  /** the host's cursor for older turns (`turnsNextCursor`): pass it as `before` to load them */
  cursor: string | null;
  prompt: (InteractivePrompt & { vscode: VscodePromptRef }) | null;
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
 */
export interface VscodeSend { session: string; id: string; text: string; model?: { id: string; effort?: string }; agent?: string | null }
export interface VscodeAnswer { session: string; request_id: string; question_id: string; option_ids?: string[]; text?: string; skip?: true }
/** `option_id`: the host's confirmation option the user picked, when it offered some. */
export interface VscodeConfirm { session: string; turn_id: string; tool_call_id: string; approved: boolean; option_id?: string }
/** `id`: the phone's UUID for this attempt; the chat made is `copilotcli:/<id>`, so a retry makes none. */
export interface VscodeNew { id: string; cwd: string; text: string; model?: { id: string; effort?: string }; agent?: string | null }
/**
 * POST /api/vscode/chat/new: the chat made. `sent: false` when it was created but its first message
 * did not go out: open that chat (keep the text in its composer), never create another.
 */
export interface VscodeNewResult { session: string; sent?: false }
