/**
 * A host chat's todo list. VS Code's agent host runs the Copilot SDK, which keeps a session's
 * todos where the CLI does: `$COPILOT_HOME/session-state/<uuid>/session.db`, table `todos`, created
 * the first time the agent writes one. The chat's id (`copilotcli:/<uuid>`, `ahp-session:/<uuid>`)
 * names that folder (checked 2026-10-24: 25 of 25 recent host chats had one).
 */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

import type { HostTodo } from "../../shared/host-chats.ts";
import { defaultCopilotHome } from "../copilot.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<HostTodo["status"]>(["pending", "in_progress", "done", "blocked"]);

/** per store: the mtimes it was read at, and what it held */
const cache = new Map<string, { stamp: string; todos: HostTodo[] | null }>();

export function forgetSessionTodos(): void { cache.clear(); }

function mtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/** The session's todos in the order they were written; null when it has no store or no table. */
export function readSessionTodos(session: string, home: string = defaultCopilotHome()): HostTodo[] | null {
  const uuid = session.slice(session.indexOf(":/") + 2);
  if (!session.includes(":/") || !UUID.test(uuid)) return null;
  const path = join(home, "session-state", uuid, "session.db");
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
