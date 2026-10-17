import { describe, expect, it } from "bun:test";
import type { ChatState, RootState, SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import { agentsFrom, modelsFrom, promptFrom, readFrom, rowsFrom, turnsFrom } from "./chats.ts";

const AT = "2026-01-01T00:00:00.000Z";
const CHAT = "ahp-chat://default/fictional";

const chat = (overrides: Record<string, unknown>): ChatState => ({ resource: CHAT, title: "FICTIONAL_chat", status: 1, modifiedAt: AT, turns: [], ...overrides } as unknown as ChatState);
const user = (text: string) => ({ text, origin: { kind: "user" } });

const QUESTION = {
  id: "q-color", kind: "single-select", title: "Color", message: "FICTIONAL which color?", required: true,
  options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue", description: "the calm one" }],
};
const SECOND = { id: "q-size", kind: "text", title: "Size", message: "FICTIONAL what size?", required: true };

const asking = (request: Record<string, unknown>) => chat({
  status: 24,
  activeTurn: { id: "turn-2", startedAt: AT, message: user("FICTIONAL ask me"), usage: undefined, responseParts: [{ kind: "inputRequest", request }] },
});

describe("VS Code chat mappers", () => {
  it("a turn maps to a user turn and an assistant turn with folded tools", () => {
    const state = chat({
      turns: [{
        id: "turn-1", startedAt: AT, duration: 1500, state: "complete", usage: undefined, message: user("FICTIONAL list the files"),
        responseParts: [
          { kind: "reasoning", id: "r1", content: "FICTIONAL thinking" },
          { kind: "toolCall", toolCall: {
            status: "completed", toolCallId: "call-1", toolName: "bash", displayName: "Run in terminal",
            invocationMessage: { markdown: "Running `ls`" }, toolInput: "ls /tmp/fictional-repo", confirmed: "not-needed",
            success: true, pastTenseMessage: "Ran `ls`", content: [{ type: "text", text: "a.txt" }, { type: "text", text: "b.txt" }],
          } },
          { kind: "toolCall", toolCall: {
            status: "completed", toolCallId: "call-2", toolName: "view", displayName: "Read file",
            invocationMessage: "Reading", toolInput: { uri: "file:///tmp/fictional-repo/x" }, confirmed: "not-needed",
            success: false, pastTenseMessage: "Read", content: [],
          } },
          { kind: "markdown", id: "m1", content: "FICTIONAL two files" },
          { kind: "error", error: { errorType: "x", message: "FICTIONAL failure" } },
        ],
      }],
      activeTurn: { id: "turn-2", startedAt: AT, message: user("FICTIONAL again"), usage: undefined, responseParts: [] },
    });
    expect(turnsFrom(state)).toEqual([
      { role: "user", ts: AT, parts: [{ kind: "text", text: "FICTIONAL list the files" }] },
      { role: "assistant", ts: AT, end_ts: "2026-01-01T00:00:01.500Z", parts: [
        { kind: "thinking", text: "FICTIONAL thinking" },
        { kind: "tool", name: "Run in terminal", summary: "Running `ls`", input: "ls /tmp/fictional-repo", output: "a.txt\nb.txt", error: false },
        { kind: "tool", name: "Read file", summary: "Reading", input: "", output: "", error: true },
        { kind: "text", text: "FICTIONAL two files" },
        { kind: "text", text: "FICTIONAL failure", phase: "final_answer" },
      ] },
      { role: "user", ts: AT, parts: [{ kind: "text", text: "FICTIONAL again" }] },
      { role: "assistant", ts: AT, parts: [] },
    ]);
  });

  it("an answered input request reads back as its question and answer", () => {
    const state = chat({ turns: [{
      id: "turn-1", startedAt: AT, state: "complete", usage: undefined, message: user("FICTIONAL ask"),
      responseParts: [{ kind: "inputRequest", response: "accept", request: {
        id: "req-1", questions: [QUESTION],
        answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "blue", freeformValues: ["navy"] } } },
      } }],
    }] });
    expect(turnsFrom(state)[1]!.parts).toEqual([{ kind: "text", text: "FICTIONAL which color?\n→ Blue, navy" }]);
  });

  it("a pending confirmation is an approval prompt with the host's options", () => {
    const pending = (options?: unknown[]) => chat({
      status: 24,
      activeTurn: { id: "turn-2", startedAt: AT, message: user("FICTIONAL delete it"), usage: undefined, responseParts: [
        { kind: "markdown", id: "m1", content: "FICTIONAL ok" },
        { kind: "toolCall", toolCall: {
          status: "pending-confirmation", toolCallId: "call-9", toolName: "bash", displayName: "Run in terminal",
          invocationMessage: "Run `rm /tmp/fictional-repo/x`", toolInput: "rm /tmp/fictional-repo/x", confirmationTitle: "Allow this command?",
          ...(options ? { options } : {}),
        } },
      ] },
    });
    expect(promptFrom(pending([{ id: "allow-once", label: "Allow once", kind: "approve" }, { id: "allow-always", label: "Always allow", kind: "approve" }, { id: "no", label: "Skip", kind: "deny" }]))).toEqual({
      id: "turn-2:call-9", agent: "copilot", kind: "approval", title: "Allow this command?", question: "Run `rm /tmp/fictional-repo/x`",
      body: "rm /tmp/fictional-repo/x",
      options: [{ label: "Allow once", description: null }, { label: "Always allow", description: null }, { label: "Skip", description: null }],
      multi_select: false, custom_option_index: null,
      vscode: { tool_call_id: "call-9", turn_id: "turn-2", option_ids: ["allow-once", "allow-always", "no"], approves: [true, true, false] },
    });
    const plain = promptFrom(pending())!;
    expect(plain.options.map((option) => option.label)).toEqual(["Approve", "Deny"]);
    expect(plain.vscode).toEqual({ tool_call_id: "call-9", turn_id: "turn-2", option_ids: ["", ""], approves: [true, false] });
    expect(promptFrom(chat({}))).toBeNull();
  });

  it("an input request is a question prompt; allowFreeformInput adds the custom option", () => {
    const one = promptFrom(asking({ id: "req-1", questions: [QUESTION] }))!;
    expect(one).toEqual({
      id: "req-1:q-color", agent: "copilot", kind: "question", title: "Color", question: "FICTIONAL which color?", body: null,
      options: [{ label: "Red", description: null }, { label: "Blue", description: "the calm one" }],
      multi_select: false, custom_option_index: null,
      vscode: { request_id: "req-1", question_id: "q-color", option_ids: ["red", "blue"] },
    });
    const free = promptFrom(asking({ id: "req-1", questions: [{ ...QUESTION, allowFreeformInput: true }] }))!;
    expect(free.options.map((option) => option.label)).toEqual(["Red", "Blue", "Other"]);
    expect(free.custom_option_index).toBe(2);
    expect(free.vscode).toEqual({ request_id: "req-1", question_id: "q-color", option_ids: ["red", "blue", ""] });
    expect(free.steps).toBeUndefined();
    // an answered request asks nothing
    expect(promptFrom(chat({ status: 8, activeTurn: { id: "t", startedAt: AT, message: user("x"), usage: undefined, responseParts: [
      { kind: "inputRequest", response: "accept", request: { id: "req-1", questions: [QUESTION] } },
    ] } }))).toBeNull();
  });

  it("a two-question form carries steps", () => {
    const first = promptFrom(asking({ id: "req-2", questions: [QUESTION, SECOND] }))!;
    expect(first.id).toBe("req-2:q-color");
    expect(first.steps).toEqual([{ label: "Color", answered: false, current: true }, { label: "Size", answered: false, current: false }]);
    const second = promptFrom(asking({
      id: "req-2", questions: [QUESTION, SECOND],
      answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "red" } } },
    }))!;
    expect(second.id).toBe("req-2:q-size");
    expect(second.vscode).toEqual({ request_id: "req-2", question_id: "q-size", option_ids: [""] });
    expect(second.custom_option_index).toBe(0);
    expect(second.steps).toEqual([{ label: "Color", answered: true, current: false }, { label: "Size", answered: false, current: true }]);
    // the redraw is in the signature
    expect(readFrom("s", "t", asking({ id: "req-2", questions: [QUESTION, SECOND] })).signature)
      .not.toBe(readFrom("s", "t", asking({ id: "req-2", questions: [QUESTION, SECOND], answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "red" } } } })).signature);
  });

  it("efforts come from the model's configSchema thinkingLevel", () => {
    const root = {
      agents: [
        { provider: "other", displayName: "Other", description: "", models: [{ id: "fictional/other", name: "Other", provider: "other" }] },
        { provider: "copilotcli", displayName: "Fictional Agent", description: "", models: [
          { id: "fictional/model-a", name: "Fictional Model A", provider: "copilotcli", configSchema: { type: "object", properties: {
            mode: { type: "string", title: "Mode", enum: ["x", "y"] },
            thinkingLevel: { type: "string", title: "Thinking Level", enum: ["low", "medium", "high"] },
          } } },
          { id: "fictional/model-b", name: "Fictional Model B", provider: "copilotcli", configSchema: { type: "object", properties: { budget: { type: "string", title: "Budget", enum: ["small", "large"] } } } },
          { id: "fictional/model-c", name: "Fictional Model C", provider: "copilotcli" },
        ] },
      ],
    } as unknown as RootState;
    expect(modelsFrom(root)).toEqual([
      { id: "fictional/model-a", name: "Fictional Model A", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] } },
      { id: "fictional/model-b", name: "Fictional Model B", efforts: { key: "budget", values: ["small", "large"] } },
      { id: "fictional/model-c", name: "Fictional Model C", efforts: null },
    ]);
  });

  it("agents come from enabled agent customizations, nested in containers", () => {
    const agent = (name: string, enabled?: boolean) => ({
      id: name, type: "agent", name, uri: `file:///tmp/fictional/agents/${name}.agent.md`, description: `FICTIONAL ${name}`, ...(enabled === undefined ? {} : { enabled }),
    });
    const session = {
      provider: "copilotcli", title: "", status: 1, lifecycle: "ready", activeClients: [], chats: [],
      customizations: [
        { id: "dir", type: "directory", name: "agents", uri: "file:///tmp/fictional/agents", enabled: true, contents: "agent", writable: false,
          children: [agent("Report", true), agent("Off", false), { id: "s", type: "skill", name: "Skill", uri: "file:///tmp/fictional/skill.md" }] },
        { id: "plugin", type: "plugin", name: "Plugin", uri: "file:///tmp/fictional/plugin", children: [agent("Review"), agent("Report")] },
        { id: "off-dir", type: "directory", name: "off", uri: "file:///tmp/fictional/off", enabled: false, contents: "agent", writable: false, children: [agent("Hidden")] },
      ],
    } as unknown as SessionState;
    expect(agentsFrom(session)).toEqual([
      { uri: "file:///tmp/fictional/agents/Report.agent.md", name: "Report", description: "FICTIONAL Report" },
      { uri: "file:///tmp/fictional/agents/Review.agent.md", name: "Review", description: "FICTIONAL Review" },
    ]);
    expect(agentsFrom(undefined)).toEqual([]);
  });

  it("rowsFrom keeps copilotcli sessions only and maps InputNeeded to asks", () => {
    const row = (n: number, provider: string, status: number, modifiedAt: string): SessionSummary => ({
      resource: `${provider}:/${n}`, provider, title: `FICTIONAL_${n}`, status, createdAt: AT, modifiedAt,
      ...(n === 1 ? { workingDirectories: ["file:///tmp/fictional-repo"] } : {}),
    } as SessionSummary);
    expect(rowsFrom([
      row(1, "copilotcli", 24, "2026-01-01T00:00:01.000Z"),
      row(2, "copilotcli", 8 | 32, "2026-01-01T00:00:03.000Z"),
      row(3, "claude", 1, "2026-01-01T00:00:09.000Z"),
      row(4, "copilotcli", 2, "2026-01-01T00:00:02.000Z"),
      row(5, "copilotcli", 1 | 32, "2026-01-01T00:00:00.000Z"),
    ])).toEqual([
      { session: "copilotcli:/2", title: "FICTIONAL_2", status: "working", modified_at: "2026-01-01T00:00:03.000Z", cwd: null },
      { session: "copilotcli:/4", title: "FICTIONAL_4", status: "error", modified_at: "2026-01-01T00:00:02.000Z", cwd: null },
      { session: "copilotcli:/1", title: "FICTIONAL_1", status: "asks", modified_at: "2026-01-01T00:00:01.000Z", cwd: "/tmp/fictional-repo" },
      { session: "copilotcli:/5", title: "FICTIONAL_5", status: "idle", modified_at: "2026-01-01T00:00:00.000Z", cwd: null },
    ]);
  });

  it("a read takes the model and agent from the newest turn, else the draft's model", () => {
    const turn = { id: "turn-1", startedAt: AT, state: "complete", usage: undefined, responseParts: [], message: {
      ...user("FICTIONAL hi"), model: { id: "fictional/model-a", config: { thinkingLevel: "high" } }, agent: { uri: "file:///tmp/fictional/agents/Report.agent.md" },
    } };
    const read = readFrom("copilotcli:/1", "FICTIONAL_title", chat({ turns: [turn], turnsNextCursor: "c1" }));
    expect(read).toMatchObject({ session: "copilotcli:/1", title: "FICTIONAL_chat", status: "idle", cursor: "c1", prompt: null,
      model: { id: "fictional/model-a", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md", busy: false });
    expect(read.signature).toMatch(/^[0-9a-f]{16}$/);
    expect(readFrom("s", "t", chat({ draft: { ...user(""), model: { id: "fictional/model-a" } } })).model).toEqual({ id: "fictional/model-a", effort: null });
  });
});
