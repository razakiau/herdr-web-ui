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
  test("splits the last prompt as the CLI's log gives it: tool definitions, the system prompt last counted, messages (phase 1b)", () => {
    const at = (min: number) => new Date(Date.parse("2026-10-29T12:00:00.000Z") + min * 60_000).toISOString();
    const event = (type: string, min: number, data: Record<string, unknown>, agentId?: string) => `${JSON.stringify({ type, id: `${type}-${min}`, timestamp: at(min), parentId: "p", ...(agentId ? { agentId } : {}), data })}\n`;
    const call = (min: number, input: number, tools: number, extra: { agentId?: string } = {}) => usage(at(min), { input, cacheRead: input - 100 }, extra).replace('"maxPromptTokens":872000', `"maxPromptTokens":400000,"toolTokenCount":${tools}`);
    log(UUID, [
      call(0, 290_000, 29_986),
      event("session.compaction_start", 1, { systemTokens: 25_443, conversationTokens: 230_000, toolDefinitionsTokens: 29_986, currentTokens: 290_000, tokenLimit: 400_000 }),
      event("session.compaction_complete", 2, { systemTokens: 25_724, conversationTokens: 7_351, toolDefinitionsTokens: 29_986, tokenLimit: 400_000 }),
      call(3, 162_000, 29_986),
      // a sub-agent's call and compaction are its own context, not the chat's
      call(4, 20_000, 5_000, { agentId: "a1" }),
      event("session.compaction_complete", 5, { systemTokens: 999 }, "a1"),
    ]);
    expect(index().costOf(`copilotcli:/${UUID}`)!.split).toEqual({
      currentTokens: 162_000, tokenLimit: 400_000, toolDefinitionsTokens: 29_986, systemTokens: 25_724, conversationTokens: 162_000 - 25_724 - 29_986,
      // to one decimal: whole percents (16, 19, 66) would leave the popup a 1% "Other" of nothing
      parts: [{ category: "system", label: "System prompt", share: 15.9 }, { category: "system", label: "Tool Definitions", share: 18.5 }, { category: "user", label: "Messages", share: 65.6 }],
    });
    // no system prompt counted yet (no compaction, no shutdown): the tool definitions alone, no guess at the rest
    log(OTHER, [call(0, 50_000, 29_986)]);
    expect(index().costOf(`copilotcli:/${OTHER}`)!.split).toEqual({ currentTokens: 50_000, tokenLimit: 400_000, toolDefinitionsTokens: 29_986 });
  });

  test("keeps each model's last main-agent call and the last call's model (phase 1b)", () => {
    log(UUID, [
      usage("2026-10-29T12:00:00.000Z", { input: 100_000, cacheRead: 99_000 }, { model: "cc/claude-opus-5-5" }),
      usage("2026-10-29T12:30:00.000Z", { input: 100_500, cacheRead: 0 }, { model: "gpt-6" }),
      // a sub-agent's call on opus later: not the main agent's cache
      usage("2026-10-29T12:40:00.000Z", { input: 20_000 }, { model: "cc/claude-opus-5-5", agentId: "a1" }),
    ]);
    const cost = index().costOf(`copilotcli:/${UUID}`)!;
    expect(cost.lastModel).toBe("gpt-6");
    expect(Object.fromEntries(cost.models.map((each) => [each.model, each.lastCallAt]))).toEqual({ "cc/claude-opus-5-5": "2026-10-29T12:00:00.000Z", "gpt-6": "2026-10-29T12:30:00.000Z" });
  });

  test("sums main and subagent records into models", () => {
    log(UUID, [
      usage("2026-10-29T13:00:00.000Z", { input: 1000, cacheRead: 800, output: 10 }),
      usage("2026-10-29T13:01:00.000Z", { input: 2000, cacheRead: 1900, output: 20 }),
      usage("2026-10-29T13:02:00.000Z", { input: 50_000, cacheWrite: 50_000, output: 30 }, { agentId: "sub-1" }),
    ]);
    const cost = index().costOf(`copilotcli:/${UUID}`);
    expect(cost?.session).toBe(`copilotcli:/${UUID}`);
    // the sub-agent's 50K logged, the main agent's first call's 1100 inferred from its next read (1900 − 800): over half the 1900 cached after it, a cold restart
    expect(cost?.models).toEqual([{ model: "cc/claude-opus-5-5", input: 53_000, cacheRead: 2700, cacheWrite: 51_100, coldWrite: 1100, output: 60, calls: 3, lastCallAt: "2026-10-29T13:01:00.000Z" }]);
    expect(cost?.lastCallAt).toBe("2026-10-29T13:01:00.000Z");
    expect(cost?.context).toBe(2000);
    expect(cost?.peak).toBe(2000);
    expect(cost?.days["2026-10-29"]?.[0]?.calls).toBe(3);
    expect(cost?.partial).toBe(false);
  });

  test("counts a cold restart when the write is over half of what the cache holds after it", () => {
    log(UUID, [
      usage("2026-10-29T13:00:00.000Z", { input: 1000, cacheWrite: 600 }),
      // 400 written over 600 read: 40% of the 1000 cached after it, a warm call storing its new text
      usage("2026-10-29T13:01:00.000Z", { input: 1000, cacheRead: 600, cacheWrite: 400 }),
    ]);
    const cost = index().costOf(`copilotcli:/${UUID}`);
    expect(cost?.rewrites).toBe(1);
    expect(cost?.models[0]).toMatchObject({ cacheWrite: 1000, coldWrite: 600 });
  });

  test("an inferred write is a cold restart by the cache it leaves, onto the model, day and call", () => {
    log(UUID, [
      userMessage("2026-10-29T08:00:00.000Z"),
      usage("2026-10-29T08:00:01.000Z", { input: 100_000, cacheRead: 99_607, output: 5 }),
      // the cache expired: this call reads ~0 and the next one reads what it stored
      userMessage("2026-10-29T10:00:00.000Z"),
      usage("2026-10-29T10:00:01.000Z", { input: 102_100, cacheRead: 0, output: 5 }),
      usage("2026-10-29T10:00:02.000Z", { input: 103_000, cacheRead: 102_061, output: 5 }),
      usage("2026-10-29T10:00:03.000Z", { input: 104_000, cacheRead: 103_000, output: 5 }),
    ]);
    const costs = index();
    const cost = costs.costOf(`copilotcli:/${UUID}`);
    // 102,061 stored by the cold call; 939 stored by the warm one after it
    expect(cost?.models[0]).toMatchObject({ cacheWrite: 102_061 + 939, coldWrite: 102_061 });
    expect(cost?.days["2026-10-29"]?.[0]).toMatchObject({ coldWrite: 102_061 });
    expect(cost?.rewrites).toBe(1);
    expect(costs.calls(`copilotcli:/${UUID}`).map((call) => call.coldWrite)).toEqual([0, 102_061]);
  });

  test("calls: each reply says how many calls it holds and how many were cold restarts (the chart's card)", () => {
    log(UUID, [
      userMessage("2026-10-29T08:00:00.000Z"),
      usage("2026-10-29T08:00:01.000Z", { input: 1000, cacheWrite: 1000, output: 5 }),
      usage("2026-10-29T08:00:02.000Z", { input: 1100, cacheRead: 1000, cacheWrite: 100, output: 5 }),
      usage("2026-10-29T08:00:03.000Z", { input: 500, output: 5 }, { agentId: "sub-1" }),
      // the cache expired: a write the log does not give, inferred from the next call's read
      userMessage("2026-10-29T10:00:00.000Z"),
      usage("2026-10-29T10:00:01.000Z", { input: 102_100, cacheRead: 0, output: 5 }),
      usage("2026-10-29T10:00:02.000Z", { input: 103_000, cacheRead: 102_061, output: 5 }),
    ]);
    const calls = index().calls(`copilotcli:/${UUID}`);
    expect(calls.map((call) => [call.main, call.calls, call.restarts])).toEqual([[true, 2, 1], [false, 1, 0], [true, 2, 1]]);
  });

  test("a sub-agent's first write is never a cold restart", () => {
    log(UUID, [
      usage("2026-10-29T08:00:01.000Z", { input: 50_000, cacheRead: 0 }, { agentId: "sub-1" }),
      usage("2026-10-29T08:00:02.000Z", { input: 51_000, cacheRead: 50_000 }, { agentId: "sub-1" }),
    ]);
    const cost = index().costOf(`copilotcli:/${UUID}`);
    expect(cost?.models[0]).toMatchObject({ cacheWrite: 50_000, coldWrite: 0 });
    expect(cost?.rewrites).toBe(0);
  });

  test("calls: an answer to ask_user or askUser starts a reply of its own, a sub-agent's call stays in its reply", () => {
    const start = (at: string, id: string, tool: string, agentId?: string): string => `${JSON.stringify({ type: "tool.execution_start", id: `s-${id}`, timestamp: at, parentId: "p", ...(agentId ? { agentId } : {}), data: { toolCallId: id, toolName: tool, arguments: { question: "FICTIONAL question" } } })}\n`;
    const done = (at: string, id: string): string => `${JSON.stringify({ type: "tool.execution_complete", id: `c-${id}`, timestamp: at, parentId: `s-${id}`, data: { toolCallId: id, success: true, result: { content: "{\"response\": \"FICTIONAL answer\"}" } } })}\n`;
    const path = log(UUID, [
      userMessage("2026-10-29T12:00:00.000Z"),
      usage("2026-10-29T12:00:01.000Z", { input: 100, output: 1 }),
      start("2026-10-29T12:00:02.000Z", "toolu_ask1", "ask_user"),
      // a tool that only names ask_user in its arguments, and another tool's answer, start nothing
      `${JSON.stringify({ type: "tool.execution_start", id: "s-bash", timestamp: "2026-10-29T12:00:02.500Z", data: { toolCallId: "toolu_bash", toolName: "bash", arguments: { command: "grep ask_user x" } } })}\n`,
      done("2026-10-29T12:00:02.600Z", "toolu_bash"),
      done("2026-10-29T12:05:00.000Z", "toolu_ask1"),
      usage("2026-10-29T12:05:01.000Z", { input: 200, output: 2 }),
      usage("2026-10-29T12:05:02.000Z", { input: 70, output: 1 }, { agentId: "sub-1" }),
      start("2026-10-29T12:05:03.000Z", "toolu_ask2", "askUser"),
    ]);
    const costs = index();
    expect(costs.calls(`copilotcli:/${UUID}`).map((call) => [call.at, call.main])).toEqual([
      ["2026-10-29T12:00:01.000Z", true], ["2026-10-29T12:05:01.000Z", true], ["2026-10-29T12:05:02.000Z", false],
    ]);
    // the question asked in one read, answered in the next
    appendFileSync(path, done("2026-10-29T12:09:00.000Z", "toolu_ask2") + usage("2026-10-29T12:09:01.000Z", { input: 300, output: 3 }));
    costs.costOf(`copilotcli:/${UUID}`);
    expect(costs.calls(`copilotcli:/${UUID}`).filter((call) => call.main).map((call) => call.at)).toEqual([
      "2026-10-29T12:00:01.000Z", "2026-10-29T12:05:01.000Z", "2026-10-29T12:09:01.000Z",
    ]);
  });

  test("calls: a background sub-agent's calls stay in the reply that started it, across an ask_user answer and a message", () => {
    const start = (at: string, id: string): string => `${JSON.stringify({ type: "tool.execution_start", id: `s-${id}`, timestamp: at, parentId: "p", data: { toolCallId: id, toolName: "ask_user", arguments: {} } })}\n`;
    const done = (at: string, id: string): string => `${JSON.stringify({ type: "tool.execution_complete", id: `c-${id}`, timestamp: at, parentId: `s-${id}`, data: { toolCallId: id, success: true } })}\n`;
    const path = log(UUID, [
      userMessage("2026-10-29T12:00:00.000Z"),
      usage("2026-10-29T12:00:01.000Z", { input: 100, output: 1 }),
      usage("2026-10-29T12:00:02.000Z", { input: 10, output: 1 }, { agentId: "bg-1" }),
      start("2026-10-29T12:00:03.000Z", "toolu_ask"),
      done("2026-10-29T12:01:00.000Z", "toolu_ask"),
      usage("2026-10-29T12:01:01.000Z", { input: 200, output: 2 }),
      // still running from the first reply, and a sub-agent the second reply starts
      usage("2026-10-29T12:01:02.000Z", { input: 20, output: 1 }, { agentId: "bg-1" }),
      usage("2026-10-29T12:01:03.000Z", { input: 5, output: 1 }, { agentId: "sub-2" }),
    ]);
    const costs = index();
    const replies = (): unknown => costs.calls(`copilotcli:/${UUID}`).map((call) => [call.at, call.main, call.input]);
    expect(replies()).toEqual([
      ["2026-10-29T12:00:01.000Z", true, 100], ["2026-10-29T12:00:02.000Z", false, 30],
      ["2026-10-29T12:01:01.000Z", true, 200], ["2026-10-29T12:01:03.000Z", false, 5],
    ]);
    // in a later read too, after a message of the owner's
    appendFileSync(path, userMessage("2026-10-29T12:02:00.000Z") + usage("2026-10-29T12:02:01.000Z", { input: 300, output: 3 }) + usage("2026-10-29T12:02:02.000Z", { input: 40, output: 1 }, { agentId: "bg-1" }));
    costs.costOf(`copilotcli:/${UUID}`);
    expect(replies()).toEqual([
      ["2026-10-29T12:00:01.000Z", true, 100], ["2026-10-29T12:00:02.000Z", false, 70],
      ["2026-10-29T12:01:01.000Z", true, 200], ["2026-10-29T12:01:03.000Z", false, 5],
      ["2026-10-29T12:02:01.000Z", true, 300],
    ]);
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
    expect(costs.costOf(`copilotcli:/${UUID}`)?.models).toEqual([{ model: "cc/claude-opus-5-5", input: 100, cacheRead: 0, cacheWrite: 0, coldWrite: 0, output: 0, calls: 1, lastCallAt: "2026-10-29T13:00:00.000Z" }]);
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

  /** the parent's VS Code store, naming its default chat's SDK session and its other chats' */
  function parentStore(agentDirs: readonly string[], peers: { uri: string; sdk: string; origin?: unknown }[]): void {
    mkdirSync(join(agentDirs[0]!, CHAT), { recursive: true });
    const db = new Database(join(agentDirs[0]!, CHAT, "session.db"));
    db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    db.run("INSERT INTO session_metadata (key, value) VALUES ('defaultChatProviderData', ?)", [JSON.stringify({ sdkSessionId: OTHER })]);
    db.run("INSERT INTO session_metadata (key, value) VALUES ('peerChats', ?)", [JSON.stringify([
      { uri: "ahp-chat://another/x", isRead: true, providerData: JSON.stringify({ sdkSessionId: OTHER }) },
      ...peers.map((peer) => ({ uri: peer.uri, isRead: true, providerData: JSON.stringify({ sdkSessionId: peer.sdk, model: "m" }), origin: peer.origin ?? { kind: "user" } })),
    ])]);
    db.close();
  }

  test("maps a peer chat (ahp-chat://<id>/<parent>) to the SDK session its parent's store names", () => {
    // the parent runs on OTHER, its peer chat on UUID: each answers its own log
    log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 4242 })]);
    log(OTHER, [usage("2026-10-29T13:00:00.000Z", { input: 99 })]);
    const agentDirs = [join(home, "agentSessionData")];
    // as live on the Mac: the host lists it under the parent's ahp-session URI, the store keeps the copilotcli one
    const tail = (uri: string) => Buffer.from(uri).toString("base64url");
    const peer = `ahp-chat://8f678541-9117-4969-8876-650a7d52749a/${tail(`ahp-session:/${CHAT}`)}`;
    parentStore(agentDirs, [{ uri: `ahp-chat://8f678541-9117-4969-8876-650a7d52749a/${tail(`copilotcli:/${CHAT}`)}`, sdk: UUID }]);
    const costs = index(agentDirs);
    const cost = costs.costOf(peer);
    expect(cost?.session).toBe(peer);
    expect(cost?.context).toBe(4242);
    expect(costs.calls(peer)).toHaveLength(1);
    // a peer the parent's store does not name has no log
    expect(costs.costOf(`ahp-chat://unknown-id/${tail(`copilotcli:/${CHAT}`)}`)).toBeNull();
  });

  test("maps a fork listed as ahp-chat:/<uuid> through its parent (the row's fork_of)", () => {
    const FORK = "5a8cf5df-6b4e-4d32-bcf6-afd945c9eec4";
    log(UUID, [usage("2026-10-29T13:00:00.000Z", { input: 777 })]);
    const agentDirs = [join(home, "agentSessionData")];
    parentStore(agentDirs, [{ uri: `ahp-chat:/${FORK}`, sdk: UUID, origin: { kind: "fork", chat: "ahp-chat:/x", turnId: "t" } }]);
    const costs = index(agentDirs);
    // its id names no parent: without the row's fork_of there is nothing to read
    expect(costs.costOf(`ahp-chat:/${FORK}`)).toBeNull();
    expect(costs.costOf(`ahp-chat:/${FORK}`, `copilotcli:/${CHAT}`)?.context).toBe(777);
  });

  test("a fork's log counts only its own calls, not the source's it copies before its start", () => {
    // VS Code's Fork Conversation: the fork's log opens with its own session.start, then the source's
    // events up to the fork point verbatim (same ids, their earlier timestamps), then its own
    const start = (at: string) => `${JSON.stringify({ type: "session.start", id: "s", timestamp: at, parentId: null, data: { sessionId: UUID, startTime: at } })}\n`;
    const source = [
      userMessage("2026-10-29T09:00:00.000Z"),
      usage("2026-10-29T09:00:01.000Z", { input: 100_000, cacheWrite: 100_000, output: 50 }, { apiCallId: "src-1" }),
      usage("2026-10-29T09:00:02.000Z", { input: 101_000, cacheRead: 100_000, output: 50 }, { apiCallId: "src-2" }),
    ];
    log(OTHER, source);
    log(UUID, [start("2026-10-29T12:00:00.000Z"), ...source,
      userMessage("2026-10-29T12:00:05.000Z"),
      usage("2026-10-29T12:00:06.000Z", { input: 103_000, cacheRead: 101_000, output: 40 }, { apiCallId: "fork-1" }),
    ]);
    const costs = index();
    const fork = costs.costOf(`copilotcli:/${UUID}`)!;
    // one call of its own; its cache read continues the source's chain: 101K read, nothing inferred written yet
    expect(fork.models).toEqual([{ model: "cc/claude-opus-5-5", input: 103_000, cacheRead: 101_000, cacheWrite: 0, coldWrite: 0, output: 40, calls: 1, lastCallAt: "2026-10-29T12:00:06.000Z" }]);
    expect(fork.lastCallAt).toBe("2026-10-29T12:00:06.000Z");
    expect(fork.context).toBe(103_000);
    expect(fork.rewrites).toBe(0);
    expect(costs.calls(`copilotcli:/${UUID}`)).toHaveLength(1);
    // the PC's totals: the source's two calls once, the fork's one
    const all = costs.all().chats.reduce((sum, chat) => sum + chat.models.reduce((n, each) => n + each.calls, 0), 0);
    expect(all).toBe(3);
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
      // 100 logged, 100 inferred: the second call read 100, the next message's 200
      { at: "2026-10-29T12:00:01.000Z", input: 300, cacheRead: 100, cacheWrite: 200, coldWrite: 100, output: 10, main: true, context: 200, lastCacheRead: 100, calls: 2, restarts: 1 },
      { at: "2026-10-29T12:00:03.000Z", input: 70, cacheRead: 0, cacheWrite: 0, coldWrite: 0, output: 1, main: false, context: 70, lastCacheRead: 0, calls: 1, restarts: 0 },
      { at: "2026-10-29T12:10:01.000Z", input: 300, cacheRead: 200, cacheWrite: 0, coldWrite: 0, output: 7, main: true, context: 300, lastCacheRead: 200, calls: 1, restarts: 0 },
    ]);
  });

  test("costOf reads a big log over several requests, a floor until it is through", () => {
    const lines = [userMessage("2026-10-29T08:00:00.000Z"), ...Array.from({ length: 40 }, (_, i) => usage(`2026-10-29T08:00:${String(i).padStart(2, "0")}.000Z`, { input: 1000 + i * 100, cacheRead: i * 100, output: 3 }))];
    log(UUID, lines);
    const whole = index().costOf(`copilotcli:/${UUID}`);
    expect(whole?.partial).toBe(false);
    // about 5 lines a request
    const costs = new CostIndex(home, [], () => NOW, 2000);
    const first = costs.costOf(`copilotcli:/${UUID}`);
    expect(first?.partial).toBe(true);
    expect(first?.models[0]?.calls).toBeLessThan(40);
    let cost = first;
    for (let n = 0; n < 100 && cost?.partial; n++) cost = costs.costOf(`copilotcli:/${UUID}`);
    expect(cost).toEqual(whole);
    expect(costs.calls(`copilotcli:/${UUID}`)).toEqual(index().calls(`copilotcli:/${UUID}`));
  });

  test("all() takes a smaller budget for a server's poll, never a larger one (ZAC-260 review)", () => {
    log(UUID, [userMessage("2026-10-29T08:00:00.000Z"), ...Array.from({ length: 40 }, (_, i) => usage(`2026-10-29T08:00:${String(i).padStart(2, "0")}.000Z`, { input: 1000, output: 3 }))]);
    const calls = (answer: ReturnType<CostIndex["all"]>) => answer.chats[0]?.models[0]?.calls ?? 0;
    // the poll's budget: a few lines, a floor
    const polled = new CostIndex(home, [], () => NOW).all(2000);
    expect(polled.complete).toBe(false);
    expect(calls(polled)).toBeLessThan(40);
    // a page's request keeps the whole budget
    expect(calls(new CostIndex(home, [], () => NOW).all())).toBe(40);
    // asking for more than the index's own budget reads no more than it
    expect(calls(new CostIndex(home, [], () => NOW, 2000).all(1 << 30))).toBe(calls(polled));
  });

  test("calls reads a log costOf has not opened, within the same budget", () => {
    log(UUID, [userMessage("2026-10-29T08:00:00.000Z"), ...Array.from({ length: 40 }, (_, i) => usage(`2026-10-29T08:00:${String(i).padStart(2, "0")}.000Z`, { input: 1000, output: 3 }))]);
    const [message] = new CostIndex(home, [], () => NOW, 2000).calls(`copilotcli:/${UUID}`);
    expect(message?.input).toBeGreaterThan(0);
    expect(message?.input).toBeLessThan(40_000);
  });

  describe("cache writes Copilot logs as 0", () => {
    test("infers each call's write from its chain's next read, onto its own call, day and message", () => {
      log(UUID, [
        userMessage("2026-10-28T23:00:00.000Z"),
        usage("2026-10-28T23:59:00.000Z", { input: 10_000, cacheRead: 0, output: 5 }),
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 12_000, cacheRead: 9_000, output: 5 }),
        usage("2026-10-29T08:00:02.000Z", { input: 15_000, cacheRead: 11_500, output: 5 }),
      ]);
      const costs = index();
      const cost = costs.costOf(`copilotcli:/${UUID}`);
      // 9000 written by the first call, 2500 by the second; the newest waits for its next call
      expect(cost?.models[0]?.cacheWrite).toBe(11_500);
      expect(cost?.days["2026-10-28"]?.[0]?.cacheWrite).toBe(9_000);
      expect(cost?.days["2026-10-29"]?.[0]?.cacheWrite).toBe(2_500);
      // 9000 of a 10K prompt is a cold cache's rewrite; 2500 of 12K is not
      expect(cost?.rewrites).toBe(1);
      expect(costs.calls(`copilotcli:/${UUID}`).map((call) => call.cacheWrite)).toEqual([9_000, 2_500]);
    });

    test("a logged write is used as is, never added to an inferred one", () => {
      log(UUID, [
        usage("2026-10-29T08:00:01.000Z", { input: 10_000, cacheRead: 0, cacheWrite: 8_000 }),
        usage("2026-10-29T08:00:02.000Z", { input: 12_000, cacheRead: 9_000 }),
        usage("2026-10-29T08:00:03.000Z", { input: 13_000, cacheRead: 12_000 }),
      ]);
      const cost = index().costOf(`copilotcli:/${UUID}`);
      expect(cost?.models[0]?.cacheWrite).toBe(8_000 + 3_000);
    });

    test("a sub-agent's chain and the main agent's don't mix, nor two models'", () => {
      log(UUID, [
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 100_000, cacheRead: 90_000 }),
        usage("2026-10-29T08:00:02.000Z", { input: 5_000, cacheRead: 0 }, { agentId: "sub-1" }),
        usage("2026-10-29T08:00:03.000Z", { input: 6_000, cacheRead: 0 }, { agentId: "sub-2", model: "gpt-fictional" }),
        usage("2026-10-29T08:00:04.000Z", { input: 7_000, cacheRead: 4_800 }, { agentId: "sub-1" }),
        usage("2026-10-29T08:00:05.000Z", { input: 9_000, cacheRead: 5_500 }, { agentId: "sub-2", model: "gpt-fictional" }),
        usage("2026-10-29T08:00:06.000Z", { input: 101_000, cacheRead: 99_000 }),
      ]);
      const costs = index();
      const cost = costs.costOf(`copilotcli:/${UUID}`);
      const write = (model: string) => cost?.models.find((each) => each.model === model)?.cacheWrite;
      // main 99000 − 90000, sub-1 4800 − 0; never 4800 − 90000 or 99000 − 7000
      expect(write("cc/claude-opus-5-5")).toBe(9_000 + 4_800);
      expect(write("gpt-fictional")).toBe(5_500);
      const [main, sub] = costs.calls(`copilotcli:/${UUID}`);
      expect(main?.cacheWrite).toBe(9_000);
      expect(sub?.cacheWrite).toBe(4_800 + 5_500);
      expect(cost?.rewrites).toBe(0);
    });

    test("the newest call gets its write when its next call is read, in a later read", () => {
      const path = log(UUID, [
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 20_000, cacheRead: 0 }),
      ]);
      const costs = index();
      expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.cacheWrite).toBe(0);
      appendFileSync(path, userMessage("2026-10-29T08:30:00.000Z") + usage("2026-10-29T08:30:01.000Z", { input: 21_000, cacheRead: 19_000 }));
      const cost = costs.costOf(`copilotcli:/${UUID}`);
      expect(cost?.models[0]?.cacheWrite).toBe(19_000);
      expect(cost?.days["2026-10-29"]?.[0]?.cacheWrite).toBe(19_000);
      expect(cost?.rewrites).toBe(1);
      // onto the first message's call, not the one just read
      expect(costs.calls(`copilotcli:/${UUID}`).map((call) => call.cacheWrite)).toEqual([19_000, 0]);
    });

    test("a side call between two main calls keeps its tokens, gets no write and leaves the chain to them", () => {
      log(UUID, [
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 200_000, cacheRead: 190_000, output: 50 }),
        // a title or summary call: 0.25% of the prompt, nothing read
        usage("2026-10-29T08:00:02.000Z", { input: 500, cacheRead: 0, cacheWrite: 120, output: 10 }),
        usage("2026-10-29T08:00:03.000Z", { input: 205_000, cacheRead: 199_000, output: 50 }),
      ]);
      const costs = index();
      const cost = costs.costOf(`copilotcli:/${UUID}`);
      // 199000 − 190000 onto the first call, plus the side call's own 120; never 199000 − 0 onto the side call
      expect(cost?.models[0]).toMatchObject({ input: 405_500, cacheRead: 389_000, cacheWrite: 9_000 + 120, output: 110, calls: 3 });
      expect(cost?.rewrites).toBe(0);
      expect(costs.calls(`copilotcli:/${UUID}`)[0]?.cacheWrite).toBe(9_120);
    });

    test("a side call doesn't count as a rewrite and gets no write from the next call", () => {
      log(UUID, [
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 200_000, cacheRead: 190_000 }),
        userMessage("2026-10-29T08:01:00.000Z"),
        usage("2026-10-29T08:01:01.000Z", { input: 465, cacheRead: 0 }),
        userMessage("2026-10-29T08:02:00.000Z"),
        usage("2026-10-29T08:02:01.000Z", { input: 232_000, cacheRead: 200_000 }),
      ]);
      const costs = index();
      expect(costs.costOf(`copilotcli:/${UUID}`)?.rewrites).toBe(0);
      expect(costs.calls(`copilotcli:/${UUID}`).map((call) => call.cacheWrite)).toEqual([10_000, 0, 0]);
    });

    test("the chain survives a read split right after a side call", () => {
      const path = log(UUID, [
        userMessage("2026-10-29T08:00:00.000Z"),
        usage("2026-10-29T08:00:01.000Z", { input: 100_000, cacheRead: 90_000 }),
        usage("2026-10-29T08:00:02.000Z", { input: 400, cacheRead: 0 }),
      ]);
      const costs = index();
      expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.cacheWrite).toBe(0);
      appendFileSync(path, usage("2026-10-29T08:00:03.000Z", { input: 104_000, cacheRead: 99_000 }));
      expect(costs.costOf(`copilotcli:/${UUID}`)?.models[0]?.cacheWrite).toBe(9_000);
      expect(costs.calls(`copilotcli:/${UUID}`)[0]?.cacheWrite).toBe(9_000);
    });

    test("a chain's first call is never a side call, nor one that reads like its predecessor", () => {
      log(UUID, [
        usage("2026-10-29T08:00:01.000Z", { input: 500, cacheRead: 0 }),
        usage("2026-10-29T08:00:02.000Z", { input: 20_000, cacheRead: 400 }),
        // small prompt but a read over 10% of the previous one: a real call
        usage("2026-10-29T08:00:03.000Z", { input: 1_500, cacheRead: 1_000 }),
      ]);
      // 400 onto the first, 600 onto the second
      expect(index().costOf(`copilotcli:/${UUID}`)?.models[0]?.cacheWrite).toBe(1_000);
    });

    test("a read that drops (a compaction, a new context) infers no write, never a negative one", () => {
      log(UUID, [
        usage("2026-10-29T08:00:01.000Z", { input: 150_000, cacheRead: 149_000 }),
        usage("2026-10-29T08:00:02.000Z", { input: 30_000, cacheRead: 0 }),
        usage("2026-10-29T08:00:03.000Z", { input: 31_000, cacheRead: 29_500 }),
      ]);
      const cost = index().costOf(`copilotcli:/${UUID}`);
      expect(cost?.models[0]?.cacheWrite).toBe(29_500);
      expect(cost?.rewrites).toBe(1);
    });
  });

  test("calls: a message's context is its last main call's prompt, not the sum of its tool loop", () => {
    log(UUID, [
      userMessage("2026-10-29T12:00:00.000Z"),
      ...Array.from({ length: 10 }, (_, i) => usage(`2026-10-29T12:00:${String(i + 1).padStart(2, "0")}.000Z`, { input: 200_000 + i * 1000, cacheRead: i === 9 ? 150_000 : 199_000 + i * 1000, output: 50 })),
      usage("2026-10-29T12:00:30.000Z", { input: 9000, cacheRead: 8000, output: 5 }, { agentId: "sub-1" }),
    ]);
    const [main, sub] = index().calls(`copilotcli:/${UUID}`);
    expect(main?.input).toBe(2_045_000);
    expect(main?.context).toBe(209_000);
    expect(main?.lastCacheRead).toBe(150_000);
    expect(sub).toMatchObject({ main: false, context: 9000, lastCacheRead: 8000 });
  });
});
