import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";

const user = (text: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "text", text }] } as ConversationTurn);
const render = (paneId: string, turn: ConversationTurn): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId, turn, live: false, waiting: false, showThinking: false }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a user turn's images", () => {
  it("a host chat's turn (no pane) reads no file for an @image mention", () => {
    const html = render("", user("FICTIONAL look at @shots/x.png please"));
    expect(html).toContain("FICTIONAL look at");
    expect(html).not.toContain("fs/file");
    expect(html).not.toContain("<img");
  });

  it("a pane's turn shows the mentioned image through its pane", () => {
    const html = render("p-1", user("FICTIONAL look at @shots/x.png please"));
    expect(html).toContain("fs/file");
  });
});

describe("a notice in a turn", () => {
  const agent = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: null, parts });

  it("a host chat's error notice inside an assistant turn is an error row beside the answer, not the whole turn", () => {
    const html = render("", agent([{ kind: "text", text: "FICTIONAL answer" }, { kind: "notice", text: "FICTIONAL boom", source: "error" }]));
    expect(html).toContain("FICTIONAL answer");
    expect(html).toContain("chat-notice-error");
    expect(html).toContain("FICTIONAL boom");
    // the answer comes first, the error row after it, where the host put it
    expect(html.indexOf("FICTIONAL answer")).toBeLessThan(html.indexOf("FICTIONAL boom"));
    expect(html).toContain("chat-turn-agent");
  });

  it("a system notification between tool work and the answer keeps the work block and the answer", () => {
    const html = render("", agent([
      { kind: "tool", name: "Run in terminal", summary: "FICTIONAL ls", input: "ls", output: "a.txt" },
      { kind: "notice", text: "FICTIONAL subagent done", source: "system" },
      { kind: "text", text: "FICTIONAL two files" },
    ]));
    expect(html).toContain("work-block");
    expect(html).toContain("FICTIONAL subagent done");
    expect(html).toContain("FICTIONAL two files");
    expect(html).not.toContain("chat-notice-error");
  });

  it("a user-seat turn that is only a notice is still the quiet divider", () => {
    const html = render("p-1", { role: "user", ts: null, parts: [{ kind: "notice", text: "FICTIONAL job finished", source: "async-result" }] });
    expect(html).toContain("chat-notice");
    expect(html).toContain("Background result delivered");
    expect(html).not.toContain("chat-turn-user");
    expect(html).not.toContain("chat-turn-agent");
  });
});

describe("a turn's style", () => {
  const settled = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: "2026-01-01T00:00:00.000Z", end_ts: "2026-01-01T00:00:07.000Z", parts } as ConversationTurn);
  const styled = (turn: ConversationTurn, style?: "vscode" | "classic"): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId: "p-1", turn, live: false, waiting: false, showThinking: false, ...(style ? { style } : {}) }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const work = settled([
    { kind: "tool", name: "Edit", summary: "src/x.ts", input: JSON.stringify({ file_path: "src/x.ts", old_string: "a", new_string: "b" }), output: "", edits: [{ path: "src/x.ts", added: 28, removed: 3 }] },
    { kind: "tool", name: "Read", summary: "docs/y.md", input: JSON.stringify({ file_path: "docs/y.md" }), output: "" },
    { kind: "tool", name: "Read", summary: "docs/z.md", input: JSON.stringify({ file_path: "docs/z.md" }), output: "" },
    { kind: "text", text: "FICTIONAL done" },
  ]);

  it("classic is today's header, with or without the prop", () => {
    const html = styled(work, "classic");
    expect(html).toContain('<span class="work-block-title">Worked for 7s</span><span class="work-block-summary">· 1 edit · 2 file reads</span>');
    expect(styled(work)).toBe(html);
    expect(html).not.toContain("Edited x.ts");
  });

  it("vscode sums the work up in VS Code's sentence, its edits and time on the right", () => {
    const html = styled(work, "vscode");
    expect(html).toContain("Edited");
    expect(html).toContain("x.ts, read 2 files");
    expect(html).toContain("work-title-detail");
    expect(html).toContain("+28");
    expect(html).toContain("−3");
    expect(html).toContain("Worked for 7s");
    expect(html).not.toContain("1 edit · 2 file reads");
  });

  it("vscode shows a tool's pictures under the block, outside the fold", () => {
    const html = styled(settled([
      { kind: "tool", name: "view", tool_id: "view", summary: "shot.png", input: JSON.stringify({ path: "/r/shot.png" }), output: "", images: [{ media_type: "image/png", ref: "c1:0" }] },
      { kind: "text", text: "FICTIONAL seen" },
    ]), "vscode");
    expect(html).toContain("is-folded");
    expect(html).toContain("work-images");
    expect(html).toContain("c1%3A0");
    // classic keeps them in the opened row: folded, none drawn
    expect(styled(settled([
      { kind: "tool", name: "view", summary: "shot.png", input: "{}", output: "", images: [{ media_type: "image/png", ref: "c1:0" }] },
      { kind: "text", text: "FICTIONAL seen" },
    ]), "classic")).not.toContain("c1%3A0");
  });

  it("vscode keeps a question and a subagent where they came in the turn, between the tool groups", () => {
    const html = styled(settled([
      { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running", input: "make one", output: "", command: "make one", exit_code: 0 },
      { kind: "question", text: "FICTIONAL which config?", options: ["a", "b"], chosen: ["a"], custom: null, skipped: false },
      { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running", input: "make two", output: "", command: "make two", exit_code: 0 },
      { kind: "subagent", id: "s-1", agent: "explore", description: "FICTIONAL look around", model: null, started: null, ended: null, status: "done" },
      { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running", input: "make three", output: "", command: "make three", exit_code: 0 },
      { kind: "text", text: "FICTIONAL done" },
    ] as ConversationTurn["parts"]), "vscode");
    // each run of calls between them is its own group: three groups of one, the rows between them
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toMatch(/Ran 1 command .*FICTIONAL which config\? .*Ran 1 command .*FICTIONAL look around .*Ran 1 command .*FICTIONAL done/);
  });

  it("vscode keeps an MCP call out of the fold, its own row after the block", () => {
    const html = styled(settled([
      { kind: "tool", name: "bash", tool_id: "bash", summary: "ls", input: "ls", output: "", command: "ls" },
      { kind: "tool", name: "FICTIONAL issue", tool_id: "mcp_github_issue", summary: "FICTIONAL opened #1", input: "{}", output: "" },
      { kind: "text", text: "FICTIONAL done" },
    ]), "vscode");
    expect(html).toContain("is-folded");
    expect(html).toContain("FICTIONAL opened #1");
    expect(html).not.toContain(">ls<");
  });
});

describe("a Copilot pane's turn (no fixture for one: rendered here)", () => {
  const turn = { role: "assistant", ts: "2026-01-01T00:00:00.000Z", end_ts: "2026-01-01T00:00:07.000Z", parts: [
    { kind: "tool", name: "view", summary: "/r/src/a.ts", input: JSON.stringify({ path: "/r/src/a.ts" }), output: "" },
    { kind: "tool", name: "run_in_terminal", summary: "bun test", input: JSON.stringify({ command: "bun test" }), output: "" },
    { kind: "text", text: "FICTIONAL green" },
  ] } as ConversationTurn;
  // live, the block is open and its rows are drawn
  const html = (style: "vscode" | "classic", live = false) => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId: "p-1", turn, live, waiting: false, showThinking: false, style }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it("sums its work up by the app's tool names", () => {
    expect(html("vscode")).toContain('<span class="work-block-title">Ran<span class="work-title-detail"> 1 command, read a.ts</span></span>');
    expect(html("classic")).toContain('<span class="work-block-title">Worked for 7s</span><span class="work-block-summary">· 1 file read · 1 command</span>');
  });

  it("reads its rows with the command as a chip and the file as a pill", () => {
    const out = html("vscode", true);
    expect(out).toContain("Ran <code>bun test</code>");
    expect(out).toContain("work-file-pill");
    expect(out).toContain("<span>a.ts</span>");
  });

  it("classic keeps the verb rows of today", () => {
    const out = html("classic", true);
    expect(out).toContain('<span class="work-row-name is-verb">Ran</span> <span class="work-row-summary">bun test</span>');
    expect(out).not.toContain("work-file-pill");
  });
});

describe("subagents and answered questions in a Copilot turn", () => {
  const settled = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: "2026-01-01T00:00:00.000Z", end_ts: "2026-01-01T00:00:07.000Z", parts });
  const styled = (turn: ConversationTurn, style: "vscode" | "classic"): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId: "", turn, live: false, waiting: false, showThinking: false, style }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const subagent: ConversationTurn["parts"][number] = { kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: null, started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:05.000Z", status: "done", chat: "ahp-chat://default/fictional-sub" };
  const question: ConversationTurn["parts"][number] = { kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: ["Blue"], custom: null, skipped: false };
  const parts: ConversationTurn["parts"] = [
    { kind: "tool", name: "bash", tool_id: "bash", summary: "", input: "{}", output: "", command: "make" },
    subagent,
    question,
    { kind: "text", text: "FICTIONAL done" },
  ];

  it("a subagent is its own row and a question its summary, never inside the work block, in their place", () => {
    const html = styled(settled(parts), "vscode");
    expect(html).toContain("subagent-row");
    expect(html).toContain("question-summary");
    // the block counts only its own call
    expect(html.replace(/<[^>]+>/g, "")).toContain("Ran 1 commandWorked for 7s");
    expect(html).not.toContain("other step");
    const block = html.indexOf("work-block");
    expect(block).toBeLessThan(html.indexOf("subagent-row"));
    expect(html.indexOf("subagent-row")).toBeLessThan(html.indexOf("question-summary"));
    expect(html.indexOf("question-summary")).toBeLessThan(html.indexOf("FICTIONAL done"));
  });

  it("a turn that is only a subagent and a question has no work block, and its answer still reads", () => {
    const html = styled(settled([subagent, question, { kind: "text", text: "FICTIONAL done" }]), "vscode");
    expect(html).not.toContain("work-block");
    expect(html).toContain("FICTIONAL done");
  });
});

describe("a Copilot call's intention and outcome", () => {
  const settled = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: "2026-01-01T00:00:00.000Z", end_ts: "2026-01-01T00:00:07.000Z", parts });
  const open = (turn: ConversationTurn, style: "vscode" | "classic"): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    const memory = { toggles: new Map<string, boolean | null>([["work", true]]), outputs: new Map<string, string>() };
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(Turn, { paneId: "", turn, live: false, waiting: false, showThinking: false, style }) }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, "");
  const call = (extra: Partial<Extract<ConversationTurn["parts"][number], { kind: "tool" }>>) => ({ kind: "tool" as const, name: "bash", tool_id: "bash", summary: "", input: "{}", output: "", command: "make test", ...extra });

  it("an intention comes before the command, as VS Code titles a terminal call", () => {
    const html = open(settled([call({ intention: "FICTIONAL check the build" }), { kind: "text", text: "ok" }]), "vscode");
    expect(text(html)).toContain("FICTIONAL check the build make test");
    expect(html).toContain("<code>make test</code>");
  });

  it("a skipped call says Skipped with circle-slash, and the head counts it", () => {
    const html = open(settled([call({ state: "skipped", intention: "FICTIONAL not shown" }), { kind: "text", text: "ok" }]), "vscode");
    expect(text(html)).toContain("Skipped make test");
    expect(text(html)).not.toContain("FICTIONAL not shown");
    expect(html).toContain("lucide-circle-slash");
    expect(text(html)).toContain("1 tool call skipped");
  });

  it("a call waiting for a yes or no stays out of the fold", () => {
    const html = open(settled([call({ command: "ls" }), call({ state: "awaiting", command: "rm x" }), { kind: "text", text: "ok" }]), "vscode");
    expect(html.indexOf("rm x")).toBeGreaterThan(html.indexOf("work-standalone"));
    expect(text(html)).toContain("Ran 1 command");
  });
});

describe("a Copilot turn's tools grouped between its words, as VS Code does", () => {
  const settled = (parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: "2026-01-01T00:00:00.000Z", end_ts: "2026-01-01T00:00:07.000Z", parts });
  const render = (turn: ConversationTurn, style: "vscode" | "classic", live = false): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, { paneId: "", turn, live, waiting: false, showThinking: false, style }) }));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, "");
  const bash = (command: string) => ({ kind: "tool" as const, name: "bash", tool_id: "bash", summary: "", input: "{}", output: "", command });
  const parts: ConversationTurn["parts"] = [
    bash("ls"), bash("pwd"),
    { kind: "text", text: "FICTIONAL next I read the list" },
    bash("cat a"),
    { kind: "text", text: "FICTIONAL all done" },
  ];

  it("vscode: one folded group per run of tools, the words between them in the open", () => {
    const html = render(settled(parts), "vscode");
    expect(html.match(/class="work-block is-vscode/g)?.length).toBe(2);
    const plain = text(html);
    expect(plain).toContain("Ran 2 commands");
    expect(plain).toContain("Ran 1 command");
    // the narration is outside every fold, between the two groups, and the time is on the last group
    const first = html.indexOf("work-block is-vscode");
    const words = html.indexOf("FICTIONAL next I read the list");
    const second = html.indexOf("work-block is-vscode", first + 1);
    expect(first).toBeLessThan(words);
    expect(words).toBeLessThan(second);
    expect(html.slice(first, second)).not.toContain("Worked for");
    expect(html.slice(second)).toContain("Worked for 7s");
    expect(html.indexOf("FICTIONAL all done")).toBeGreaterThan(second);
  });

  it("vscode, live: only the last group says Working…, the earlier one its sentence", () => {
    const html = render(settled(parts.slice(0, 4)), "vscode", true);
    const plain = text(html);
    expect(plain).toContain("Ran 2 commands");
    expect(plain.match(/Working…/g)?.length).toBe(1);
    expect(plain.indexOf("Ran 2 commands")).toBeLessThan(plain.indexOf("Working…"));
  });

  it("classic keeps one block with the words inside it", () => {
    const html = render(settled(parts), "classic");
    expect(html.match(/class="work-block( |")/g)?.length).toBe(1);
  });
});

