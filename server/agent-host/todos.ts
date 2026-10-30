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
import { statSync } from "node:fs";
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

export function forgetSessionTodos(): void { cache.clear(); sdkCache.clear(); peerCache.clear(); }

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
 * The SDK session of a session's other chat, `ahp-chat://<chatId>/<tail>` (a VS Code peer chat or a
 * fork; ZAC-260): `tail` is the parent session's URI in base64url (`ahp-session:/<uuid>` or
 * `copilotcli:/<uuid>`), and the parent's own store keeps its chats in `session_metadata.peerChats`, a
 * JSON array of `{uri, providerData}` whose providerData (a JSON string) names `sdkSessionId`. Live on
 * the Mac, 2026-10-30: `ahp-chat://8f678541-…/<copilotcli:/ddf9fd94-…>` → 5b970deb-…, which the
 * old lookup (the text after ":/" taken for a uuid) never found. Null for anything else.
 */
export function peerChatSdkOf(chat: string, dirs: readonly string[]): string | null {
  const match = /^ahp-chat:\/\/([^/]+)\/([A-Za-z0-9_+/=-]+)$/.exec(chat);
  if (!match || match[1] === "default" || match[1] === "subagent") return null;
  let parent: string;
  try { parent = Buffer.from(match[2]!, "base64url").toString("utf8"); } catch { return null; }
  const at = parent.indexOf(":/");
  const uuid = at < 0 ? "" : parent.slice(at + 2);
  if (!UUID.test(uuid)) return null;
  for (const dir of dirs) {
    const path = join(dir, uuid, "session.db");
    const stamp = mtime(path);
    if (stamp === null) continue;
    const key = `${path}\n${chat}`;
    const known = peerCache.get(key);
    if (known?.stamp === stamp) return known.sdk;
    let sdk: string | null = null;
    try {
      const store = new Database(path, { readonly: true });
      try {
        const row = store.query("SELECT value FROM session_metadata WHERE key = 'peerChats'").get() as { value?: unknown } | null;
        const list = typeof row?.value === "string" ? JSON.parse(row.value) as unknown : null;
        const entry = Array.isArray(list) ? list.find((each) => (each as { uri?: unknown } | null)?.uri === chat) as { providerData?: unknown } | undefined : undefined;
        const data = typeof entry?.providerData === "string" ? JSON.parse(entry.providerData) as { sdkSessionId?: unknown } : entry?.providerData as { sdkSessionId?: unknown } | undefined;
        const id = data?.sdkSessionId;
        sdk = typeof id === "string" && UUID.test(id) ? id : null;
      } finally { store.close(); }
    } catch {
      return known?.sdk ?? null;
    }
    peerCache.set(key, { stamp, sdk });
    return sdk;
  }
  return null;
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
