import { describe, expect, it } from "bun:test";

import type { ConversationPart } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { neverFolded, toolGroupSummary, toolKind, turnStyle } from "./toolGroupSummary.ts";
import { toolIcon } from "./toolIcons.ts";
import { BookOpen, CircleSlash, CircleX, Pencil, Plug, Search, SquareTerminal, Wrench } from "lucide-react";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tool = (tool_id: string, input: unknown = {}, extra: Partial<Tool> = {}): Tool =>
  ({ kind: "tool", name: tool_id, tool_id, summary: "", input: typeof input === "string" ? input : JSON.stringify(input), output: "", ...extra });
const pane = (name: string, input: unknown = {}): Tool => ({ kind: "tool", name, summary: "", input: JSON.stringify(input), output: "" });
const title = (parts: ConversationPart[]) => toolGroupSummary(parts, en).title;

describe("toolGroupSummary", () => {
  it("sums a group up in VS Code's order, the first fragment capitalised and the rest lowercase", () => {
    expect(title([
      tool("edit", { path: "a/x.ts" }),
      tool("run_in_terminal", { command: "make" }),
      tool("run_in_terminal", { command: "make test" }),
      tool("read_file", { filePath: "b/y.md" }),
    ])).toBe("Edited x.ts, ran 2 commands, read y.md");
  });

  it("counts the files read, a file read twice once", () => {
    expect(title([tool("read_file", { filePath: "a.md" }), tool("read_file", { filePath: "b.md" }), tool("read_file", { filePath: "c.md" })])).toBe("Read 3 files");
    expect(title([tool("read_file", { filePath: "b/y.md" }), tool("read_file", { filePath: "b/y.md" })])).toBe("Read y.md");
  });

  it("shows at most three fragments, the rest as other steps", () => {
    expect(title([
      tool("edit", { path: "a/x.ts" }),
      tool("bash", { command: "ls" }),
      tool("read_file", { filePath: "b/y.md" }),
      tool("grep", { pattern: "FICTIONAL" }),
      tool("list_dir", { path: "/tmp/fictional" }),
    ])).toBe("Edited x.ts, ran 1 command, read y.md, 2 other steps");
  });

  it("says how many calls failed, apart from what the others did", () => {
    expect(title([tool("bash", { command: "a" }), tool("bash", { command: "b" }), tool("read_file", { filePath: "c.md" }, { error: true })]))
      .toBe("Ran 2 commands, 1 tool call failed");
    expect(title([tool("bash", { command: "a" }, { error: true }), tool("bash", { command: "b" }, { error: true })])).toBe("2 tool calls failed");
  });

  it("names an outcome that overflowed in the other steps", () => {
    expect(title([
      tool("edit", { path: "a/x.ts" }), tool("bash", { command: "ls" }), tool("read_file", { filePath: "y.md" }), tool("grep", { pattern: "q" }),
      tool("bash", { command: "boom" }, { error: true }),
    ])).toBe("Edited x.ts, ran 1 command, read y.md, 2 other steps (1 failed)");
  });

  it("reads the searches, listings and problem checks", () => {
    expect(title([tool("grep", { pattern: "a" }), tool("rg", { query: "b" }), tool("grep", { pattern: "a" })])).toBe("Searched for 2 phrases");
    expect(title([tool("glob", { pattern: "**/*.ts" })])).toBe("Searched for 1 file pattern");
    expect(title([tool("list_dir", { path: "/a" }), tool("list_dir", { path: "/b" })])).toBe("Listed 2 directories");
    expect(title([tool("get_errors", { filePaths: ["/r/src/a.ts"] })])).toBe("Checked a.ts for problems");
    expect(title([tool("get_errors", { filePaths: ["/r/a.ts", "/r/b.ts"] })])).toBe("Checked 2 paths for problems");
  });

  it("finishes with its steps when nothing in it is known", () => {
    expect(title([tool("fictional_a"), tool("fictional_b"), tool("fictional_c")])).toBe("Finished with 3 steps");
    expect(title([tool("fictional_a")])).toBe("Finished with 1 step");
    expect(title([{ kind: "thinking", text: "hm" }])).toBe("Finished Working");
  });

  it("adds up the lines the edits added and removed", () => {
    const sum = toolGroupSummary([
      tool("edit", {}, { edits: [{ path: "/r/a.ts", added: 20, removed: 3 }] }),
      tool("create_file", {}, { edits: [{ path: "/r/b.ts", added: 8, removed: 0 }] }),
    ], en);
    expect(sum).toEqual({ title: "Edited 2 files", added: 28, removed: 3 });
  });

  it("reads a host chat's terminal call by its command", () => {
    expect(title([tool("bash", "ls /tmp", { command: "ls /tmp" })])).toBe("Ran 1 command");
  });

  it("leaves the plan and skills out, as the classic header does", () => {
    expect(title([tool("bash", { command: "ls" }), pane("TodoWrite", { todos: [] })])).toBe("Ran 1 command");
  });

  it("sums a Copilot pane's work by the app's own tool names", () => {
    expect(title([pane("view", { path: "/r/src/a.ts" }), pane("run_in_terminal", { command: "ls" })])).toBe("Ran 1 command, read a.ts");
  });
});

describe("toolKind", () => {
  it("classifies by the tool's id, VS Code's table first", () => {
    expect(toolKind(tool("read_file"))).toBe("read");
    expect(toolKind(tool("copilot_findTextInFiles"))).toBe("search_text");
    expect(toolKind(tool("file_search"))).toBe("search_files");
    expect(toolKind(tool("powershell"))).toBe("command");
    expect(toolKind(tool("copilot_listDirectory"))).toBe("list");
    expect(toolKind(tool("get_errors"))).toBe("problems");
    expect(toolKind(tool("replace_string_in_file"))).toBe("edit");
    expect(toolKind(tool("mcp__files__read_all"))).toBe("mcp");
    expect(toolKind(tool("fictional_tool"))).toBe("other");
    // the id, not the display name
    expect(toolKind({ ...tool("bash"), name: "Run in terminal" })).toBe("command");
  });

  it("classifies pane tool names through the app's verb table", () => {
    expect(toolKind(pane("Bash"))).toBe("command");
    expect(toolKind(pane("Read"))).toBe("read");
    expect(toolKind(pane("Edit"))).toBe("edit");
    expect(toolKind(pane("exec_command"))).toBe("command");
    expect(toolKind(pane("view"))).toBe("read");
  });
});

describe("neverFolded", () => {
  it("keeps MCP and mermaid calls out of the fold, as VS Code does", () => {
    expect(neverFolded(tool("mcp__github__issue"))).toBe(true);
    expect(neverFolded(tool("renderMermaidDiagram"))).toBe(true);
    expect(neverFolded(tool("bash"))).toBe(false);
  });
});

describe("toolIcon", () => {
  it("draws the codicon's lucide stand-in per kind, and the outcome over it", () => {
    expect(toolIcon("command", "done")).toBe(SquareTerminal);
    expect(toolIcon("read", "done")).toBe(BookOpen);
    expect(toolIcon("search_files", "running")).toBe(Search);
    expect(toolIcon("edit", "done")).toBe(Pencil);
    expect(toolIcon("mcp", "done")).toBe(Plug);
    expect(toolIcon("other", "done")).toBe(Wrench);
    expect(toolIcon("command", "failed")).toBe(CircleX);
    expect(toolIcon("read", "skipped")).toBe(CircleSlash);
  });
});

describe("turnStyle", () => {
  it("turn_style_rule: Copilot reads like VS Code, every other agent as today", () => {
    expect(turnStyle(null, true)).toBe("vscode");
    expect(turnStyle("vscode", true)).toBe("vscode");
    expect(turnStyle("copilot", false)).toBe("vscode");
    expect(turnStyle("claude", false)).toBe("classic");
    expect(turnStyle("codex", false)).toBe("classic");
    expect(turnStyle(null, false)).toBe("classic");
    expect(turnStyle("fictional-agent", false)).toBe("classic");
  });
});

describe("toolGroupSummary outcomes", () => {
  it("counts skipped, denied and unfinished calls in VS Code's words, after the failed ones", () => {
    expect(title([tool("bash", { command: "a" }, { state: "skipped" })])).toBe("1 tool call skipped");
    expect(title([tool("bash", { command: "a" }, { state: "denied" }), tool("bash", { command: "b" }, { state: "denied" })])).toBe("2 tool calls denied");
    expect(title([tool("bash", { command: "a" }, { state: "running" })])).toBe("1 unfinished tool call");
    expect(title([tool("bash", { command: "a" }), tool("bash", { command: "b" }, { state: "skipped" }), tool("bash", { command: "c" }, { state: "denied" })]))
      .toBe("Ran 1 command, 1 tool call skipped, 1 tool call denied");
    // past three fragments they are outcomes of the other steps
    expect(title([
      tool("edit", { path: "x.ts" }), tool("bash", { command: "a" }), tool("view", { path: "y.md" }),
      tool("bash", { command: "b" }, { state: "skipped" }), tool("bash", { command: "c" }, { state: "denied" }),
    ])).toBe("Edited x.ts, ran 1 command, read y.md, 2 other steps (1 skipped, 1 denied)");
    // a denied or skipped call counts as one even when it also says it failed
    expect(title([tool("bash", { command: "a" }, { state: "denied", error: true })])).toBe("1 tool call denied");
  });

  it("a call waiting for a confirmation is never folded; a skipped call wears circle-slash", () => {
    expect(neverFolded(tool("bash", { command: "a" }, { state: "awaiting" }))).toBe(true);
    expect(neverFolded(tool("bash", { command: "a" }, { state: "running" }))).toBe(false);
    expect(toolIcon("command", "skipped")).toBe(CircleSlash);
  });
});
