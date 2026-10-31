import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@microsoft/agent-host-protocol";

import { rowsFrom } from "./chats.ts";
import { factOf, LinkIndex, resumeArg, spawnedChat, type SdkLink } from "./links.ts";
import { forgetSessionTodos } from "./todos.ts";

const AT = "2026-10-31T09:53:45.534Z";
const PARENT = "ddf9fd94-03f5-43c5-8ff4-ea0c0ce71346";
const CHAT = "cffb352d-dc9e-424c-925b-e4e7f2d4b753";
const SPAWNED = `Chat created in the current session (agent-host-session://ahp-session/${PARENT}?chat=${CHAT}).`;
/** an `events.jsonl` line as Copilot writes it (1.0.95); `agentId` on the envelope marks a sub-agent's */
const line = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, id: `e-${type}`, timestamp: AT, parentId: "p", ...extra, data });

describe("factOf", () => {
  test("a user message is a first_user fact (the index keeps the log's first)", () => {
    expect(factOf(line("user.message", { content: "/resume zac-265", turnId: "0" }))).toEqual({ kind: "first_user", text: "/resume zac-265", at: AT });
  });

  test("an assistant reply ending on the resume line is a resume_line fact", () => {
    const content = "FICTIONAL note written.\n\nStart the next chat with: `/resume zac-266`";
    expect(factOf(line("assistant.message", { content, messageId: "m" }))).toEqual({ kind: "resume_line", topic: "zac-266", at: AT });
    // a reply without the line says nothing
    expect(factOf(line("assistant.message", { content: "FICTIONAL reply" }))).toBeNull();
  });

  test("create_session's completion is a spawned fact naming the new chat's host row", () => {
    const fact = factOf(line("tool.execution_complete", { toolCallId: "t", success: true, result: { content: SPAWNED } }));
    expect(fact).toEqual({ kind: "spawned", chat: spawnedChat(SPAWNED)!, at: AT });
  });

  test("a sub-agent's message is not the chat's", () => {
    expect(factOf(line("user.message", { content: "/resume x" }, { agentId: "a1" }))).toBeNull();
    expect(factOf(line("assistant.message", { content: "Start the next chat with: /resume x" }, { agentId: "a1" }))).toBeNull();
  });

  test("a line of no interest is skipped before JSON.parse", () => {
    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed += 1; return parse(...args); }) as typeof JSON.parse;
    try {
      expect(factOf(line("session.usage_record", { usage: { inputTokens: 1 } }))).toBeNull();
      // a tool result that is not create_session's
      expect(factOf(line("tool.execution_complete", { toolCallId: "t", result: { content: "FICTIONAL output" } }))).toBeNull();
    } finally { JSON.parse = parse; }
    expect(parsed).toBe(0);
  });

  test("a torn or foreign line is null", () => {
    expect(factOf('{"type":"user.message","data":{"content":"/res')).toBeNull();
    expect(factOf("")).toBeNull();
  });
});

describe("resumeArg", () => {
  test("the argument of a leading /resume or /harness:resume", () => {
    expect(resumeArg("/harness:resume 74ceb9b3-9e95-4924-a079-b3457d3364f5")).toBe("74ceb9b3-9e95-4924-a079-b3457d3364f5");
    expect(resumeArg("/resume zac-265")).toBe("zac-265");
    expect(resumeArg("  /resume zac-265\nFICTIONAL more")).toBe("zac-265");
    expect(resumeArg("please /resume x")).toBeNull();
    expect(resumeArg("/resume")).toBeNull();
    expect(resumeArg("/resumed x")).toBeNull();
  });
});

describe("spawnedChat", () => {
  test("names the chat as the bridge lists its row: ahp-chat://<chat>/<base64url of the parent's ahp-session URI>", () => {
    // the host lists the session and its peer chat (live on the Mac, 2026-10-31)
    const summary = {
      resource: `ahp-session:/${PARENT}`, provider: "copilotcli", title: "FICTIONAL parent", status: 1 | 32,
      createdAt: "2026-10-30T00:00:00.000Z", modifiedAt: "2026-10-31T00:00:00.000Z",
      workingDirectories: ["file:///tmp/fictional"], defaultChat: `ahp-chat://default/${Buffer.from(`ahp-session:/${PARENT}`).toString("base64url")}`,
      chats: [
        { resource: `ahp-chat://default/${Buffer.from(`ahp-session:/${PARENT}`).toString("base64url")}`, title: "FICTIONAL parent", interactivity: "full", status: 1 | 32 },
        { resource: `ahp-chat://${CHAT}/${Buffer.from(`ahp-session:/${PARENT}`).toString("base64url")}`, title: "FICTIONAL zac-265", interactivity: "full", origin: { kind: "user" }, status: 1 | 32 },
      ],
    } as unknown as SessionSummary;
    const row = rowsFrom([summary]).find((each) => each.fork_of !== undefined);
    expect(spawnedChat(SPAWNED)).toBe(row!.session);
    expect(spawnedChat(SPAWNED)).toBe(`ahp-chat://${CHAT}/YWhwLXNlc3Npb246L2RkZjlmZDk0LTAzZjUtNDNjNS04ZmY0LWVhMGMwY2U3MTM0Ng`);
  });

  test("anything else is null", () => {
    expect(spawnedChat("FICTIONAL output")).toBeNull();
    expect(spawnedChat(`cat log: ${SPAWNED}`)).toBeNull();
  });
});

describe("LinkIndex", () => {
  const A = "1da5c4f1-451b-4845-953f-52a960f82afa";
  const B = "7c0e2b1a-3f4d-4e5a-9b6c-0d1e2f3a4b5c";
  const C = "591b2f3f-e34c-4671-a7b8-e46c47c0b43b";
  const NOW = Date.parse("2026-10-31T12:00:00.000Z");
  const DAY = 86_400_000;
  const day = (n: number): string => new Date(NOW - 20 * DAY + n * DAY).toISOString();
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "links-")); forgetSessionTodos(); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const event = (type: string, at: string, data: Record<string, unknown>): string => `${JSON.stringify({ type, id: `e-${type}-${at}`, timestamp: at, parentId: "p", data })}\n`;
  const userSays = (at: string, content: string) => event("user.message", at, { content });
  const replies = (at: string, content: string) => event("assistant.message", at, { content });
  const handsOff = (at: string, topic: string) => replies(at, `FICTIONAL note.\n\nStart the next chat with: \`/resume ${topic}\``);
  const spawns = (at: string, parent: string, chat: string) => event("tool.execution_complete", at, { toolCallId: "t", success: true, result: { content: `Chat created in the current session (agent-host-session://ahp-session/${parent}?chat=${chat}).` } });
  function log(uuid: string, lines: string[]): string {
    const dir = join(home, "session-state", uuid);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "events.jsonl");
    writeFileSync(path, lines.join(""));
    return path;
  }
  const index = (agentDirs: readonly string[] = []) => new LinkIndex(home, agentDirs, () => NOW);
  const shown = (links: SdkLink[]) => links.map(({ from, to, kind }) => ({ from, to, kind }));

  test("spawn link: create_session's completion in A names B", () => {
    // the parent session's store names the SDK session the new chat runs on (as live on the Mac: cffb352d → 46069817)
    const PARENT = "ddf9fd94-03f5-43c5-8ff4-ea0c0ce71346";
    const CHAT = "cffb352d-dc9e-424c-925b-e4e7f2d4b753";
    const agentDirs = [join(home, "agentSessionData")];
    mkdirSync(join(agentDirs[0]!, PARENT), { recursive: true });
    const db = new Database(join(agentDirs[0]!, PARENT, "session.db"));
    db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    db.run("INSERT INTO session_metadata (key, value) VALUES ('peerChats', ?)", [JSON.stringify([
      { uri: `ahp-chat://${CHAT}/${Buffer.from(`copilotcli:/${PARENT}`).toString("base64url")}`, providerData: JSON.stringify({ sdkSessionId: B }), origin: { kind: "user" } },
    ])]);
    db.close();
    log(A, [userSays(day(0), "FICTIONAL start"), spawns(day(1), PARENT, CHAT)]);
    log(B, [userSays(day(1), "/resume zac-265")]);
    expect(index(agentDirs).all()).toEqual({ links: [{ from: A, to: B, kind: "spawn", at: day(1) }], complete: true });
    // a chat no store names yet keeps the host row id its result names
    const OTHER = "8f678541-9117-4969-8876-650a7d52749a";
    log(C, [spawns(day(2), PARENT, OTHER)]);
    expect(shown(index(agentDirs).all().links)).toContainEqual({ from: C, to: spawnedChat(`Chat created in the current session (agent-host-session://ahp-session/${PARENT}?chat=${OTHER}).`)!, kind: "spawn" });
  });

  test("continue link: B starts with /resume <A's uuid>", () => {
    log(A, [userSays(day(0), "FICTIONAL work")]);
    log(B, [userSays(day(1), `/harness:resume ${A}`)]);
    expect(index().all().links).toEqual([{ from: A, to: B, kind: "continue", at: day(1) }]);
  });

  test("resume link: A's reply ends on the resume line, B starts /resume <topic> a day later", () => {
    log(A, [userSays(day(0), "FICTIONAL work"), handsOff(day(1), "zac-265")]);
    log(B, [userSays(day(2), "/resume zac-265")]);
    expect(index().all().links).toEqual([{ from: A, to: B, kind: "resume", at: day(2) }]);
  });

  test("ambiguous topic makes no link", () => {
    log(A, [userSays(day(0), "FICTIONAL work"), handsOff(day(1), "x")]);
    log(C, [userSays(day(0), "FICTIONAL other work"), handsOff(day(1), "x")]);
    log(B, [userSays(day(2), "/resume x")]);
    expect(index().all().links).toEqual([]);
  });

  test("outside the 14-day window makes no link", () => {
    log(A, [userSays(day(0), "FICTIONAL work"), handsOff(day(0), "x")]);
    log(B, [userSays(day(15), "/resume x")]);
    expect(index().all().links).toEqual([]);
    // nor does a line written after the new chat began
    log(C, [userSays(day(16), "FICTIONAL work"), handsOff(day(16), "y")]);
    log(A, [userSays(day(15), "/resume y")]);
    expect(index().all().links).toEqual([]);
  });

  test("one link per (from, to): a spawned chat that also resumes A's topic is a spawn", () => {
    const PARENT = "ddf9fd94-03f5-43c5-8ff4-ea0c0ce71346";
    const CHAT = "cffb352d-dc9e-424c-925b-e4e7f2d4b753";
    const agentDirs = [join(home, "agentSessionData")];
    mkdirSync(join(agentDirs[0]!, C), { recursive: true });
    const db = new Database(join(agentDirs[0]!, C, "session.db"));
    db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    db.run("INSERT INTO session_metadata (key, value) VALUES ('peerChatBacking', ?)", [`ahp-chat://${CHAT}/${Buffer.from(`copilotcli:/${PARENT}`).toString("base64url")}`]);
    db.close();
    log(A, [handsOff(day(1), "t"), spawns(day(1), PARENT, CHAT)]);
    log(C, [userSays(day(1), "/resume t")]);
    const links = index(agentDirs);
    expect(shown(links.all().links)).toEqual([{ from: A, to: C, kind: "spawn" }]);
    // a job beats every kind the logs give
    links.addJob(A, C, day(1));
    expect(shown(links.all().links)).toEqual([{ from: A, to: C, kind: "job" }]);
  });

  test("a fork's copy of its source's events is not its own", () => {
    log(A, [handsOff(day(1), "t")]);
    // the fork copies the source's first message and reply, dated before its own start
    log(B, [event("session.start", day(3), { startTime: day(3) }), userSays(day(2), "/resume t"), handsOff(day(2), "u"), userSays(day(3), "FICTIONAL forked")]);
    log(C, [userSays(day(4), "/resume u")]);
    expect(index().all().links).toEqual([]);
  });

  test("incremental: a second all() reads only what was appended, a torn line waits", () => {
    const path = log(A, [userSays(day(0), "FICTIONAL work")]);
    log(B, [userSays(day(2), "/resume zac-265")]);
    const links = index();
    expect(links.all().links).toEqual([]);
    const before = links.bytesRead;
    const line = handsOff(day(1), "zac-265");
    appendFileSync(path, line.slice(0, 30));
    expect(links.all().links).toEqual([]);
    expect(links.bytesRead).toBe(before);
    appendFileSync(path, line.slice(30));
    expect(links.all().links).toEqual([{ from: A, to: B, kind: "resume", at: day(2) }]);
    expect(links.bytesRead - before).toBe(Buffer.byteLength(line));
  });

  test("reads at most its byte budget per call, and says when it is done", () => {
    log(A, [userSays(day(0), "FICTIONAL work"), handsOff(day(1), "t")]);
    log(B, [userSays(day(2), "/resume t")]);
    const links = new LinkIndex(home, [], () => NOW, 64);
    let answer = links.all();
    for (let calls = 1; !answer.complete; calls++) { expect(calls).toBeLessThan(50); answer = links.all(); }
    expect(shown(answer.links)).toEqual([{ from: A, to: B, kind: "resume" }]);
  });
});
