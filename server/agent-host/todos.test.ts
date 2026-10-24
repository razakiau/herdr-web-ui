import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostTodo } from "../../shared/host-chats.ts";
import { forgetSessionTodos, readSessionTodos } from "./todos.ts";

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
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toEqual(expected);
    expect(readSessionTodos(`ahp-session:/${UUID}`, home)).toEqual(expected);
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
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toEqual([{ id: "x", title: "X", status: "pending" }]);
    writeFileSync(path, "not a database at all, just bytes ".repeat(200));
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)).toEqual([{ id: "x", title: "X", status: "pending" }]);
  });

  test("reads again once the store changed", () => {
    store(UUID, [SCHEMA, "INSERT INTO todos (id, title) VALUES ('x', 'X')"]);
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)?.[0]?.status).toBe("pending");
    const db = new Database(join(home, "session-state", UUID, "session.db"));
    db.run("UPDATE todos SET status = 'done'");
    db.close();
    expect(readSessionTodos(`copilotcli:/${UUID}`, home)?.[0]?.status).toBe("done");
  });
});
