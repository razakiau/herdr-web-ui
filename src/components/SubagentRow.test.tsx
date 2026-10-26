import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { formatElapsedTime, SubagentAsked, SubagentRow, subagentSections } from "./SubagentRow.tsx";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";

type Subagent = Extract<ConversationPart, { kind: "subagent" }>;
const AT = "2026-01-01T00:00:00.000Z";
const part = (extra: Partial<Subagent> = {}): Subagent => ({
  kind: "subagent", id: "c3", agent: "explore", description: "FICTIONAL find the config", model: null,
  started: AT, ended: "2026-01-01T00:05:43.000Z", status: "done", chat: "ahp-chat://default/fictional-sub", ...extra,
});
const render = (element: ReactElement): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const withToggles = (toggles: Record<string, boolean>, child: ReactElement): ReactElement =>
  createElement(ChatRowMemoryContext.Provider, { value: { toggles: new Map(Object.entries(toggles)), outputs: new Map() }, children: child });
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("SubagentRow", () => {
  it("formats elapsed time as VS Code's formatElapsedTime", () => {
    expect(formatElapsedTime(0)).toBe("0s");
    expect(formatElapsedTime(45_900)).toBe("45s");
    expect(formatElapsedTime(83_000)).toBe("1m 23s");
    expect(formatElapsedTime(343_000)).toBe("5m 43s");
  });

  it("subagent_row_shows_name_task_time", () => {
    const done = render(createElement(SubagentRow, { part: part(), live: false }));
    expect(text(done)).toContain("explore");
    expect(text(done)).toContain("FICTIONAL find the config");
    expect(text(done)).toContain("Worked for 5m 43s");
    // comment-discussion, no spinner
    expect(done).toContain("lucide-messages-square");
    expect(done).not.toContain("lucide-loader-circle");
    const running = render(createElement(SubagentRow, { part: part({ status: "running", ended: null }), live: true, now: Date.parse(AT) + 3_400 }));
    expect(text(running)).toContain("Working for 3s");
    // the breathing dot every "in progress" wears, not a spinner: stepped, a spinner ratcheted like a gear (owner, ZAC-228)
    expect(running).toContain('class="work-block-dot subagent-row-dot"');
    expect(running).not.toContain("lucide-loader-circle");
    expect(running).not.toContain("lucide-messages-square");
  });

  it("a running subagent's step reads as text, its code as code, never raw backticks (owner, ZAC-228)", () => {
    const row = render(createElement(SubagentRow, { part: part({ status: "running", ended: null, activity: "Ran `cat > /tmp/fictional.mjs`" }), live: true, now: Date.parse(AT) }));
    expect(row).toContain("<code>cat &gt; /tmp/fictional.mjs</code>");
    expect(text(row)).not.toContain("`");
  });

  it("a long brief folds to a few lines with Show full brief; a short one stands whole (owner, ZAC-228)", () => {
    const long = Array.from({ length: 9 }, (_, index) => `FICTIONAL brief line ${index + 1}`).join("\n\n");
    const folded = render(createElement(SubagentAsked, { id: "c3", text: long }));
    expect(folded).toContain("subagent-asked is-capped");
    expect(folded).toContain('aria-expanded="false"');
    expect(text(folded)).toContain("Show full brief");
    const opened = render(withToggles({ "subagent-asked:c3": true }, createElement(SubagentAsked, { id: "c3", text: long })));
    expect(opened).not.toContain("is-capped");
    expect(text(opened)).toContain("Show less");
    const short = render(createElement(SubagentAsked, { id: "c3", text: "FICTIONAL find the config" }));
    expect(short).not.toContain("is-capped");
    expect(short).not.toContain("subagent-asked-fold");
  });

  it("a background subagent breathes and counts on after its turn has ended (ZAC-207)", () => {
    const row = render(createElement(SubagentRow, { part: part({ status: "running", ended: null, background: true, activity: "FICTIONAL reading" }), live: false, now: Date.parse(AT) + 63_000 }));
    expect(row).toContain("subagent-row-dot");
    expect(text(row)).toContain("Working for 1m 3s");
    expect(text(row)).toContain("FICTIONAL reading");
    // a sync one whose turn is over is not shown as working
    expect(render(createElement(SubagentRow, { part: part({ status: "running", ended: null }), live: false, now: Date.parse(AT) + 63_000 }))).not.toContain("subagent-row-dot");
  });

  it("names its model on the row, with the model's mark and its effort, as the composer's pill (owner, ZAC-233)", () => {
    const read = async () => [];
    expect(render(createElement(SubagentRow, { part: part(), live: false, readChat: read }))).not.toContain("subagent-row-model");
    const closed = render(createElement(SubagentRow, { part: part({ model: "FICTIONAL Claude Model (Anthropic) · low", modelName: "FICTIONAL Claude Model (Anthropic)", modelId: "fictional/claude-model", effort: "low" }), live: false, readChat: read }));
    // closed, the head holds it: the mark (Claude's), the short name, the effort
    expect(closed).toContain("subagent-row-model");
    expect(closed).toContain('data-mark="claude"');
    expect(text(closed)).toContain("FICTIONAL Claude Model");
    expect(text(closed)).not.toContain("(Anthropic)");
    expect(closed).toMatch(/class="subagent-row-effort"[^>]*>low</);
    // an older bridge sends the words only: they still show
    expect(text(render(createElement(SubagentRow, { part: part({ model: "FICTIONAL Model B" }), live: false, readChat: read })))).toContain("FICTIONAL Model B");
  });

  it("is a card, open on its own while it runs, closed once done, the reader's choice first (ZAC-228)", () => {
    const read = () => new Promise<ConversationTurn[]>(() => undefined);
    const running = part({ status: "running", ended: null });
    const expanded = (html: string) => html.includes('aria-expanded="true"');
    expect(render(createElement(SubagentRow, { part: part(), live: false, readChat: read }))).toContain("subagent-card");
    expect(expanded(render(createElement(SubagentRow, { part: running, live: true, readChat: read, now: Date.parse(AT) })))).toBe(true);
    expect(expanded(render(createElement(SubagentRow, { part: part(), live: false, readChat: read })))).toBe(false);
    // the reader closed it while it ran: it stays closed, running or done
    expect(expanded(render(withToggles({ "subagent:c3": false }, createElement(SubagentRow, { part: running, live: true, readChat: read, now: Date.parse(AT) }))))).toBe(false);
    // the reader opened it: it stays open once done
    expect(expanded(render(withToggles({ "subagent:c3": true }, createElement(SubagentRow, { part: part(), live: false, readChat: read }))))).toBe(true);
  });

  it("a failed subagent wears the error icon, and one with no times shows none", () => {
    const failed = render(createElement(SubagentRow, { part: part({ status: "failed" }), live: false }));
    expect(failed).toContain("lucide-circle-x");
    const untimed = render(createElement(SubagentRow, { part: part({ started: null, ended: null }), live: false }));
    expect(text(untimed)).not.toContain("Worked for");
  });

  it("a finished one is folded until opened: it reads nothing on its own", () => {
    let reads = 0;
    const html = render(createElement(SubagentRow, { part: part(), live: false, readChat: async () => { reads += 1; return []; } }));
    expect(reads).toBe(0);
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("subagentSections", () => {
  const turns: ConversationTurn[] = [
    { role: "user", ts: AT, parts: [{ kind: "text", text: "FICTIONAL find the config" }] },
    { role: "assistant", ts: AT, end_ts: AT, parts: [
      { kind: "tool", name: "grep", tool_id: "grep", summary: "config", input: "{}", output: "" },
      { kind: "text", text: "FICTIONAL two candidates, checking both" },
      { kind: "tool", name: "view", tool_id: "view", summary: "a.toml", input: "{}", output: "" },
      { kind: "text", text: "FICTIONAL the config is release.toml" },
    ] },
  ];
  const words = (list: ConversationTurn[]) => list.flatMap((turn) => turn.parts).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text);

  it("splits what it was asked, its work with its narration, and its answer, losing nothing", () => {
    const { asked, work, answer } = subagentSections(turns);
    expect(asked).toBe("FICTIONAL find the config");
    expect(answer).toBe("FICTIONAL the config is release.toml");
    expect(words(work)).toEqual(["FICTIONAL two candidates, checking both"]);
    expect(work[0]!.parts.filter((p) => p.kind === "tool").length).toBe(2);
  });

  it("has no answer while it has not written one, and no question when none came first", () => {
    const running = subagentSections([turns[1]!].map((turn) => ({ ...turn, parts: turn.parts.slice(0, 1) })));
    expect(running.asked).toBeNull();
    expect(running.answer).toBeNull();
    expect(running.work.length).toBe(1);
  });
});
