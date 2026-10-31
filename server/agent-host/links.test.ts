import { describe, expect, test } from "bun:test";

import { rowsFrom } from "./chats.ts";
import { factOf, resumeArg, spawnedChat } from "./links.ts";
import type { SessionSummary } from "@microsoft/agent-host-protocol";

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
