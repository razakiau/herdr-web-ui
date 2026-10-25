import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostTodo } from "../../shared/host-chats.ts";
import { forgetSessionTodos, readSessionTodos, todosSince, type StoredTodo } from "./todos.ts";

const UUID = "1da5c4f1-451b-4845-953f-52a960f82afa";
const SCHEMA = `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "todos-")); forgetSessionTodos(); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function store(uuid: string, sql: string[]): string {
  const dir = join(home, "session-state", uuid);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.db");
  const db = new Database(path);
  for (const statement of sql) db.run(statement);
  db.close();
  return path;
}

const CHAT = "591b2f3f-e34c-4671-a7b8-e46c47c0b43b";

/** VS Code's own store for a chat: session_metadata naming the SDK session it runs on */
function vscodeStore(dir: string, chat: string, value: string): void {
  mkdirSync(join(dir, chat), { recursive: true });
  const db = new Database(join(dir, chat, "session.db"));
  db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  db.run("INSERT INTO session_metadata (key, value) VALUES ('defaultChatProviderData', ?)", [value]);
  db.close();
}

describe("readSessionTodos", () => {
  test("reads todos in the order they were written", () => {
    store(UUID, [SCHEMA,
      "INSERT INTO todos (id, title, status) VALUES ('b-plan', 'Plan', 'done')",
      "INSERT INTO todos (id, title, status) VALUES ('a-build', 'Build', 'in_progress')",
      "INSERT INTO todos (id, title) VALUES ('c-ship', 'Ship')"]);
    const expected: HostTodo[] = [
      { id: "b-plan", title: "Plan", status: "done" },
      { id: "a-build", title: "Build", status: "in_progress" },
      { id: "c-ship", title: "Ship", status: "pending" },
    ];
    const bare = (todos: StoredTodo[] | null) => todos?.map(({ created: _created, ...todo }) => todo) ?? null;
    expect(bare(readSessionTodos(`copilotcli:/${UUID}`, home))).toEqual(expected);
    expect(bare(readSessionTodos(`ahp-session:/${UUID}`, home))).toEqual(expected);
  });

  test("is null without a folder, a database or a todos table", () => {
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toBeNull();
    store(UUID, ["CREATE TABLE other (x)"]);
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toBeNull();
  });

  test("refuses a session id that is not a uuid", () => {
    store(UUID, [SCHEMA, "INSERT INTO todos (id, title) VALUES ('x', 'X')"]);
    expect(readSessionTodos(`copilotcli:/../session-state/${UUID}`, home)).toBeNull();
    expect(readSessionTodos("copilotcli:/", home)).toBeNull();
  });

  test("keeps the last good list when the store can't be read", () => {
    const path = store(UUID, [SCHEMA, "INSERT INTO todos (id, title) VALUES ('x', 'X')"]);
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toMatchObject([{ id: "x", title: "X", status: "pending" }]);
    writeFileSync(path, "not a database at all, just bytes ".repeat(200));
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toMatchObject([{ id: "x", title: "X", status: "pending" }]);
  });

  test("reads again once the store changed", () => {
    store(UUID, [SCHEMA, "INSERT INTO todos (id, title) VALUES ('x', 'X')"]);
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)?.[0]?.status).toBe("pending");
    const db = new Database(join(home, "session-state", UUID, "session.db"));
    db.run("UPDATE todos SET status = 'done'");
    db.close();
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)?.[0]?.status).toBe("done");
  });

  test("finds a VS Code chat's todos through the SDK session its own store names (live, 2026-10-24)", () => {
    store(UUID, [SCHEMA, "INSERT INTO todos (id, title, status) VALUES ('t1', 'FICTIONAL plan', 'in_progress')"]);
    const agentDirs = [join(home, "absent"), join(home, "agentSessionData")];
    expect(readSessionTodos(`ahp-session:/${CHAT}`, home, agentDirs)).toBeNull();
    vscodeStore(agentDirs[1]!, CHAT, JSON.stringify({ sdkSessionId: UUID, model: { id: "fictional" } }));
    expect(readSessionTodos(`ahp-session:/${CHAT}`, home, agentDirs)).toMatchObject([{ id: "t1", title: "FICTIONAL plan", status: "in_progress" }]);
    expect(readSessionTodos(`ahp-chat:/${CHAT}`, home, agentDirs)).toMatchObject([{ id: "t1", title: "FICTIONAL plan", status: "in_progress" }]);
  });

  test("a VS Code store that names no uuid, or isn't JSON, leads nowhere", () => {
    const agentDirs = [join(home, "agentSessionData")];
    // a store outside session-state, which a name that isn't a uuid could reach
    mkdirSync(join(home, "outside"), { recursive: true });
    const outside = new Database(join(home, "outside", "session.db"));
    outside.run(SCHEMA); outside.run("INSERT INTO todos (id, title) VALUES ('x', 'FICTIONAL elsewhere')"); outside.close();
    vscodeStore(agentDirs[0]!, CHAT, JSON.stringify({ sdkSessionId: "../outside" }));
    expect(readSessionTodos(`ahp-session:/${CHAT}`, home, agentDirs)).toBeNull();
    forgetSessionTodos();
    rmSync(join(agentDirs[0]!, CHAT), { recursive: true });
    vscodeStore(agentDirs[0]!, CHAT, "not json");
    expect(readSessionTodos(`ahp-session:/${CHAT}`, home, agentDirs)).toBeNull();
  });
});

describe("todosSince (VS Code clears the list at each request)", () => {
  test("reads created_at as the UTC time SQLite wrote", () => {
    store(UUID, [SCHEMA, "INSERT INTO todos (id, title, created_at) VALUES ('x', 'X', '2026-10-25 18:14:04')"]);
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)?.[0]?.created).toBe(Date.parse("2026-10-25T18:14:04Z"));
  });

  const at = (iso: string) => Date.parse(iso);
  const todo = (id: string, status: HostTodo["status"], created: number | null): StoredTodo => ({ id, title: id.toUpperCase(), status, created });
  const list = [
    todo("old-done", "done", at("2026-10-25T10:00:00Z")),
    todo("old-open", "pending", at("2026-10-25T10:00:00Z")),
    todo("old-going", "in_progress", at("2026-10-25T10:00:00Z")),
    todo("new-done", "done", at("2026-10-25T12:00:01Z")),
    todo("new-open", "pending", at("2026-10-25T12:00:05Z")),
  ];

  test("the newest message's todos, and older plans still open, whole; a plan all done before it goes", () => {
    expect(todosSince(list, at("2026-10-25T12:00:00Z"), false).map((row) => row.id)).toEqual(["old-done", "old-open", "old-going", "new-done", "new-open"]);
    const finished = [todo("a1", "done", at("2026-10-25T09:00:00Z")), todo("a2", "done", at("2026-10-25T09:00:00Z")), ...list];
    expect(todosSince(finished, at("2026-10-25T12:00:00Z"), false).map((row) => row.id)).not.toContain("a1");
  });

  test("a plan written in one go stays together: T1-T3 checked beside T4 still going (owner, ZAC-233)", () => {
    const plan = at("2026-10-25T10:00:00Z");
    const rows = ["t1", "t2", "t3", "t4", "t5"].map((id, i) => todo(id, i < 3 ? "done" : i === 3 ? "in_progress" : "pending", plan));
    expect(todosSince(rows, at("2026-10-25T12:00:00Z"), false).map((row) => row.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("the whole list without a turn to cut at, as before", () => {
    expect(todosSince(list, null, false).map((row) => row.id)).toEqual(list.map((row) => row.id));
  });

  test("a stopped turn's list is cleared, as VS Code clears it on cancel", () => {
    expect(todosSince(list, at("2026-10-25T12:00:00Z"), true)).toEqual([]);
  });

  test("a row without a time is kept (an older store), and the stored time never leaves the server", () => {
    const kept = todosSince([todo("unknown", "done", null)], at("2026-10-25T12:00:00Z"), false);
    expect(kept).toEqual([{ id: "unknown", title: "UNKNOWN", status: "done" }]);
  });

  test("seconds: a todo written in the turn's own second counts as the turn's", () => {
    expect(todosSince([todo("same", "done", at("2026-10-25T12:00:00Z"))], at("2026-10-25T12:00:00.700Z"), false).map((row) => row.id)).toEqual(["same"]);
  });
});
