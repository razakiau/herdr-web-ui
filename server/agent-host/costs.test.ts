import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CostIndex } from "./costs.ts";
import { forgetSessionTodos } from "./todos.ts";

const UUID = "1da5c4f1-451b-4845-953f-52a960f82afa";
const OTHER = "7c0e2b1a-3f4d-4e5a-9b6c-0d1e2f3a4b5c";
const CHAT = "591b2f3f-e34c-4671-a7b8-e46c47c0b43b";
const NOW = Date.parse("2026-10-29T13:30:00.000Z");
const DAY = 86_400_000;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "costs-")); forgetSessionTodos(); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

let calls = 0;
/** A `session.usage_record` line as Copilot writes it (1.0.95); `agentId` on the envelope marks a sub-agent's. */
function usage(at: string, tokens: { input: number; cacheRead?: number; cacheWrite?: number; output?: number }, extra: { agentId?: string; model?: string; apiCallId?: string } = {}): string {
  calls += 1;
  return `${JSON.stringify({
    type: "session.usage_record", id: `rec-${calls}`, timestamp: at, parentId: "p",
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    data: { usage: {
      model: extra.model ?? "cc/claude-opus-5-5", inputTokens: tokens.input, outputTokens: tokens.output ?? 0,
      cacheReadTokens: tokens.cacheRead ?? 0, cacheWriteTokens: tokens.cacheWrite ?? 0, reasoningTokens: 0,
      initiator: extra.agentId ? "sub-agent" : "agent", interactionType: extra.agentId ? "conversation-subagent" : "conversation-agent",
      maxPromptTokens: 872000, apiCallId: extra.apiCallId ?? `chatcmpl-msg_${calls}`,
    } },
  })}\n`;
}
const userMessage = (at: string): string => `${JSON.stringify({ type: "user.message", id: `u-${at}`, timestamp: at, parentId: "p", data: { content: "FICTIONAL prompt" } })}\n`;

function log(uuid: string, lines: string[]): string {
  const dir = join(home, "session-state", uuid);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, lines.join(""));
  return path;
}

const index = (agentDirs: readonly string[] = []) => new CostIndex(home, agentDirs, () => NOW);

describe("CostIndex", () => {
  test("sums main and subagent records into models", () => {
    log(UUID, [
      usage("2026-10-29T13:00:00.000Z", { input: 1000, cacheRead: 800, output: 10 }),
      usage("2026-10-29T13:01:00.000Z", { input: 2000, cacheRead: 1900, output: 20 }),
      usage("2026-10-29T13:02:00.000Z", { input: 50_000, cacheWrite: 50_000, output: 30 }, { agentId: "sub-1" }),
    ]);
    const cost = index().costOf(`copilotcli:/${UUID}`);
    expect(cost?.session).toBe(`copilotcli:/${UUID}`);
    expect(cost?.models).toEqual([{ model: "cc/claude-opus-5-5", input: 53_000, cacheRead: 2700, cacheWrite: 50_000, output: 60, calls: 3 }]);
    expect(cost?.lastCallAt).toBe("2026-10-29T13:01:00.000Z");
    expect(cost?.context).toBe(2000);
    expect(cost?.peak).toBe(2000);
    expect(cost?.days["2026-10-29"]?.[0]?.calls).toBe(3);
    expect(cost?.partial).toBe(false);
  });

  test("counts a rewrite only above half the input", () => {
    log(UUID, [
      usage("2026-10-29T13:00:00.000Z", { input: 1000, cacheWrite: 600 }),
      usage("2026-10-29T13:01:00.000Z", { input: 1000, cacheWrite: 400 }),
    ]);
    expect(index().costOf(`copilotcli:/${UUID}`)?.rewrites).toBe(1);
  });

  test("reads only new bytes", () => {
    const path = log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 100 })]);
    const costs = index();
    expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.calls).toBe(1);
    appendFileSync(path, usage("2026-10-29T13:01:00.000Z", { input: 200 }));
    expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.calls).toBe(2);
    // a line still being written is left for the next read, never counted half
    const line = usage("2026-10-29T13:02:00.000Z", { input: 300 });
    appendFileSync(path, line.slice(0, 40));
    expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.calls).toBe(2);
    appendFileSync(path, line.slice(40));
    const after = costs.costOf(`copilotcli:/${UUID}`);
    expect(after?.models[0]?.calls).toBe(3);
    expect(after?.models[0]?.input).toBe(600);
  });

  test("dedupes by apiCallId", () => {
    const path = log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 100 }, { apiCallId: "chatcmpl-msg_same" })]);
    const costs = index();
    costs.costOf(`copilotcli:/${UUID}`);
    appendFileSync(path, usage("2026-10-29T13:00:01.000Z", { input: 100 }, { apiCallId: "chatcmpl-msg_same" }));
    expect(costs.costOf(`copilotcli:/${UUID}`)?.models).toEqual([{ model: "cc/claude-opus-5-5", input: 100, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1 }]);
  });

  test("maps a VS Code chat id to its SDK session", () => {
    log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 4242 })]);
    const agentDirs = [join(home, "absent"), join(home, "agentSessionData")];
    expect(index(agentDirs).costOf(`ahp-session:/${CHAT}`)).toBeNull();
    mkdirSync(join(agentDirs[1]!, CHAT), { recursive: true });
    const db = new Database(join(agentDirs[1]!, CHAT, "session.db"));
    db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    db.run("INSERT INTO session_metadata (key, value) VALUES ('defaultChatProviderData', ?)", [JSON.stringify({ sdkSessionId: UUID })]);
    db.close();
    const cost = index(agentDirs).costOf(`ahp-session:/${CHAT}`);
    expect(cost?.session).toBe(`ahp-session:/${CHAT}`);
    expect(cost?.context).toBe(4242);
  });

  test("refuses a session id that is not a uuid", () => {
    log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 1 })]);
    expect(index().costOf(`copilotcli:/../session-state/${UUID}`)).toBeNull();
    expect(index().costOf(UUID)).toBeNull();
  });

  test("skips files older than 30 days on the first scan and reports complete", () => {
    log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 100 })]);
    const old = log(OTHER, [usage("2026-09-01T13:00:00.000Z", { input: 100 })]);
    utimesSync(old, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    const answer = index().all();
    expect(answer.complete).toBe(true);
    expect(answer.chats.map((chat) => chat.session)).toEqual([`copilotcli:/${UUID}`]);
  });

  test("scans at most 50 files a call, newest first, and is complete once all are read", () => {
    const ids = Array.from({ length: 55 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    ids.forEach((id, n) => {
      const path = log(id, [usage("2026-10-29T13:00:00.000Z", { input: n + 1 })]);
      utimesSync(path, new Date(NOW - n * 60_000), new Date(NOW - n * 60_000));
    });
    const costs = index();
    const first = costs.all();
    expect(first.complete).toBe(false);
    expect(first.chats).toHaveLength(50);
    expect(first.chats.some((chat) => chat.session === `copilotcli:/${ids[54]}`)).toBe(false);
    const second = costs.all();
    expect(second.complete).toBe(true);
    expect(second.chats).toHaveLength(55);
  });

  test("calls: one entry per message, the main agent's and its sub-agents' apart", () => {
    log(UUID, [
      userMessage("2026-10-29T12:00:00.000Z"),
      usage("2026-10-29T12:00:01.000Z", { input: 100, cacheRead: 0, cacheWrite: 100, output: 5 }),
      usage("2026-10-29T12:00:02.000Z", { input: 200, cacheRead: 100, output: 5 }),
      usage("2026-10-29T12:00:03.000Z", { input: 70, output: 1 }, { agentId: "sub-1" }),
      userMessage("2026-10-29T12:10:00.000Z"),
      usage("2026-10-29T12:10:01.000Z", { input: 300, cacheRead: 200, output: 7 }),
    ]);
    expect(index().calls(`copilotcli:/${UUID}`)).toEqual([
      { at: "2026-10-29T12:00:01.000Z", input: 300, cacheRead: 100, cacheWrite: 100, output: 10, main: true },
      { at: "2026-10-29T12:00:03.000Z", input: 70, cacheRead: 0, cacheWrite: 0, output: 1, main: false },
      { at: "2026-10-29T12:10:01.000Z", input: 300, cacheRead: 200, cacheWrite: 0, output: 7, main: true },
    ]);
  });
});
