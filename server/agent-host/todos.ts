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
const cache = new Map<string, { stamp: string; todos: HostTodo[] | null }>();

/** per VS Code chat: the SDK session it names, by the stamp of the store it was read from */
const sdkCache = new Map<string, { stamp: number; sdk: string | null }>();

export function forgetSessionTodos(): void { cache.clear(); sdkCache.clear(); }

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
function sdkSessionOf(uuid: string, dirs: readonly string[]): string | null {
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

function mtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/** The session's todos in the order they were written; null when it has no store or no table. */
export function readSessionTodos(session: string, home: string = defaultCopilotHome(), agentDirs: readonly string[] = defaultAgentSessionDirs()): HostTodo[] | null {
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
  let todos: HostTodo[] | null;
  try {
    const store = new Database(path, { readonly: true });
    try {
      const table = store.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
      todos = table === null ? null : (store.query("SELECT id, title, status FROM todos ORDER BY rowid").all() as HostTodo[])
        .map((row) => ({ id: String(row.id), title: String(row.title), status: STATUSES.has(row.status) ? row.status : "pending" }));
    } finally { store.close(); }
  } catch {
    // locked mid-write or damaged: what it held last time, and try again next read
    return known?.todos ?? null;
  }
  cache.set(path, { stamp, todos });
  return todos;
}
