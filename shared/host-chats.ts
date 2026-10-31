/**
 * The host chats contract between a bridge and the browser: types only, so the client can
 * import it without pulling in the server's AHP client.
 */
import type { ConversationTurn, InteractivePrompt, FileEditKind } from "./protocol.ts";

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
  /** a fork (VS Code's Fork Conversation): the session it was forked in, whose folder and agent it shares */
  fork_of?: string;
  /** a linked worktree's main checkout (the host's project, when it is a local folder other than `cwd`) */
  repo?: string;
  /** the folder's branch, as VS Code reported it to the host (`_meta.git.branchName`) */
  branch?: string;
  /** the folder is on a detached HEAD (no branch to say) */
  detached?: boolean;
  /** the host was given no folder: `cwd` is the parent of its scratch folders, one row for all of them */
  no_folder?: boolean;
  /** what it is doing now, in the host's words (SessionSummary.activity), only while it works; absent before bundle 1061 */
  activity?: string;
}

/**
 * A model the PC's Copilot offers: `provider` is the host's (SessionModelInfo.provider), `efforts`
 * its reasoning-effort choice when it has one (with the host's default, the one used until another is picked), `context` its maxContextWindow in tokens when known.
 * `group` is where the picker files it: "copilot" for Copilot's own catalogue (the host gives those,
 * and only those, a `_meta` with a multiplier, discount or category), else the id's "<router>/"
 * prefix, else "other". `multiplier` is Copilot's premium-request rate, `warning` its notice (a
 * planned deprecation). The three are absent from a bridge older than bundle 1007.
 */
export interface HostModel {
  id: string; name: string; provider: string; efforts: { key: string; values: string[]; default?: string } | null; context: number | null;
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
  | { request_id: string; question_id: string; option_ids: string[]; /** a form's questions, parallel to the prompt's `form` */ form?: { question_id: string; option_ids: string[] }[] }
  | { tool_call_id: string; turn_id: string; option_ids: string[]; approves: boolean[] };

/** GET /api/host-chats/chat: one chat, read. */
/** The chat's context window, as VS Code reads `copilot.usageInfo` (readCopilotContextUsage). */
export interface HostContextUsage {
  currentTokens: number; tokenLimit: number;
  conversationTokens?: number; systemTokens?: number; toolDefinitionsTokens?: number;
  /**
   * VS Code's breakdown (stateToProgressAdapter contextAttributionToPromptTokenDetails): rows by
   * category, each a share of the prompt in percent; what they leave is VS Code's "Other"
   */
  parts?: { category: "system" | "user"; label: string; share: number }[];
  /** the window the model keeps for its answer (maxOutputTokens less what the turn wrote), VS Code's striped band */
  reservedTokens?: number;
}

/** A model's tokens over the chat's turns (`turnTokenTotals`, sub-agents included), for a cost estimate. */
export interface HostTokenTotal { model: string; input: number; cached: number; output: number }

/**
 * A model's calls in a chat's Copilot log (`session.usage_record`), sub-agents included. `input`
 * holds `cacheRead` and the part sent without the cache; what the calls stored in the cache
 * (`cacheWrite`) is not inside it (checked against OmniRoute's call_logs, ZAC-260). `coldWrite` is
 * the part of `cacheWrite` the main agent's cold restarts stored (the cache had expired); absent
 * from a bridge before bundle 1069, read as 0. Tokens only, the client prices them.
 */
export interface HostCostModel {
  model: string; input: number; cacheRead: number; cacheWrite: number; coldWrite?: number; output: number; calls: number;
  /** what the chat's first main-agent call stored (a new chat's, or a fork's first of its own): inside `cacheWrite`, not `coldWrite`; absent from a bridge before ZAC-262 */
  firstWrite?: number;
  /** the main agent's last call on this model (a prompt cache is one model's); absent in a day's sums and from a bridge before 1071 */
  lastCallAt?: string | null;
}
/**
 * One reply's calls (from a user message, or the owner's answer to `ask_user` / `askUser`, to the next), the main agent's or its sub-agents', for the chart.
 * The token counts are the calls' sums; `context` and `lastCacheRead` are the last call's own prompt
 * (`inputTokens`) and cache read: the context size the message ended at, and the last call's cache hit.
 */
export interface HostCostCall {
  at: string; input: number; cacheRead: number; cacheWrite: number; coldWrite?: number; output: number; main: boolean; context: number; lastCacheRead: number;
  /** the part of `cacheWrite` that was the chat's first write (HostCostModel.firstWrite); absent from a bridge before ZAC-262 */
  firstWrite?: number;
  /** how many calls these sums hold, and how many of them were cold restarts (the chart's card); absent from a bridge before bundle 1071 */
  calls?: number; restarts?: number;
  /**
   * a reply whose calls span more than an hour: the same sums per 60-minute window from the reply's
   * first call (`at` the window's start), windows without a call left out, the main agent's and the
   * sub-agents' on the same windows; the chart draws one bar per hour (ZAC-262). Absent for a reply
   * of an hour or less, and from a bridge before bundle 1076.
   */
  hours?: HostCostCall[];
}
/** GET /api/host-chats/costs: what a chat's log says it spent. */
export interface HostChatCost {
  session: string; models: HostCostModel[];
  /** the main agent's last call: the cache's age runs from it */
  lastCallAt: string | null;
  /** that call's model, whose cache the chat's next call reads unless the model is switched; absent from a bridge before 1071 */
  lastModel?: string | null;
  /** the main agent's last prompt (`inputTokens`), the context the next call sends */
  context: number | null;
  /**
   * that prompt split as the CLI's log gives it (server/agent-host/costs.ts splitOf): the Context
   * tab's breakdown while the host reports none (a turn driven by ask_user runs for hours); absent
   * from a bridge before bundle 1071
   */
  split?: HostContextUsage | null;
  /** the main agent's largest prompt, and its cold restarts: calls whose write is over half of what the cache holds after them */
  peak: number; rewrites: number;
  /** 1 when the main agent's first call of its own stored the conversation (not a cold restart: there was no cache to lose); absent from a bridge before ZAC-262 */
  firstWrites?: number;
  /** the same sums by the call's UTC day ("YYYY-MM-DD"), for Today / 7 days / 30 days */
  days: Record<string, HostCostModel[]>;
  /** per UTC day, the main agent's cold restarts, first writes and hand-offs (`/handoff`, `/harness:handoff`), for the weekly digest; absent from a bridge before ZAC-262 */
  dayCounts?: Record<string, { restarts: number; firstWrites: number; handoffs: number }>;
  /** the log was only partly read so far: the sums are a floor */
  partial: boolean;
}
/** Every chat the bridge has read; `complete` is false until its first scan (the last 30 days) is done. */
export interface HostCostsAnswer { chats: HostChatCost[]; complete: boolean }

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
  /** that work, each shell and subagent, for its list (absent from a bridge before ZAC-207) */
  work?: HostBackgroundWork[];
  /** what the session produced and referred to, newest first, as VS Code's pills read it (absent from a bridge before ZAC-207) */
  artifacts?: HostArtifact[];
  /** the running turn's tool calls waiting for a yes or no */
  confirmations: number;
  /** the context window as Copilot reports it (copilot.usageInfo); null when it says nothing usable */
  context: HostContextUsage | null;
  /**
   * The tokens the chat's loaded turns spent, by model (absent from a bridge before ZAC-224); `partial`
   * when older turns are not loaded, so a sum of these is a floor
   */
  tokens?: { totals: HostTokenTotal[]; partial: boolean };
  /**
   * The ids the chat holds its messages under: its turns' (past, the loaded page, and the running
   * one) and its pending messages'. A phone whose send lost its answer sees here that it went.
   */
  message_ids: string[];
  /**
   * VS Code's checkpoints, one per loaded turn in its order (a user turn's index among the read's
   * user turns is its index here): the host's turn id and the files its edits touched. Restoring
   * one undoes it and every later turn; the first one is Start Over.
   */
  checkpoints: HostCheckpoint[];
  /** a checkpoint restored and not yet sent past or redone: the next send truncates the chat to before it */
  restored: { turn: string; files: number } | null;
  /** the session's todo list in its order (absent when it has none, and from a bridge before ZAC-228) */
  todos?: HostTodo[];
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
/**
 * A form answered whole: each question's answer by its id, `null` for an optional one left empty
 * (sent as skipped). A required one with no answer is refused, and nothing reaches the host.
 */
export interface HostFormAnswer { session: string; request_id: string; answers: Record<string, { option_ids?: string[]; text?: string } | null> }
/** `option_id`: the host's confirmation option the user picked, when it offered some. */
export interface HostConfirm { session: string; turn_id: string; tool_call_id: string; approved: boolean; option_id?: string }
/**
 * `id`: the phone's UUID for this attempt; the chat made is `copilotcli:/<id>`, so a retry makes
 * none. Send one to make a retry safe; without it the bridge mints one, and a retry makes another.
 */
/** POST /api/host-chats/chat/new. No `text`: the chat is made empty (VS Code's New Chat) and its own composer sends the first message. */
export interface HostNew { id?: string; cwd: string; text?: string; model?: { id: string; effort?: string }; agent?: string | null }
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

/**
 * Where a "Hand off & continue" job is (POST/GET /api/host-chats/chat/handoff): `/handoff` being sent,
 * its turn awaited, the next chat being started, or how it ended (`no_resume`: the reply named no
 * `/resume` line; `timeout`: no end within 20 min; `failed`: the host failed a step). A continue job
 * (POST chat/continue, ZAC-266) is only ever `starting`, then `done` or `failed`.
 */
export type HandoffState = "sending" | "waiting" | "starting" | "done" | "no_resume" | "timeout" | "failed";
/** One chat's hand-off job, held in the bridge's memory until an hour after it ends. */
export interface HandoffJob {
  session: string;
  /** `note`: `/handoff` wrote a note the next chat resumes (chat/handoff); `fresh`: the next chat resumes the old one's CLI record, no note (chat/continue) */
  mode: "note" | "fresh";
  state: HandoffState;
  startedAt: number;
  endedAt: number | null;
  /** the `/resume <topic>` the reply named; null for a `fresh` job */
  topic: string | null;
  /** the chat started with `/resume <topic>` (`fresh`: `/resume <cli session id>`) */
  newSession: string | null;
  /** a code, never a transport's message */
  error: string | null;
}

/** A turn's checkpoint (HostChatRead.checkpoints): its id, and each file its edits touched with the lines they changed. */
/** One row of a Copilot session's `todos` table. */
export interface HostTodo {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
}

export interface HostCheckpoint {
  turn: string;
  files: { path: string; added: number; removed: number }[];
}

/**
 * GET /api/host-chats/edit-diff?session&ref: one edit's file as it was before the call and after
 * it (null: no such side, a created or deleted file). `unavailable`: the host no longer holds a
 * side; `binary`: a side is not text, or too big to draw. Either way both sides are null.
 */
export interface HostEditDiff { path: string; kind: FileEditKind; before: string | null; after: string | null; unavailable?: true; binary?: true }

/** One file of a chat's changeset, as VS Code's Changes view lists it; `id` reads its diff (changes/diff). */
export interface HostChangedFile { id: string; path: string; kind: FileEditKind; added: number; removed: number }
/** The chat's changeset VS Code's Changes pill counts ("Branch Changes"): its files and their lines; `status` "computing" until the host has it. */
export interface HostChanges { label: string; status: "computing" | "recomputing" | "ready" | "error"; files: HostChangedFile[]; added: number; removed: number }

/** What VS Code's agent host records a session produced (`agentHost/sessionArtifacts`), by kind. */
export type HostArtifactType = "pullRequest" | "issue" | "commit" | "website" | "file" | "resource";
/** One artifact (`isArtifact`) or reference of a session, as the host recorded it. */
export interface HostArtifact { id: string; type: HostArtifactType; label: string; isArtifact: boolean; link?: string; uri?: string; commitHash?: string; isGitHub?: boolean }
/** One piece of work still running for a chat (AHP backgroundWork): a shell or a subagent; `stoppable`: the host takes vscode/stopBackgroundWork for it. */
export interface HostBackgroundWork { id: string; kind: "shell" | "subagent"; label: string; command?: string; started: string; stoppable: boolean; /** a subagent's own chat, as the host names its work */ chat?: string; /** the tool call that started the subagent: its transcript row's id */ toolCall?: string }
