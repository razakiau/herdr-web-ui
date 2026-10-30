/**
 * A host chat's todo list. VS Code's agent host runs the Copilot SDK, which keeps a session's
 * todos where the CLI does: `$COPILOT_HOME/session-state/<uuid>/session.db`, table `todos`, created
 * the first time the agent writes one. A CLI chat's id (`copilotcli:/<uuid>`) names that folder; a
 * chat VS Code started (`ahp-session:/<uuid>`, `ahp-chat:/<uuid>`) does not: VS Code keeps its own
 * `agentSessionData/<uuid>/session.db`, whose `session_metadata.defaultChatProviderData` names the
 * SDK's session (`sdkSessionId`). Live, 2026-10-24: 7 chats had todos the first lookup never found
 * (591b2f3f → 1da5c4f1, 5 todos).
 */
import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HostTodo } from "../../shared/host-chats.ts";
import { defaultCopilotHome } from "../copilot.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<HostTodo["status"]>(["pending", "in_progress", "done", "blocked"]);

/** per store: the mtimes it was read at, and what it held */
/** A row with when it was written (created_at, ms): todosSince cuts on it, and it stays on the server. */
export type StoredTodo = HostTodo & { created: number | null };

const cache = new Map<string, { stamp: string; todos: StoredTodo[] | null }>();

/** per VS Code chat: the SDK session it names, by the stamp of the store it was read from */
const sdkCache = new Map<string, { stamp: number; sdk: string | null }>();

export function forgetSessionTodos(): void { cache.clear(); sdkCache.clear(); peerCache.clear(); chatIndex.clear(); scans.clear(); }

/** Where VS Code keeps a chat's own data: a Remote-SSH server's, then the desktop app's on each OS. */
export function defaultAgentSessionDirs(): string[] {
  const home = process.env["HOME"] || homedir();
  const appData = process.env["APPDATA"];
  return [
    join(home, ".vscode-server", "data", "agentSessionData"),
    join(home, "Library", "Application Support", "Code", "agentSessionData"),
    ...(appData ? [join(appData, "Code", "agentSessionData")] : []),
    join(home, ".config", "Code", "agentSessionData"),
  ];
}

/** The SDK session a VS Code chat runs on, read from its own store; null when it names none. */
export function sdkSessionOf(uuid: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const path = join(dir, uuid, "session.db");
    const stamp = mtime(path);
    if (stamp === null) continue;
    const known = sdkCache.get(path);
    if (known?.stamp === stamp) return known.sdk;
    let sdk: string | null = null;
    try {
      const store = new Database(path, { readonly: true });
      try {
        const row = store.query("SELECT value FROM session_metadata WHERE key = 'defaultChatProviderData'").get() as { value?: unknown } | null;
        const id = typeof row?.value === "string" ? (JSON.parse(row.value) as { sdkSessionId?: unknown }).sdkSessionId : undefined;
        sdk = typeof id === "string" && UUID.test(id) ? id : null;
      } finally { store.close(); }
    } catch {
      // locked mid-write, no such table yet or not JSON: what it named last time, and read it again next time
      return known?.sdk ?? null;
    }
    sdkCache.set(path, { stamp, sdk });
    return sdk;
  }
  return null;
}

/** per peer chat: the SDK session its parent's store names for it, by the stamp of that store */
const peerCache = new Map<string, { stamp: number; sdk: string | null }>();

/**
 * The SDK session of a session's other chat (ZAC-260): a VS Code peer chat (origin "user") or a fork
 * (Fork Conversation, origin "fork"). Its id is `ahp-chat://<chatId>/<tail>`, `tail` the parent
 * session's URI in base64url, or `ahp-chat:/<uuid>`, which names no parent: the caller passes it
 * (`parent`, the host row's `fork_of`). The parent's own store keeps its chats in
 * `session_metadata.peerChats`, a JSON array of `{uri, providerData, origin}` whose providerData (a
 * JSON string) names `sdkSessionId`. The tail's scheme can differ from the store's (the row says
 * `ahp-session:/ddf9fd94-…`, the store `copilotcli:/ddf9fd94-…`), so an `ahp-chat://` chat is
 * matched by its chat id. Live on the Mac, 2026-10-30: 6 such rows, none found before (the text
 * after ":/" was taken for a uuid). With no parent, or a parent whose store names no such chat
 * (Specifica, bridge 1071), the stores that name the chat themselves (chatIndexSdk). Null for
 * anything else.
 */
export function peerChatSdkOf(chat: string, dirs: readonly string[], parent: string | null = null): string | null {
  const nested = /^ahp-chat:\/\/([^/]+)\/([A-Za-z0-9_+/=-]+)$/.exec(chat);
  const flat = /^ahp-chat:\/([0-9a-f-]{36})$/i.exec(chat);
  if (nested && (nested[1] === "default" || nested[1] === "subagent")) return null;
  if (!nested && !flat) return null;
  let owner = parent;
  if (nested) {
    try { owner = Buffer.from(nested[2]!, "base64url").toString("utf8"); } catch { return null; }
  }
  const id = nested ? nested[1]! : flat![1]!.toLowerCase();
  // without a parent (or when its store names no such chat), the stores that name the chat themselves
  if (owner === null) return chatIndexSdk(id, dirs);
  const at = owner.indexOf(":/");
  const uuid = at < 0 ? "" : owner.slice(at + 2);
  if (!UUID.test(uuid)) return chatIndexSdk(id, dirs);
  // the store lists a chat in either form whichever form the host lists it in (Specifica, 2026-10-30:
  // the row `ahp-chat:/481f0bee-…`, the parent's entry `ahp-chat://481f0bee-…/<tail>`): match its id
  const same = (uri: unknown): boolean => typeof uri === "string" && chatIdOf(uri) === id;
  for (const dir of dirs) {
    const path = join(dir, uuid, "session.db");
    const stamp = mtime(path);
    if (stamp === null) continue;
    const key = `${path}\n${chat}`;
    const known = peerCache.get(key);
    if (known?.stamp === stamp) {
      if (known.sdk !== null) return known.sdk;
      break;
    }
    let sdk: string | null = null;
    try {
      const store = new Database(path, { readonly: true });
      try {
        const row = store.query("SELECT value FROM session_metadata WHERE key = 'peerChats'").get() as { value?: unknown } | null;
        const list = typeof row?.value === "string" ? JSON.parse(row.value) as unknown : null;
        const entry = Array.isArray(list) ? list.find((each) => same((each as { uri?: unknown } | null)?.uri)) as { providerData?: unknown } | undefined : undefined;
        const data = typeof entry?.providerData === "string" ? JSON.parse(entry.providerData) as { sdkSessionId?: unknown } : entry?.providerData as { sdkSessionId?: unknown } | undefined;
        const named = data?.sdkSessionId;
        sdk = typeof named === "string" && UUID.test(named) ? named : null;
      } finally { store.close(); }
    } catch {
      if (known?.sdk) return known.sdk;
      break;
    }
    peerCache.set(key, { stamp, sdk });
    if (sdk !== null) return sdk;
    break;
  }
  return chatIndexSdk(id, dirs);
}

/** The chat id an `ahp-chat:` URI names, either form; null for anything else. */
function chatIdOf(uri: string): string | null {
  const nested = /^ahp-chat:\/\/([^/]+)\//.exec(uri);
  if (nested) return nested[1]!;
  const flat = /^ahp-chat:\/([0-9a-f-]{36})$/i.exec(uri);
  return flat ? flat[1]!.toLowerCase() : null;
}

/** per store dir: its store's stamp, and the chats it names (chat id → SDK session) */
const chatIndex = new Map<string, { stamp: number; chats: [string, string][] }>();
/** a scan lists at most this many stores (the Mac had 1,819 dirs, 593 of them uuid-named, 2026-10-30) */
const MAX_STORES = 5000;

/**
 * A peer chat's or fork's SDK session found without its parent (ZAC-260 phase 2): Specifica's host
 * lists them as `ahp-chat:/<chatId>` and its row names no parent the store agrees with. Every chat
 * VS Code runs on its own SDK session gets a backing store, `agentSessionData/<sdk>/session.db`, whose
 * `session_metadata.peerChatBacking` names the chat's URI: the most direct link, one key per store,
 * no parent needed (on the Mac all 7 peer chats had one, 2026-10-30). The parents' `peerChats` lists
 * are read in the same pass as a second witness. Each store is re-read only when its mtime moves.
 */
function chatIndexSdk(chatId: string, dirs: readonly string[], now: number = Date.now()): string | null {
  const scope = dirs.join("\n");
  const hit = scans.get(scope);
  if (hit !== undefined && (hit.chats.has(chatId) || now - hit.at < RESCAN_MS)) return hit.chats.get(chatId) ?? null;
  const chats = scanStores(dirs);
  scans.set(scope, { at: now, chats });
  return chats.get(chatId) ?? null;
}

/** per set of dirs: when they were last listed, and every chat id → SDK session they named */
const scans = new Map<string, { at: number; chats: Map<string, string> }>();
/** a chat the stores did not name is looked for again after this long (a host lists rows every few seconds) */
const RESCAN_MS = 15_000;

function scanStores(dirs: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  let listed = 0;
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!UUID.test(name)) continue;
      if (++listed > MAX_STORES) return found;
      const path = join(dir, name, "session.db");
      const stamp = mtime(path);
      if (stamp === null) continue;
      let known = chatIndex.get(path);
      if (known?.stamp !== stamp) {
        known = { stamp, chats: readStoreChats(path, name.toLowerCase()) ?? known?.chats ?? [] };
        chatIndex.set(path, known);
      }
      for (const [chat, sdk] of known.chats) {
        // the backing store's own word wins over a parent's list
        if (!found.has(chat) || sdk === name.toLowerCase()) found.set(chat, sdk);
      }
    }
  }
  return found;
}

/** The chats one store names: its own (peerChatBacking, the store's dir is the SDK id) and its peers'. */
function readStoreChats(path: string, self: string): [string, string][] | null {
  try {
    const store = new Database(path, { readonly: true });
    try {
      const rows = store.query("SELECT key, value FROM session_metadata WHERE key IN ('peerChatBacking', 'peerChats')").all() as { key: string; value: unknown }[];
      const chats: [string, string][] = [];
      for (const row of rows) {
        if (typeof row.value !== "string") continue;
        if (row.key === "peerChatBacking") {
          const chat = chatIdOf(row.value);
          if (chat !== null) chats.push([chat, self]);
          continue;
        }
        let list: unknown;
        try { list = JSON.parse(row.value); } catch { continue; }
        if (!Array.isArray(list)) continue;
        for (const each of list as { uri?: unknown; providerData?: unknown }[]) {
          const chat = typeof each?.uri === "string" ? chatIdOf(each.uri) : null;
          if (chat === null) continue;
          let data: { sdkSessionId?: unknown } | undefined;
          try { data = typeof each.providerData === "string" ? JSON.parse(each.providerData) : each.providerData as typeof data; } catch { continue; }
          const sdk = data?.sdkSessionId;
          if (typeof sdk === "string" && UUID.test(sdk)) chats.push([chat, sdk.toLowerCase()]);
        }
      }
      return chats;
    } finally { store.close(); }
  } catch {
    // locked mid-write or no such table: what it named last time
    return null;
  }
}

function mtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/** The session's todos in the order they were written; null when it has no store or no table. */
export function readSessionTodos(session: string, home: string = defaultCopilotHome(), agentDirs: readonly string[] = defaultAgentSessionDirs()): StoredTodo[] | null {
  const uuid = session.slice(session.indexOf(":/") + 2);
  if (!session.includes(":/") || !UUID.test(uuid)) return null;
  // a CLI chat's own folder first; a VS Code chat's through the SDK session its store names
  const own = join(home, "session-state", uuid, "session.db");
  const sdk = mtime(own) === null ? sdkSessionOf(uuid, agentDirs) : null;
  const path = sdk === null ? own : join(home, "session-state", sdk, "session.db");
  const db = mtime(path);
  if (db === null) return null;
  // the CLI writes through its WAL: the main file's mtime alone would miss a change
  const stamp = `${db}:${mtime(`${path}-wal`)}`;
  const known = cache.get(path);
  if (known?.stamp === stamp) return known.todos;
  let todos: StoredTodo[] | null;
  try {
    const store = new Database(path, { readonly: true });
    try {
      const table = store.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
      // created_at is SQLite's datetime('now'): UTC, to the second, no zone written
      const hasCreated = store.query("SELECT 1 FROM pragma_table_info('todos') WHERE name = 'created_at'").get() !== null;
      todos = table === null ? null : (store.query(`SELECT id, title, status${hasCreated ? ", created_at" : ""} FROM todos ORDER BY rowid`).all() as (HostTodo & { created_at?: unknown })[])
        .map((row) => {
          const created = typeof row.created_at === "string" ? Date.parse(`${row.created_at.replace(" ", "T")}Z`) : Number.NaN;
          return { id: String(row.id), title: String(row.title), status: STATUSES.has(row.status) ? row.status : "pending", created: Number.isFinite(created) ? created : null };
        });
    } finally { store.close(); }
  } catch {
    // locked mid-write or damaged: what it held last time, and try again next read
    return known?.todos ?? null;
  }
  cache.set(path, { stamp, todos });
  return todos;
}

/**
 * The list as VS Code's todo widget keeps it: it clears at each request and on a cancel, so the bar shows
 * the todos the newest message's turn wrote, plus older plans still open (work carried over), and none
 * once that turn was stopped. A plan is the todos written in one second (the agent writes its list in
 * one call: in the owner's stores every plan shares one created_at, e.g. T1-T10 + final review) and
 * stays whole while any of it is open: dropping its checked items read as T1-T3 vanishing beside T4
 * (owner, ZAC-233). `since`: that turn's start (ms), null for the whole list. The table's times are
 * whole seconds, so the cut is the turn's second.
 */
export function todosSince(todos: readonly StoredTodo[], since: number | null, cancelled: boolean): HostTodo[] {
  if (cancelled && since !== null) return [];
  const cut = since === null ? null : Math.floor(since / 1000) * 1000;
  const open = new Set(todos.filter((todo) => todo.status !== "done").map((todo) => todo.created));
  return todos
    .filter((todo) => cut === null || todo.created === null || todo.created >= cut || open.has(todo.created))
    .map(({ created: _created, ...todo }) => todo);
}
