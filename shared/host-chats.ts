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
  /** finished since anyone last looked at it: the host's `IsRead` bit is clear (SessionStatus) */
  unread: boolean;
  /** put away as done: the host's `IsArchived` bit */
  archived: boolean;
}

/**
 * A model the PC's Copilot offers: `provider` is the host's (SessionModelInfo.provider), `efforts`
 * its reasoning-effort choice when it has one, `context` its maxContextWindow in tokens when known.
 * `group` is where the picker files it: "copilot" for Copilot's own catalogue (the host gives those,
 * and only those, a `_meta` with a multiplier, discount or category), else the id's "<router>/"
 * prefix, else "other". `multiplier` is Copilot's premium-request rate, `warning` its notice (a
 * planned deprecation). The three are absent from a bridge older than bundle 1007.
 */
export interface HostModel {
  id: string; name: string; provider: string; efforts: { key: string; values: string[] } | null; context: number | null;
  group?: string; multiplier?: number | null; warning?: string | null;
}

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
/** The chat's context window, as VS Code reads `copilot.usageInfo` (readCopilotContextUsage). */
export interface HostContextUsage {
  currentTokens: number; tokenLimit: number;
  conversationTokens?: number; systemTokens?: number; toolDefinitionsTokens?: number;
}

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
  /** what waits for the running turn: the one steering message first, then the queue in its order */
  pending: { id: string; kind: "steering" | "queued"; text: string }[];
  /** the session's skills, prompts and agents, offered after "/" (VS Code's customizations) */
  commands: HostCommand[];
  /** work still running for the chat (AHP backgroundWork): subagents and shell commands */
  background: { subagents: number; commands: number };
  /** the running turn's tool calls waiting for a yes or no */
  confirmations: number;
  /** the context window as Copilot reports it (copilot.usageInfo); null when it says nothing usable */
  context: HostContextUsage | null;
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
/** `mode`: VS Code's send menu; absent is `send` (starts a turn, or queues behind a running one). */
export type HostSendMode = "send" | "steer" | "queue" | "stop_and_send";
/** A file a message carries: one chat/upload stored (its type and name), or a path of the chat's folder (an "@" pick). */
export interface HostAttachment { path: string; media_type?: string; name?: string }
export interface HostSend { session: string; id?: string; text: string; model?: { id: string; effort?: string }; agent?: string | null; mode?: HostSendMode; attachments?: HostAttachment[] }
/** POST /api/host-chats/chat/send: `queued` when it waits for the running turn; `joined` when a steer joined the one already set. */
export interface HostSendResult { queued: boolean; joined?: true }
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

/**
 * GET /api/host-chats/session/config: the chat's mode and approvals (the session's config, which VS
 * Code's mode picker sets too), and what each can be on this host. Null where the host sends none.
 */
export interface HostSessionConfig { mode: string | null; approvals: string | null; modes: string[]; approvalModes: string[] }

/** A command the host publishes for a chat: its skills, prompts and custom agents, called as `/name`. */
export interface HostCommand { name: string; description: string; kind: "skill" | "prompt" | "agent" }
