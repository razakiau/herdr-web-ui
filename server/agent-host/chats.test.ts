import { describe, expect, it } from "bun:test";
import type { ChatState, RootState, SessionState, SessionSummary, StateAction, ToolCallResult } from "@microsoft/agent-host-protocol";
import type { ConversationPart } from "../../shared/protocol.ts";
import { TOOL_OUTPUT_CHARS } from "../tool-output.ts";
import { agentsFrom, commandsFrom, imageOf, modelsFrom, promptFrom, readFrom, rowsFrom, toolOutputOf, turnsFrom } from "./chats.ts";
import { parseInline } from "../../src/lib/markdown.ts";
import { reducedChat, toolCallActions } from "./fake-host.ts";

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

describe("host chat mappers", () => {
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
        { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running `ls`", past: "Ran `ls`", input: "ls /tmp/fictional-repo", output: "a.txt\nb.txt", error: false },
        { kind: "tool", name: "Read file", tool_id: "view", summary: "Reading", past: "Read", input: "", output: "", error: true },
        { kind: "text", text: "FICTIONAL two files" },
      ] },
      { role: "user", ts: AT, parts: [{ kind: "text", text: "FICTIONAL again" }] },
      { role: "assistant", ts: AT, parts: [] },
    ]);
  });

  it("a finished ask_user call reads as a question with its whole report, not as a tool row", () => {
    const ask = (toolCallId: string, toolName: string, input: unknown, out: string, success = true) => ({ kind: "toolCall", toolCall: {
      status: "completed", toolCallId, toolName, displayName: toolName, invocationMessage: toolName, toolInput: JSON.stringify(input),
      confirmed: "not-needed", success, pastTenseMessage: "Ask User", content: [{ type: "text", text: out }],
    } });
    const report = "FICTIONAL **Shipped** the fix.\n\n- one\n- two";
    const state = chat({ turns: [{
      id: "turn-1", startedAt: AT, state: "complete", usage: undefined, message: user("FICTIONAL go"),
      responseParts: [
        // VS Code's own ask_user: message plus a form, answered as "User responded:" lines
        ask("a1", "ask_user", { message: report, requestedSchema: { properties: { next: { type: "string" } } } }, "User responded:\nnext: FICTIONAL merge it\nnotes: "),
        // TaskSync's askUser: question, answered as JSON whose response carries its own reminder after a blank line
        ask("a2", "askUser", { question: "FICTIONAL Which one?", session_id: "4" }, JSON.stringify({ session_id: "4", response: "FICTIONAL the second\n\nREQUIRED: FICTIONAL reminder" })),
        ask("a3", "ask_user", { message: "FICTIONAL ok?" }, "User cancelled the request."),
        ask("a4", "askUser", { question: "FICTIONAL lost?" }, "External tool request failed", false),
      ],
    }] });
    expect(turnsFrom(state)[1]!.parts).toEqual([
      { kind: "question", text: "FICTIONAL Shipped the fix.", report, options: [], chosen: [], custom: "next: FICTIONAL merge it", skipped: false },
      { kind: "question", text: "FICTIONAL Which one?", options: [], chosen: [], custom: "FICTIONAL the second", skipped: false },
      { kind: "question", text: "FICTIONAL ok?", options: [], chosen: [], custom: null, skipped: true },
      { kind: "question", text: "FICTIONAL lost?", options: [], chosen: [], custom: null, skipped: true },
    ]);
  });

  it("an ask_user form is its report once, then one question per field: the tool call adds no entry", () => {
    const report = "FICTIONAL **Shipped** the fix.\n\n- one";
    const state = chat({ turns: [{
      id: "turn-1", startedAt: AT, state: "complete", usage: undefined, message: user("FICTIONAL go"),
      responseParts: [
        { kind: "toolCall", toolCall: {
          status: "completed", toolCallId: "a1", toolName: "ask_user", displayName: "ask_user", invocationMessage: "ask_user",
          toolInput: JSON.stringify({ message: report, requestedSchema: { properties: { color: {}, size: {} } } }), confirmed: "not-needed", success: true,
          pastTenseMessage: "Ask User", content: [{ type: "text", text: "User responded:\ncolor: Blue\nsize: FICTIONAL big" }],
        } },
        { kind: "inputRequest", response: "accept", request: {
          id: "req-1", message: report, questions: [QUESTION, SECOND],
          answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "blue" } }, "q-size": { state: "submitted", value: { kind: "text", value: "FICTIONAL big" } } },
        } },
      ],
    }] });
    const parts = turnsFrom(state)[1]!.parts;
    expect(parts.map((part) => part.kind === "question" ? part.text : part.kind)).toEqual(["FICTIONAL which color?", "FICTIONAL what size?"]);
    expect(parts.map((part) => part.kind === "question" ? part.report ?? null : null)).toEqual([report, null]);
  });

  it("an answered input request reads back as a question part, not as text", () => {
    const state = chat({ turns: [{
      id: "turn-1", startedAt: AT, state: "complete", usage: undefined, message: user("FICTIONAL ask"),
      responseParts: [{ kind: "inputRequest", response: "accept", request: {
        id: "req-1", questions: [QUESTION],
        answers: { "q-color": { state: "submitted", value: { kind: "selected", value: "blue", freeformValues: ["navy"] } } },
      } }],
    }] });
    expect(turnsFrom(state)[1]!.parts).toEqual([{ kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: ["Blue"], custom: "navy", skipped: false }]);
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
      host: { tool_call_id: "call-9", turn_id: "turn-2", option_ids: ["allow-once", "allow-always", "no"], approves: [true, true, false] },
    });
    const plain = promptFrom(pending())!;
    expect(plain.options.map((option) => option.label)).toEqual(["Approve", "Deny"]);
    expect(plain.host).toEqual({ tool_call_id: "call-9", turn_id: "turn-2", option_ids: ["", ""], approves: [true, false] });
    expect(promptFrom(chat({}))).toBeNull();
  });

  it("an input request is a question prompt, with VS Code's typed-answer slot last", () => {
    const one = promptFrom(asking({ id: "req-1", questions: [QUESTION] }))!;
    expect(one).toEqual({
      id: "req-1:q-color", agent: "copilot", kind: "question", title: "Color", question: "FICTIONAL which color?", body: null,
      options: [{ label: "Red", description: null }, { label: "Blue", description: "the calm one" }, { label: "Other…", description: null }],
      multi_select: false, custom_option_index: 2,
      host: { request_id: "req-1", question_id: "q-color", option_ids: ["red", "blue", ""] },
    });
    expect(one.steps).toBeUndefined();
    // an answered request asks nothing
    expect(promptFrom(chat({ status: 8, activeTurn: { id: "t", startedAt: AT, message: user("x"), usage: undefined, responseParts: [
      { kind: "inputRequest", response: "accept", request: { id: "req-1", questions: [QUESTION] } },
    ] } }))).toBeNull();
  });

  it("an option keeps the host's recommended flag, and a 'Title - Description' label is split as VS Code's carousel splits it", () => {
    const question = { ...QUESTION, options: [
      { id: "a", label: "Ship it - merge and deploy now", recommended: true },
      { id: "b", label: "Wait", description: "FICTIONAL hold - for review" },
      { id: "c", label: "Plain - dash", description: "kept whole when it has its own description" },
    ] };
    const prompt = promptFrom(asking({ id: "req-1", questions: [question] }))!;
    expect(prompt.options.slice(0, 3)).toEqual([
      { label: "Ship it", description: "merge and deploy now", recommended: true },
      { label: "Wait", description: "FICTIONAL hold - for review" },
      { label: "Plain - dash", description: "kept whole when it has its own description" },
    ]);
  });

  it("freeform_offered_unless_false", () => {
    // VS Code's rule (chatQuestionCarouselPart.ts): the typed answer shows unless the question says false
    const slot = (allowFreeformInput: boolean | undefined) => {
      const prompt = promptFrom(asking({ id: "req-1", questions: [{ ...QUESTION, ...(allowFreeformInput === undefined ? {} : { allowFreeformInput }) }] }))!;
      return { labels: prompt.options.map((option) => option.label), custom: prompt.custom_option_index, ids: (prompt.host as { option_ids: string[] }).option_ids };
    };
    expect(slot(undefined)).toEqual({ labels: ["Red", "Blue", "Other…"], custom: 2, ids: ["red", "blue", ""] });
    expect(slot(false)).toEqual({ labels: ["Red", "Blue"], custom: null, ids: ["red", "blue"] });
    expect(slot(true)).toEqual({ labels: ["Red", "Blue", "Other…"], custom: 2, ids: ["red", "blue", ""] });
    // a multi-select question takes one too
    const many = promptFrom(asking({ id: "req-1", questions: [{ ...QUESTION, kind: "multi-select" }] }))!;
    expect(many.options.map((option) => option.label)).toEqual(["Red", "Blue", "Other…"]);
  });

  it("a two-question form is read whole: each question with its own options, required flag and host ids", () => {
    const first = promptFrom(asking({ id: "req-2", questions: [QUESTION, { ...SECOND, required: false }] }))!;
    expect(first.id).toBe("req-2:form");
    expect(first.steps).toBeUndefined();
    expect(first.form).toEqual([
      { title: "Color", question: "FICTIONAL which color?", options: [{ label: "Red", description: null }, { label: "Blue", description: "the calm one" }, { label: "Other…", description: null }], multi_select: false, custom_option_index: 2, required: true },
      { title: "Size", question: SECOND.message, options: [{ label: "Answer", description: null }], multi_select: false, custom_option_index: 0, required: false },
    ]);
    expect(first.host).toEqual({ request_id: "req-2", question_id: "q-color", option_ids: ["red", "blue", ""], form: [{ question_id: "q-color", option_ids: ["red", "blue", ""] }, { question_id: "q-size", option_ids: [""] }] });
  });

  it("efforts come from the model's configSchema thinkingLevel", () => {
    const root = {
      agents: [
        { provider: "other", displayName: "Other", description: "", models: [{ id: "fictional/other", name: "Other", provider: "other" }] },
        { provider: "copilotcli", displayName: "Fictional Agent", description: "", models: [
          { id: "fictional/model-a", name: "Fictional Model A", provider: "copilotcli", configSchema: { type: "object", properties: {
            mode: { type: "string", title: "Mode", enum: ["x", "y"] },
            thinkingLevel: { type: "string", title: "Thinking Level", enum: ["low", "medium", "high"], default: "medium" },
          } } },
          { id: "fictional/model-b", name: "Fictional Model B", provider: "copilotcli", configSchema: { type: "object", properties: { budget: { type: "string", title: "Budget", enum: ["small", "large"] } } } },
          { id: "fictional/model-c", name: "Fictional Model C", provider: "copilotcli" },
        ] },
      ],
    } as unknown as RootState;
    expect(modelsFrom(root)).toEqual([
      { id: "fictional/model-a", name: "Fictional Model A", provider: "copilotcli", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"], default: "medium" }, context: null, group: "fictional", multiplier: null, warning: null },
      { id: "fictional/model-b", name: "Fictional Model B", provider: "copilotcli", efforts: { key: "budget", values: ["small", "large"] }, context: null, group: "fictional", multiplier: null, warning: null },
      { id: "fictional/model-c", name: "Fictional Model C", provider: "copilotcli", efforts: null, context: null, group: "fictional", multiplier: null, warning: null },
    ]);
  });

  it("models_carry_provider_and_context", () => {
    const root = {
      agents: [{ provider: "copilotcli", displayName: "Fictional Agent", description: "", models: [
        { id: "fictional/a", provider: "FICTIONAL Provider", name: "FICTIONAL A", maxContextWindow: 1000000 },
        { id: "fictional/b", provider: "FICTIONAL Provider", name: "FICTIONAL B" },
      ] }],
    } as unknown as RootState;
    const models = modelsFrom(root);
    expect(models).toContainEqual(expect.objectContaining({ id: "fictional/a", provider: "FICTIONAL Provider", context: 1000000 }));
    // a model without a context window says so: null, never 0 or undefined
    expect(models).toContainEqual({ id: "fictional/b", name: "FICTIONAL B", provider: "FICTIONAL Provider", efforts: null, context: null, group: "fictional", multiplier: null, warning: null });
  });

  it("models_are_grouped_copilot_router_other: Copilot's own by their _meta, a router's by its id prefix", () => {
    // the shapes VS Code 1.142's host sent on 2026-10-19, names made up
    const root = {
      agents: [{ provider: "copilotcli", displayName: "Fictional Agent", description: "", models: [
        { id: "auto", provider: "copilotcli", name: "Auto", _meta: { discountPercent: 10 } },
        { id: "fictional-big", provider: "copilotcli", name: "FICTIONAL Big", _meta: { multiplierNumeric: 27, category: "powerful" } },
        { id: "fictional-old", provider: "copilotcli", name: "FICTIONAL Old", _meta: { multiplierNumeric: 9, category: "versatile", rowWarning: "FICTIONAL Old has a planned deprecation date." } },
        { id: "fictional-fusion", provider: "copilotcli", name: "FICTIONAL Fusion", _meta: { category: "powerful" } },
        { id: "fictionalrouter/m-1", provider: "copilotcli", name: "FICTIONAL M1 (Vendor)", _meta: {} },
        { id: "bare-model", provider: "copilotcli", name: "FICTIONAL Bare" },
      ] }],
    } as unknown as RootState;
    expect(modelsFrom(root).map((model) => [model.id, model.group, model.multiplier, model.warning])).toEqual([
      ["auto", "copilot", null, null],
      ["fictional-big", "copilot", 27, null],
      ["fictional-old", "copilot", 9, "FICTIONAL Old has a planned deprecation date."],
      ["fictional-fusion", "copilot", null, null],
      ["fictionalrouter/m-1", "fictionalrouter", null, null],
      ["bare-model", "other", null, null],
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

  it("customizations_become_commands: skills, prompts and agents, enabled ones, named once", () => {
    const item = (type: string, name: string, extra: Record<string, unknown> = {}) => ({ id: name, type, name, uri: `file:///tmp/fictional/${type}/${name}.md`, description: `FICTIONAL ${name}`, ...extra });
    const session = {
      provider: "copilotcli", title: "", status: 1, lifecycle: "ready", activeClients: [], chats: [],
      customizations: [
        { id: "dir", type: "directory", name: "skills", uri: "file:///tmp/fictional/skills", children: [
          item("skill", "fictional-skill"),
          item("skill", "off-skill", { enabled: false }),
          item("skill", "scoped-off", { enablement: [{ kind: "workspace", enabled: false }] }),
          item("rule", "a-rule"), item("hook", "a-hook"), item("mcpServer", "a-server"),
        ] },
        item("prompt", "fictional-prompt"),
        item("agent", "Report"),
        { id: "plugin", type: "plugin", name: "Plugin", uri: "file:///tmp/fictional/plugin", children: [item("skill", "fictional-skill")] },
      ],
    } as unknown as SessionState;
    expect(commandsFrom(session)).toEqual([
      { name: "fictional-skill", description: "FICTIONAL fictional-skill", kind: "skill" },
      { name: "fictional-prompt", description: "FICTIONAL fictional-prompt", kind: "prompt" },
      { name: "Report", description: "FICTIONAL Report", kind: "agent" },
    ]);
    expect(commandsFrom(undefined)).toEqual([]);
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
      { session: "copilotcli:/2", title: "FICTIONAL_2", status: "working", modified_at: "2026-01-01T00:00:03.000Z", cwd: null, unread: false, archived: false },
      { session: "copilotcli:/4", title: "FICTIONAL_4", status: "error", modified_at: "2026-01-01T00:00:02.000Z", cwd: null, unread: true, archived: false },
      { session: "copilotcli:/1", title: "FICTIONAL_1", status: "asks", modified_at: "2026-01-01T00:00:01.000Z", cwd: "/tmp/fictional-repo", unread: true, archived: false },
      { session: "copilotcli:/5", title: "FICTIONAL_5", status: "idle", modified_at: "2026-01-01T00:00:00.000Z", cwd: null, unread: false, archived: false },
    ]);
  });

  it("rowsFrom_names_a_worktree_folders_repo: the host's project, when it is a local folder other than the chat's own", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const summary = (n: number, cwd: string, project?: string): SessionSummary => ({
      resource: `copilotcli:/${n}`, provider: "copilotcli", title: `FICTIONAL_${n}`, status: 1, createdAt: AT, modifiedAt: at,
      workingDirectories: [cwd], ...(project ? { project: { uri: project, displayName: "fictional" } } : {}),
    } as SessionSummary);
    const rows = rowsFrom([
      summary(1, "file:///tmp/fictional.wt/feat", "file:///tmp/fictional"),
      summary(2, "file:///tmp/fictional", "file:///tmp/fictional"),
      summary(3, "file:///tmp/fictional.wt/remote", "https://github.com/fictional/fictional"),
      summary(4, "file:///tmp/plain"),
    ]);
    expect(rows.map((row) => [row.session, row.repo])).toEqual([
      ["copilotcli:/1", "/tmp/fictional"],
      ["copilotcli:/2", undefined],
      ["copilotcli:/3", undefined],
      ["copilotcli:/4", undefined],
    ]);
  });

  it("rowsFrom_gives_a_forked_session_its_own_chat_status_not_the_roll_up", () => {
    // live on a PC (2026-10-20): the fork asks (24), its source chat failed (2); AHP's session
    // status promotes the fork's InputNeeded (24 | IsRead 32 = 56), so the source row said asks
    const forked = {
      resource: "copilotcli:/1", provider: "copilotcli", title: "FICTIONAL_source", status: 24 | 32, createdAt: AT, modifiedAt: "2026-01-01T00:00:01.000Z",
      defaultChat: "ahp-chat://main/1",
      chats: [
        { resource: "ahp-chat://fork/1", title: "FICTIONAL_fork", origin: { kind: "fork" }, status: 24 },
        { resource: "ahp-chat://main/1", title: "FICTIONAL_source", origin: { kind: "user" }, status: 2 | 32 },
      ],
    } as unknown as SessionSummary;
    expect(rowsFrom([forked]).map(({ session, status, unread }) => ({ session, status, unread }))).toEqual([
      { session: "copilotcli:/1", status: "error", unread: false },
      { session: "ahp-chat://fork/1", status: "asks", unread: true },
    ]);
    // a default chat the host gave no status keeps the session's
    const bare = { ...forked, chats: [{ resource: "ahp-chat://main/1", title: "FICTIONAL_source" }] } as unknown as SessionSummary;
    expect(rowsFrom([bare])[0]?.status).toBe("asks");
  });

  it("rowsFrom_reads_read_and_archived_flags", () => {
    // SessionStatus: IsRead = 32 and IsArchived = 64 sit beside the activity bits
    const row = (n: number, status: number): SessionSummary => ({ resource: `copilotcli:/${n}`, provider: "copilotcli", title: `FICTIONAL_${n}`, status, createdAt: AT, modifiedAt: `2026-01-01T00:00:0${n}.000Z` } as SessionSummary);
    const flags = rowsFrom([row(1, 1), row(2, 1 | 32), row(3, 1 | 64), row(4, 1 | 32 | 64), row(5, 24 | 32)])
      .map(({ session, status, unread, archived }) => ({ session, status, unread, archived }));
    expect(flags).toEqual([
      { session: "copilotcli:/5", status: "asks", unread: false, archived: false },
      { session: "copilotcli:/4", status: "idle", unread: false, archived: true },
      { session: "copilotcli:/3", status: "idle", unread: true, archived: true },
      { session: "copilotcli:/2", status: "idle", unread: false, archived: false },
      { session: "copilotcli:/1", status: "idle", unread: true, archived: false },
    ]);
  });

  it("a read takes the model and agent from the newest turn, else the draft's model", () => {
    const turn = { id: "turn-1", startedAt: AT, state: "complete", usage: undefined, responseParts: [], message: {
      ...user("FICTIONAL hi"), model: { id: "fictional/model-a", config: { thinkingLevel: "high" } }, agent: { uri: "file:///tmp/fictional/agents/Report.agent.md" },
    } };
    const read = readFrom("copilotcli:/1", "FICTIONAL_title", chat({ turns: [turn], turnsNextCursor: "c1" }));
    expect(read).toMatchObject({ session: "copilotcli:/1", title: "FICTIONAL_title", status: "idle", cursor: "c1", prompt: null,
      model: { id: "fictional/model-a", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md", busy: false });
    expect(read.signature).toMatch(/^[0-9a-f]{16}$/);
    expect(readFrom("s", "t", chat({ draft: { ...user(""), model: { id: "fictional/model-a" } } })).model).toEqual({ id: "fictional/model-a", effort: null });
  });
});

describe("what a host chat waits on, and its context", () => {
  const sessionWith = (meta: Record<string, unknown> | undefined) => ({ _meta: meta }) as unknown as SessionState;
  const ctx = (session: SessionState | undefined) => ({ chat: () => undefined, modelName: (id: string) => id, session: () => session });

  it("background work counts subagents and commands; a read with none says zeros", () => {
    const work = [
      { kind: "subagent", id: "w1", label: "explore", startedAt: AT, chat: "copilotcli:/sub" },
      { kind: "shell", id: "w2", label: "FICTIONAL dev server", startedAt: AT, command: "npm run dev" },
      { kind: "shell", id: "w3", label: "FICTIONAL watch", startedAt: AT, command: "tsc -w" },
    ];
    expect(readFrom("s", "t", chat({ backgroundWork: work })).background).toEqual({ subagents: 1, commands: 2 });
    expect(readFrom("s", "t", chat({})).background).toEqual({ subagents: 0, commands: 0 });
    expect(readFrom("s", "t", chat({ backgroundWork: work })).signature).not.toBe(readFrom("s", "t", chat({})).signature);
  });

  it("confirmations count the running turn's calls waiting for a yes or no", () => {
    const waiting = (id: string) => ({ kind: "toolCall", toolCall: { toolCallId: id, toolName: "bash", displayName: "Run", status: "pending-confirmation", invocationMessage: "FICTIONAL" } });
    const active = { id: "turn-1", startedAt: AT, message: user("FICTIONAL go"), responseParts: [waiting("c1"), waiting("c2")] };
    expect(readFrom("s", "t", chat({ activeTurn: active })).confirmations).toBe(2);
    expect(readFrom("s", "t", chat({})).confirmations).toBe(0);
  });

  it("read_maps_copilot_usage_info as VS Code reads it: integers, a limit above 0, else none", () => {
    const usage = { currentTokens: 84000, tokenLimit: 200000, messagesLength: 12, conversationTokens: 60000, systemTokens: 9000, toolDefinitionsTokens: 15000 };
    expect(readFrom("s", "t", chat({}), ctx(sessionWith({ "copilot.usageInfo": usage }))).context)
      .toEqual({ currentTokens: 84000, tokenLimit: 200000, conversationTokens: 60000, systemTokens: 9000, toolDefinitionsTokens: 15000 });
    for (const bad of [{ ...usage, tokenLimit: 0 }, { ...usage, currentTokens: 1.5 }, { ...usage, currentTokens: -1 }, { ...usage, messagesLength: undefined }, {}, "x"]) {
      expect({ bad, context: readFrom("s", "t", chat({}), ctx(sessionWith({ "copilot.usageInfo": bad }))).context }).toEqual({ bad, context: null });
    }
    expect(readFrom("s", "t", chat({})).context).toBeNull();
    // a bad optional count is left out, the rest stays
    expect(readFrom("s", "t", chat({}), ctx(sessionWith({ "copilot.usageInfo": { ...usage, systemTokens: -3 } }))).context).toEqual({ currentTokens: 84000, tokenLimit: 200000, conversationTokens: 60000, toolDefinitionsTokens: 15000 });
  });

  it("the newest turn's contextAttribution wins over the session's usage info, as VS Code's readAgentContextUsage", () => {
    const attribution = { totalTokens: 211895, limit: 967232, promptTokenLimit: 967232, categories: { systemPrompt: 20613, customInstructions: 0, systemTools: 17914, mcpTools: 18528, messages: 154840, freeSpace: 706976 } };
    const turn = (meta: Record<string, unknown>) => ({ id: "turn-1", startedAt: AT, state: "complete", responseParts: [], message: user("FICTIONAL hi"), usage: { inputTokens: 1, outputTokens: 1, _meta: meta } });
    const session = ctx(sessionWith({ "copilot.usageInfo": { currentTokens: 5, tokenLimit: 10, messagesLength: 1 } }));
    expect(readFrom("s", "t", chat({ turns: [turn({ contextAttribution: attribution })] }), session).context)
      .toEqual({ currentTokens: 211895, tokenLimit: 967232, conversationTokens: 154840, systemTokens: 20613, toolDefinitionsTokens: 36442 });
    // none on the turn: the session's
    expect(readFrom("s", "t", chat({ turns: [turn({})] }), session).context).toEqual({ currentTokens: 5, tokenLimit: 10 });
    // a broken one is none, never a guess
    expect(readFrom("s", "t", chat({ turns: [turn({ contextAttribution: { totalTokens: 3, limit: 0 } })] })).context).toBeNull();
  });

  it("with the model's window known, a turn's context is its input and output over that window, as VS Code's meter counts it", () => {
    // a live 'Migrating' turn: attribution said 508993 of 400000 (127%) while VS Code showed ~36%
    const attribution = { totalTokens: 508993, limit: 400000, promptTokenLimit: 400000, categories: { systemPrompt: 25027, systemTools: 20000, mcpTools: 23730, messages: 440236 } };
    const turn = { id: "turn-1", startedAt: AT, state: "complete", responseParts: [], message: { ...user("FICTIONAL hi"), model: { id: "fictional-opus" } }, usage: { inputTokens: 190674, outputTokens: 1616, _meta: { contextAttribution: attribution } } };
    const windows = { ...ctx(undefined), modelWindow: (id: string) => (id === "fictional-opus" ? 528000 : null) };
    const read = readFrom("s", "t", chat({ turns: [turn] }), windows).context!;
    expect({ currentTokens: read.currentTokens, tokenLimit: read.tokenLimit }).toEqual({ currentTokens: 192290, tokenLimit: 528000 });
    // the breakdown keeps the host's shares of what was used
    expect(read.conversationTokens! + read.systemTokens! + read.toolDefinitionsTokens!).toBeLessThanOrEqual(192290);
    expect(Math.round((read.conversationTokens! / 192290) * 100)).toBe(Math.round((440236 / 508993) * 100));
    // a model with no window of its own (auto, unknown): the host's attribution, as before
    const unknown = { ...turn, message: { ...turn.message, model: { id: "auto" } } };
    expect(readFrom("s", "t", chat({ turns: [unknown] }), windows).context).toMatchObject({ currentTokens: 508993, tokenLimit: 400000 });
  });
});

// ─── The whole turn, built through the package's reducers ────────────────────

const LATER = "2026-01-01T00:00:05.000Z";
const started = (turnId = "turn-1", startedAt = AT) => ({ type: "chat/turnStarted", turnId, startedAt, message: user("FICTIONAL do it") }) as StateAction;
const finished = (turnId = "turn-1", duration = 5000) => ({ type: "chat/turnComplete", turnId, duration }) as StateAction;
const assistant = (state: ChatState) => turnsFrom(state)[1]!.parts;
const call = (toolCallId: string, toolName = "bash", displayName = "Run in terminal") => ({ toolCallId, toolName, displayName, invocationMessage: `FICTIONAL running ${toolCallId}`, toolInput: "FICTIONAL input" });
const done = (content: unknown[], success = true, past = "FICTIONAL ran it") => ({ success, pastTenseMessage: past, content }) as ToolCallResult;
const tool = (parts: ConversationPart[]) => parts.find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool")!;
/** 1 for a call VS Code keeps out of a tool group while it waits for a confirmation. */
const pendingCount = (part: Extract<ConversationPart, { kind: "tool" }>) => (part.state === "awaiting" ? 1 : 0);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x46, 0x49, 0x43, 0x54]).toString("base64");

describe("host chat turns, whole", () => {
  it("tool_uses_past_tense_when_done", () => {
    const state = reducedChat([started(), ...toolCallActions("turn-1", call("c1"), done([{ type: "text", text: "a.txt" }])), finished()]);
    const part = tool(assistant(state));
    expect(part.past).toBe("FICTIONAL ran it");
    expect(part.summary).toBe("FICTIONAL running c1");
    expect(part.tool_id).toBe("bash");
    // a running call has no past yet
    const running = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", call("c1"))])));
    expect(running.past).toBeUndefined();
  });

  it("terminal_result_gives_command_and_exit_code", () => {
    // the title is the host's label for the terminal ("Run Shell Command"), never the command line:
    // VS Code's getTerminalInput reads the input's `command`, else the whole input
    const terminal = { type: "terminal", resource: "ahp-terminal://fictional/1", title: "Run Shell Command", result: { exitCode: 1, preview: "FICTIONAL 1 failed" } };
    const json = { ...call("c1"), toolInput: JSON.stringify({ command: "npm test", description: "FICTIONAL tests" }) };
    const part = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", json, done([terminal])), finished()])));
    expect(part.command).toBe("npm test");
    const raw = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", { ...call("c1"), toolInput: "ls -la" }, done([terminal])), finished()])));
    expect(raw.command).toBe("ls -la");
    expect(part.exit_code).toBe(1);
    expect(part.error).toBe(true);
    // a terminal call with no text block reads its terminal's output preview
    expect(part.output).toBe("FICTIONAL 1 failed");
    // exit 0 is no error
    const ok = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", call("c1"), done([{ ...terminal, result: { exitCode: 0 } }])), finished()])));
    expect({ exit_code: ok.exit_code, error: ok.error }).toEqual({ exit_code: 0, error: false });
  });

  it("embedded_image_becomes_image_ref", () => {
    const content = [{ type: "text", text: "FICTIONAL shot" }, { type: "embeddedResource", data: "AAAA", contentType: "application/pdf" }, { type: "embeddedResource", data: PNG, contentType: "image/png" }];
    const state = reducedChat([started(), ...toolCallActions("turn-1", call("c7", "screenshot", "Screenshot"), done(content)), finished()]);
    const part = tool(assistant(state));
    expect(part.images).toEqual([{ media_type: "image/png", ref: "c7:0" }]);
    expect(part.output).toBe("FICTIONAL shot");
    expect(JSON.stringify(turnsFrom(state))).not.toContain(PNG);
    expect(JSON.stringify(turnsFrom(state))).not.toContain("AAAA");
    expect(imageOf(state, "c7:0")).toEqual({ media_type: "image/png", bytes: Buffer.from(PNG, "base64") });
    expect(imageOf(state, "c7:1")).toBeNull();
    expect(imageOf(state, "nope:0")).toBeNull();
  });

  it("user_attachment_images_show_in_the_user_turn: by ref, never their bytes; a file shows nothing", () => {
    const message = { ...user("FICTIONAL look"), attachments: [
      { type: "embeddedResource", label: "shot.png", displayKind: "image", data: PNG, contentType: "image/png" },
      { type: "resource", label: "notes.txt", displayKind: "document", uri: "file:///fictional/notes.txt" },
      { type: "embeddedResource", label: "doc.pdf", data: "AAAA", contentType: "application/pdf" },
    ] };
    const state = reducedChat([{ type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message } as StateAction, finished()]);
    expect(turnsFrom(state)[0]!.parts).toEqual([{ kind: "text", text: "FICTIONAL look" }, { kind: "image", media_type: "image/png", ref: "turn:turn-1:0" }]);
    expect(JSON.stringify(turnsFrom(state))).not.toContain(PNG);
    expect(imageOf(state, "turn:turn-1:0")).toEqual({ media_type: "image/png", bytes: Buffer.from(PNG, "base64") });
    for (const ref of ["turn:turn-1:1", "turn:turn-9:0", "turn:turn-1:00", "turn:turn-1"]) expect({ ref, image: imageOf(state, ref) }).toEqual({ ref, image: null });
  });

  it("file_edit_gives_edit_counts", () => {
    const side = (path: string) => ({ uri: `file://${path}`, content: { uri: `ahp-content://fictional${path}` } });
    const edits = [
      { type: "fileEdit", before: side("/tmp/fictional-repo/a.ts"), after: side("/tmp/fictional-repo/a.ts"), diff: { added: 3, removed: 1 } },
      { type: "fileEdit", after: side("/tmp/fictional-repo/new.ts"), diff: { added: 9 } },
      { type: "fileEdit", before: side("/tmp/fictional-repo/gone.ts") },
    ];
    const part = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", call("c1", "edit", "Edit file"), done(edits)), finished()])));
    expect(part.edits).toEqual([
      { path: "/tmp/fictional-repo/a.ts", added: 3, removed: 1 },
      { path: "/tmp/fictional-repo/new.ts", added: 9, removed: 0 },
      { path: "/tmp/fictional-repo/gone.ts", added: 0, removed: 0 },
    ]);
  });

  it("subagent_result_becomes_subagent_part", () => {
    const subagent = { type: "subagent", resource: "ahp-chat://default/fictional-sub", title: "Explore", agentName: "explore", description: "FICTIONAL find the config" };
    const running = reducedChat([started(), ...toolCallActions("turn-1", call("c3", "task", "Task")),
      { type: "chat/toolCallContentChanged", turnId: "turn-1", toolCallId: "c3", content: [subagent] } as StateAction]);
    expect(assistant(running)).toEqual([{
      kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: null,
      started: AT, ended: null, status: "running", chat: "ahp-chat://default/fictional-sub",
    }]);
    const ended = reducedChat([...toolCallActions("turn-1", call("c3", "task", "Task"), done([subagent])).slice(2), finished()], running);
    expect(assistant(ended)).toEqual([{
      kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: null,
      started: AT, ended: LATER, status: "done", chat: "ahp-chat://default/fictional-sub",
    }]);
    const failed = reducedChat([...toolCallActions("turn-1", call("c3", "task", "Task"), done([subagent], false)).slice(2), finished()], running);
    expect((assistant(failed)[0] as { status: string }).status).toBe("failed");
  });

  it("tool_carries_intention_and_outcome", () => {
    // the intention a terminal call gives, before its command (chatTerminalToolProgressPart.ts)
    const withIntention = reducedChat([started(), { type: "chat/toolCallStart", turnId: "turn-1", toolCallId: "c1", toolName: "bash", displayName: "Run in terminal", intention: "FICTIONAL check the build" } as StateAction,
      ...toolCallActions("turn-1", call("c1"), done([])).slice(1), finished()]);
    const part = tool(assistant(withIntention));
    expect(part.intention).toBe("FICTIONAL check the build");
    expect(part.state).toBeUndefined();
    // a completed call has no state; one cancelled says why, as VS Code's summary counts it
    const cancelled = (reason: string) => tool(assistant(reducedChat([started(),
      { type: "chat/toolCallStart", turnId: "turn-1", toolCallId: "c2", toolName: "bash", displayName: "Run in terminal" } as StateAction,
      { type: "chat/toolCallReady", turnId: "turn-1", toolCallId: "c2", invocationMessage: "FICTIONAL run", toolInput: "x" } as StateAction,
      { type: "chat/toolCallConfirmed", turnId: "turn-1", toolCallId: "c2", approved: false, reason } as StateAction, finished()])));
    expect({ state: cancelled("skipped").state, error: cancelled("skipped").error }).toEqual({ state: "skipped", error: false });
    expect(cancelled("denied").state).toBe("denied");
    expect(cancelled("result-denied").state).toBe("denied");
    // still running, or waiting for a yes or no
    const running = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", call("c3"))])));
    expect(running.state).toBe("running");
    const awaiting = tool(assistant(reducedChat([started(),
      { type: "chat/toolCallStart", turnId: "turn-1", toolCallId: "c4", toolName: "bash", displayName: "Run in terminal" } as StateAction,
      { type: "chat/toolCallReady", turnId: "turn-1", toolCallId: "c4", invocationMessage: "FICTIONAL run", toolInput: "x" } as StateAction])));
    expect(awaiting.state).toBe("awaiting");
    expect(pendingCount(awaiting)).toBe(1);
  });

  it("subagent_model_only_when_different", () => {
    const subagent = { type: "subagent", resource: "ahp-chat://default/fictional-sub", title: "Explore", agentName: "explore", description: "FICTIONAL find the config" };
    const parent = (model: string) => reducedChat([
      { type: "chat/turnStarted", turnId: "turn-1", startedAt: AT, message: { ...user("FICTIONAL do it"), model: { id: model } } } as StateAction,
      ...toolCallActions("turn-1", call("c3", "task", "Task"), done([subagent])), finished()]);
    const sub = (model: string, startedAt = "2026-01-01T00:00:01.000Z", duration = 343_000) => reducedChat([
      { type: "chat/turnStarted", turnId: "s-1", startedAt, message: { ...user("FICTIONAL find it"), model: { id: model } } } as StateAction,
      { type: "chat/turnComplete", turnId: "s-1", duration } as StateAction,
    ]);
    const names = (id: string) => id === "fictional/model-b" ? "FICTIONAL Model B" : id;
    const read = (parentModel: string, subModel: string | null) => {
      const chats = (uri: string) => uri === subagent.resource && subModel !== null ? sub(subModel) : undefined;
      return turnsFrom(parent(parentModel), { chat: chats, modelName: names })[1]!.parts[0] as Extract<ConversationPart, { kind: "subagent" }>;
    };
    // a model the chat itself uses is not said again; another one is, by its name
    expect(read("fictional/model-a", "fictional/model-a").model).toBeNull();
    expect(read("fictional/model-a", "fictional/model-b").model).toBe("FICTIONAL Model B");
    // under Auto, the concrete model always shows; an Auto subagent never does
    expect(read("auto", "fictional/model-a").model).toBe("fictional/model-a");
    expect(read("fictional/model-a", "auto").model).toBeNull();
    // not read yet: unknown
    expect(read("fictional/model-a", null).model).toBeNull();
    // and its own chat's times, not the turn's (VS Code's getSubagentTiming)
    const timed = read("fictional/model-a", "fictional/model-b");
    expect({ started: timed.started, ended: timed.ended }).toEqual({ started: "2026-01-01T00:00:01.000Z", ended: "2026-01-01T00:05:44.000Z" });
  });

  const QUESTIONS = [
    { ...QUESTION, allowFreeformInput: true },
    { id: "q-tags", kind: "multi-select", title: "Tags", message: "FICTIONAL which tags?", required: true, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
    { id: "q-ok", kind: "boolean", title: "Ok", message: "FICTIONAL go on?", required: true },
    SECOND,
  ];
  const answered = (answers: Record<string, unknown>) => reducedChat([
    started(),
    { type: "chat/inputRequested", request: { id: "req-1", questions: QUESTIONS } } as StateAction,
    { type: "chat/inputCompleted", requestId: "req-1", response: "accept", answers } as StateAction,
    finished(),
  ]);

  it("answered_question_becomes_question_part", () => {
    const parts = assistant(answered({
      "q-color": { state: "submitted", value: { kind: "selected", value: "blue", freeformValues: ["navy"] } },
      "q-tags": { state: "submitted", value: { kind: "selected-many", value: ["a", "b"] } },
      "q-ok": { state: "submitted", value: { kind: "boolean", value: false } },
      "q-size": { state: "submitted", value: { kind: "text", value: "FICTIONAL large" } },
    }));
    expect(parts).toEqual([
      { kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: ["Blue"], custom: "navy", skipped: false },
      { kind: "question", text: "FICTIONAL which tags?", options: ["Alpha", "Beta"], chosen: ["Alpha", "Beta"], custom: null, skipped: false, multi: true },
      { kind: "question", text: "FICTIONAL go on?", options: ["Yes", "No"], chosen: ["No"], custom: null, skipped: false },
      { kind: "question", text: "FICTIONAL what size?", options: [], chosen: [], custom: "FICTIONAL large", skipped: false },
    ]);
    // the old "question → answer" text is gone
    expect(JSON.stringify(parts)).not.toContain("→");
    // a freeform answer with no option picked
    const free = assistant(answered({ "q-color": { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["FICTIONAL teal"] } } }))[0];
    expect(free).toEqual({ kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: [], custom: "FICTIONAL teal", skipped: false });
  });

  it("skipped_question_is_marked", () => {
    const parts = assistant(answered({ "q-color": { state: "skipped" } }));
    expect(parts[0]).toEqual({ kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: [], custom: null, skipped: true });
    // a declined request answered nothing: every question reads skipped
    const declined = assistant(reducedChat([started(),
      { type: "chat/inputRequested", request: { id: "req-1", questions: [QUESTION] } } as StateAction,
      { type: "chat/inputCompleted", requestId: "req-1", response: "decline" } as StateAction, finished()]));
    expect(declined).toEqual([{ kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: [], custom: null, skipped: true }]);
    // an open request is no history part: the prompt card asks it
    const open = reducedChat([started(), { type: "chat/inputRequested", request: { id: "req-1", questions: [QUESTION] } } as StateAction]);
    expect(assistant(open)).toEqual([]);
    expect(promptFrom(open)?.id).toBe("req-1:q-color");
  });

  it("system_notification_becomes_notice", () => {
    const parts = assistant(reducedChat([started(),
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "systemNotification", content: { markdown: "FICTIONAL subagent **explore** completed" } } } as StateAction,
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "systemNotification", content: "FICTIONAL task cancelled" } } as StateAction,
      finished()]));
    expect(parts).toEqual([
      { kind: "notice", text: "FICTIONAL subagent **explore** completed", source: "system" },
      { kind: "notice", text: "FICTIONAL task cancelled", source: "system" },
    ]);
  });

  it("error_becomes_error_notice_not_answer", () => {
    const state = reducedChat([started(),
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "markdown", id: "m1", content: "FICTIONAL working on it" } } as StateAction,
      { type: "chat/error", turnId: "turn-1", duration: 5000, part: { kind: "error", error: { errorType: "x", message: "FICTIONAL rate limited" } } } as StateAction]);
    const parts = assistant(state);
    expect(parts).toEqual([{ kind: "text", text: "FICTIONAL working on it" }, { kind: "notice", text: "FICTIONAL rate limited", source: "error" }]);
    expect(parts.some((part) => part.kind === "text" && part.phase === "final_answer")).toBe(false);
  });

  it("an error a turn got past is not shown: VS Code shows only the one the turn ended on", () => {
    // as the host records it: the error part stays in the turn, which went on and completed
    const state = chat({ turns: [{ id: "turn-1", startedAt: AT, duration: 10, state: "complete", usage: undefined, message: user("FICTIONAL do it"), responseParts: [
      { kind: "error", error: { errorType: "query", message: "FICTIONAL retried 5 times" } },
      { kind: "markdown", id: "m1", content: "FICTIONAL done anyway" },
    ] }] });
    expect(assistant(state)).toEqual([{ kind: "text", text: "FICTIONAL done anyway" }]);
  });

  it("the last turn's resumable error offers a retry; an older one does not", () => {
    const failed = (turnId: string) => ({ type: "chat/error", turnId, duration: 5000, part: { kind: "error", resumable: true, error: { errorType: "query", message: "FICTIONAL 502" } } }) as StateAction;
    const once = reducedChat([started(), failed("turn-1")]);
    expect(assistant(once)).toEqual([{ kind: "notice", text: "FICTIONAL 502", source: "error", resumable: true }]);
    const twice = reducedChat([started(), failed("turn-1"), started("turn-2"), failed("turn-2")]);
    expect(turnsFrom(twice)[1]!.parts).toEqual([{ kind: "notice", text: "FICTIONAL 502", source: "error" }]);
    expect(turnsFrom(twice)[3]!.parts).toEqual([{ kind: "notice", text: "FICTIONAL 502", source: "error", resumable: true }]);
  });

  it("content_ref_becomes_link_text", () => {
    const parts = assistant(reducedChat([started(),
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "contentRef", uri: "file:///tmp/fictional-repo/plan.md", contentType: "text/markdown" } } as StateAction,
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "contentRef", uri: "https://example.com/fictional/doc" } } as StateAction,
      finished()]));
    expect(parts).toEqual([
      { kind: "text", text: "[plan.md](file:///tmp/fictional-repo/plan.md)" },
      { kind: "text", text: "[doc](https://example.com/fictional/doc)" },
    ]);
    // a space or a `)` in the uri stays inside the link's destination: the app's markdown reads one file pill
    const odd = assistant(reducedChat([started(),
      { type: "chat/responsePart", turnId: "turn-1", part: { kind: "contentRef", uri: "file:///tmp/fictional repo/notes (draft).md" } } as StateAction,
      finished()]));
    expect(odd).toEqual([{ kind: "text", text: "[notes (draft).md](file:///tmp/fictional%20repo/notes%20%28draft%29.md)" }]);
    const text = (odd[0] as { text: string }).text;
    expect(parseInline(text)).toEqual([{ type: "file", path: "/tmp/fictional repo/notes (draft).md", children: [{ type: "text", value: "notes (draft).md" }] }]);
  });

  it("a long tool output is cut at the pane readers' length, with its call's id as output_ref", () => {
    const long = "x".repeat(TOOL_OUTPUT_CHARS * 2);
    const state = reducedChat([started(), ...toolCallActions("turn-1", call("c9"), done([{ type: "text", text: long }])), finished()]);
    const part = tool(assistant(state));
    expect(part.output_ref).toBe("c9");
    expect(part.output_size).toBe(long.length);
    expect(part.output.startsWith("x".repeat(TOOL_OUTPUT_CHARS))).toBe(true);
    expect(part.output.length).toBeLessThan(long.length);
    expect(toolOutputOf(state, "c9")).toBe(long);
    expect(toolOutputOf(state, "nope")).toBeNull();
    const short = tool(assistant(reducedChat([started(), ...toolCallActions("turn-1", call("c9"), done([{ type: "text", text: "short" }])), finished()])));
    expect(short.output_ref).toBeUndefined();
  });
});
