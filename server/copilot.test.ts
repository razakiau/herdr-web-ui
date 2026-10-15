import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationPart, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { forgetTranscriptState, paneConversation, toolOutput } from "./conversation.ts";
import { parseCopilotEvents, parseCopilotMetadata } from "./copilot.ts";
import * as herdr from "./herdr/client.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/copilot/${name}.jsonl`, import.meta.url), "utf8");
const tools = (turn: ConversationTurn | undefined): Extract<ConversationPart, { kind: "tool" }>[] =>
  (turn?.parts ?? []).filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
const texts = (turns: ConversationTurn[]): string[] => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [`${turn.role}: ${part.text}`] : []));

describe("a Copilot session's events as a chat", () => {
  it("shows a prompt, its reasoning, the commentary and the answer as one assistant turn", () => {
    const turns = parseCopilotEvents(fixture("tools"));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "FICTIONAL_PROMPT_TOOLS" }]);
    const parts = turns[1]!.parts.map((part) => part.kind === "text" || part.kind === "thinking" ? `${part.kind}:${part.text}` : part.kind);
    expect(parts).toEqual(["thinking:FICTIONAL_REASONING_TWO", "text:FICTIONAL_COMMENTARY_BEFORE_TOOLS", "tool", "tool", "text:FICTIONAL_FINAL_ANSWER"]);
    expect(turns[0]!.ts).toBe("2026-10-01T09:00:00.279Z");
    // the turn started with its first answer and ended with its last
    expect(turns[1]!.ts).toBe("2026-10-01T09:00:00.292Z");
    expect(turns[1]!.end_ts).toBe("2026-10-01T09:00:00.371Z");
  });

  it("folds each tool call with its input and its output, and marks the one that failed", () => {
    const [bash, view] = tools(parseCopilotEvents(fixture("tools"))[1]);
    expect(bash).toMatchObject({ name: "bash", summary: "Print a fictional line" });
    expect(JSON.parse(bash!.input)).toEqual({ command: "printf '%s\\n' FICTIONAL_TOOL_OUTPUT", description: "Print a fictional line" });
    expect(bash!.output).toContain("FICTIONAL_TOOL_OUTPUT");
    expect(bash!.error).toBeUndefined();
    expect(view).toMatchObject({ name: "view", summary: "/nonexistent/fictional.txt", error: true });
    // a failed call has no result: what went wrong is its output
    expect(view!.output).toBe("Permission denied and could not request permission from user");
  });

  it("keeps a subagent's own prompt and answer out of the chat, its result in the call that started it", () => {
    const turns = parseCopilotEvents(fixture("subagent"));
    expect(texts(turns)).toEqual(["user: FICTIONAL_PROMPT_SUBAGENT", "assistant: FICTIONAL_DELEGATING", "assistant: FICTIONAL_AFTER_SUBAGENT"]);
    const [task] = tools(turns[1]);
    expect(task).toMatchObject({ name: "task", summary: "Fictional lookup", output: "FICTIONAL_SUBAGENT_REPORT" });
  });

  it("shows a model error as the turn's text, the way pi's errors read", () => {
    const turns = parseCopilotEvents(fixture("model-error"));
    expect(texts(turns)).toEqual(["user: FICTIONAL_PROMPT_ERROR", "assistant: Error: 400 FICTIONAL_UPSTREAM_ERROR"]);
  });

  it("shows a question asked with ask_user, and the answer once it is given", () => {
    const waiting = tools(parseCopilotEvents(fixture("ask-waiting"))[1]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ name: "ask_user", summary: "FICTIONAL_QUESTION?", output: "" });
    const answered = parseCopilotEvents(fixture("ask-answered"));
    const [ask] = tools(answered[1]);
    expect(ask).toMatchObject({ name: "ask_user", summary: "FICTIONAL_QUESTION?", output: "User responded: FICTIONAL_BLUE" });
    expect(texts(answered)).toEqual([
      "user: FICTIONAL_PROMPT_ASK", "assistant: FICTIONAL_ASKING", "assistant: FICTIONAL_GOT_ANSWER",
      "user: FICTIONAL_PROMPT_LONG", "assistant: FICTIONAL_SECOND_REPLY", "assistant: FICTIONAL_AFTER_ABORT",
    ]);
  });

  it("ends an interrupted turn where it stopped, and the next prompt opens a new one", () => {
    const turns = parseCopilotEvents(fixture("abort"));
    expect(turns.map((turn) => turn.role)).toEqual(["user"]);
    const moved = parseCopilotEvents(fixture("migrated"));
    expect(moved[1]!.parts.some((part) => part.kind === "notice")).toBe(false);
    expect(moved[2]).toMatchObject({ role: "user", parts: [{ kind: "text", text: "FICTIONAL_MOVED_SECOND" }] });
  });

  it("reads a chat moved from VS Code's Local harness, and what was said after the move", () => {
    const turns = parseCopilotEvents(fixture("migrated"));
    expect(texts(turns)).toEqual([
      "user: FICTIONAL_MOVED_PROMPT", "assistant: FICTIONAL_MOVED_REPLY",
      "user: FICTIONAL_MOVED_SECOND", "assistant: FICTIONAL_MOVED_SECOND_REPLY",
      "user: FICTIONAL_NATIVE_AFTER_MOVE", "assistant: FICTIONAL_NATIVE_REPLY",
    ]);
    const moved = turns[1]!;
    // the Local harness's ask_user names its question `question`, the CLI's `message`
    expect(tools(moved).map((tool) => [tool.name, tool.summary, tool.error ?? false])).toEqual([
      ["ask_user", "FICTIONAL_MOVED_QUESTION?", false],
      ["run_in_terminal", "printf FICTIONAL", true],
    ]);
    expect(turns[5]!.parts[0]).toEqual({ kind: "thinking", text: "FICTIONAL_NATIVE_REASONING" });
  });

  it("leaves out a message the runtime injected, which nobody typed", () => {
    const lines = [
      { type: "user.message", id: "e1", parentId: null, timestamp: "2026-10-01T09:00:00.000Z", data: { content: "typed" } },
      { type: "user.message", id: "e2", parentId: "e1", timestamp: "2026-10-01T09:00:01.000Z", data: { content: "SKILL.md body", source: "skill-pdf" } },
      { type: "user.message", id: "e3", parentId: "e2", timestamp: "2026-10-01T09:00:02.000Z", data: { content: "also typed", source: "user" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(texts(parseCopilotEvents(lines))).toEqual(["user: typed", "user: also typed"]);
  });

  it("cuts a long output and keeps the call's id to fetch the rest", () => {
    const long = "x".repeat(10_000);
    const lines = [
      { type: "user.message", id: "e1", parentId: null, timestamp: "2026-10-01T09:00:00.000Z", data: { content: "go" } },
      { type: "assistant.message", id: "e2", parentId: "e1", timestamp: "2026-10-01T09:00:01.000Z", data: { content: "", messageId: "m", toolRequests: [] } },
      { type: "tool.execution_start", id: "e3", parentId: "e2", timestamp: "2026-10-01T09:00:01.000Z", data: { toolCallId: "call_long", toolName: "bash", arguments: { command: "yes" } } },
      { type: "tool.execution_complete", id: "e4", parentId: "e3", timestamp: "2026-10-01T09:00:02.000Z", data: { toolCallId: "call_long", success: true, result: { content: long } } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const [tool] = tools(parseCopilotEvents(lines)[1]);
    expect(tool!.output_ref).toBe("call_long");
    expect(tool!.output_size).toBe(10_000);
    expect(tool!.output.length).toBeLessThan(10_000);
  });

  it("starts over at a cleared context, and tolerates a torn last line", () => {
    const lines = [
      { type: "user.message", id: "e1", parentId: null, timestamp: "2026-10-01T09:00:00.000Z", data: { content: "before" } },
      { type: "assistant.message", id: "e2", parentId: "e1", timestamp: "2026-10-01T09:00:01.000Z", data: { content: "old", messageId: "m1" } },
      { type: "session.context_cleared", id: "e3", parentId: "e2", timestamp: "2026-10-01T09:00:02.000Z", data: { messagesCleared: 2 } },
      { type: "user.message", id: "e4", parentId: "e3", timestamp: "2026-10-01T09:00:03.000Z", data: { content: "after" } },
    ].map((line) => JSON.stringify(line)).join("\n") + '\n{"type":"assistant.message","id":"e5","par';
    expect(texts(parseCopilotEvents(lines))).toEqual(["user: after"]);
  });

  it("shows a compaction's summary where the conversation was cut", () => {
    const lines = [
      { type: "user.message", id: "e1", parentId: null, timestamp: "2026-10-01T09:00:00.000Z", data: { content: "long work" } },
      { type: "session.compaction_complete", id: "e2", parentId: "e1", timestamp: "2026-10-01T09:00:02.000Z", data: { success: true, summaryContent: "FICTIONAL_SUMMARY" } },
      { type: "session.compaction_complete", id: "e3", parentId: "e2", timestamp: "2026-10-01T09:00:03.000Z", data: { success: false, error: "no" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(parseCopilotEvents(lines).map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "long work" },
      { kind: "compact", text: "FICTIONAL_SUMMARY" },
    ]);
  });
});

describe("a Copilot session's model and effort", () => {
  it("reads the model the main chat answered with, never a subagent's", () => {
    expect(parseCopilotMetadata(fixture("subagent"))).toEqual({ model: "fixture-model", reasoning_effort: null });
  });

  it("follows a resume's model and effort, and the last request's context against its window", () => {
    expect(parseCopilotMetadata(fixture("migrated"))).toEqual({
      model: "fixture/model-b", reasoning_effort: "xhigh", context: { used: 1500, window: 200000 },
    });
  });

  it("follows a model change the user made, not one a subagent made", () => {
    const lines = [
      { type: "session.start", id: "e1", parentId: null, timestamp: "t", data: { sessionId: "s", selectedModel: "a", reasoningEffort: "high" } },
      { type: "session.model_change", id: "e2", parentId: "e1", timestamp: "t", data: { newModel: "b", reasoningEffort: "low" }, agentId: "sub" },
      { type: "session.model_change", id: "e3", parentId: "e2", timestamp: "t", data: { newModel: "c", reasoningEffort: "medium" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(parseCopilotMetadata(lines)).toEqual({ model: "c", reasoning_effort: "medium" });
  });
});

describe("a Copilot pane's chat", () => {
  let home = "";
  let savedHome: string | undefined;
  let savedCopilotHome: string | undefined;
  let pane: HerdrPane;
  const restores: Array<() => void> = [];
  const SESSION = "00000000-0000-4000-8000-000000000001";
  const store = () => join(home, ".copilot", "session-state");
  const writeSession = (id: string, name = "tools") => {
    mkdirSync(join(store(), id), { recursive: true });
    writeFileSync(join(store(), id, "events.jsonl"), fixture(name));
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-copilot-pane-")));
    savedHome = process.env["HOME"];
    savedCopilotHome = process.env["COPILOT_HOME"];
    process.env["HOME"] = home;
    delete process.env["COPILOT_HOME"];
    const cwd = join(home, "project");
    mkdirSync(cwd);
    pane = { pane_id: "pane-copilot", cwd, foreground_cwd: cwd, agent: "copilot", agent_status: "idle",
      agent_session: { agent: "copilot", kind: "id", source: "herdr:copilot", value: SESSION } } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method === "agent.get") return { agent: { agent_session: pane.agent_session } } as never;
      throw new Error(`unexpected RPC: ${method}`);
    });
    restores.push(() => snapshot.mockRestore(), () => rpc.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    if (savedCopilotHome === undefined) delete process.env["COPILOT_HOME"]; else process.env["COPILOT_HOME"] = savedCopilotHome;
    rmSync(home, { recursive: true, force: true });
    forgetTranscriptState();
  });

  it("reads the session herdr's Copilot integration names, in ~/.copilot", async () => {
    writeSession(SESSION);
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("copilot-transcript");
    expect(texts(answer.turns)).toEqual(["user: FICTIONAL_PROMPT_TOOLS", "assistant: FICTIONAL_COMMENTARY_BEFORE_TOOLS", "assistant: FICTIONAL_FINAL_ANSWER"]);
    expect(answer.metadata).toEqual({ model: "fixture-model", reasoning_effort: null });
  });

  it("reads the store COPILOT_HOME moves it to", async () => {
    const moved = join(home, "elsewhere");
    process.env["COPILOT_HOME"] = moved;
    mkdirSync(join(moved, "session-state", SESSION), { recursive: true });
    writeFileSync(join(moved, "session-state", SESSION, "events.jsonl"), fixture("abort"));
    const answer = await paneConversation(pane.pane_id);
    expect(texts(answer.turns)).toEqual(["user: FICTIONAL_PROMPT_STALL"]);
  });

  it("fetches a call's whole output by its id", async () => {
    writeSession(SESSION);
    expect(await toolOutput(pane.pane_id, "call_fixture_1_0")).toContain("FICTIONAL_TOOL_OUTPUT");
    expect(await toolOutput(pane.pane_id, "call_unknown")).toBeNull();
  });

  it("answers a session not written yet as a chat not begun, before Copilot made its store too", async () => {
    const answer = await paneConversation(pane.pane_id);
    expect(answer).toMatchObject({ source: "copilot-transcript", turns: [] });
    forgetTranscriptState();
    mkdirSync(store(), { recursive: true });
    expect(await paneConversation(pane.pane_id)).toMatchObject({ source: "copilot-transcript", turns: [] });
  });

  it("refuses a session whose file is another session's, linked under its name", async () => {
    const other = "00000000-0000-4000-8000-0000000000aa";
    writeSession(other);
    mkdirSync(join(store(), SESSION), { recursive: true });
    symlinkSync(join(store(), other, "events.jsonl"), join(store(), SESSION, "events.jsonl"));
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it("refuses an id that is no session id, a session another agent reported, and a link out of the store", async () => {
    writeSession(SESSION);
    for (const value of ["../escape", "not-an-id", ""]) {
      pane.agent_session = { agent: "copilot", kind: "id", source: "herdr:copilot", value };
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_id");
    }
    pane.agent_session = { agent: "codex", kind: "id", source: "herdr:codex", value: SESSION };
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_id");
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "events.jsonl"), fixture("tools"));
    const linked = "00000000-0000-4000-8000-0000000000ff";
    symlinkSync(outside, join(store(), linked));
    pane.agent_session = { agent: "copilot", kind: "id", source: "herdr:copilot", value: linked };
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it("pages a long session: the newest page first, the turns before it on request", async () => {
    const lines: string[] = [];
    for (let n = 0; n < 120; n += 1) {
      lines.push(JSON.stringify({ type: "user.message", id: `u${n}`, parentId: null, timestamp: "2026-10-01T09:00:00.000Z", data: { content: `prompt ${n}` } }));
      lines.push(JSON.stringify({ type: "assistant.message", id: `a${n}`, parentId: `u${n}`, timestamp: "2026-10-01T09:00:01.000Z", data: { content: `answer ${n}`, messageId: `m${n}` } }));
    }
    mkdirSync(join(store(), SESSION), { recursive: true });
    writeFileSync(join(store(), SESSION, "events.jsonl"), lines.join("\n") + "\n");
    const newest = await paneConversation(pane.pane_id);
    expect(newest.cursor).not.toBeNull();
    expect(texts(newest.turns).at(-1)).toBe("assistant: answer 119");
    const older = await paneConversation(pane.pane_id, undefined, { before: newest.cursor! });
    expect(texts([...older.turns, ...newest.turns])).toEqual(lines.map((line) => {
      const entry = JSON.parse(line) as { type: string; data: { content: string } };
      return `${entry.type === "user.message" ? "user" : "assistant"}: ${entry.data.content}`;
    }).slice(-texts([...older.turns, ...newest.turns]).length));
  });
});
