import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerText, QuestionSummary } from "./QuestionSummary.tsx";

type Question = Extract<ConversationPart, { kind: "question" }>;
const part = (extra: Partial<Question> = {}): Question => ({
  kind: "question", text: "FICTIONAL which color?", options: ["Red", "Blue"], chosen: ["Blue"], custom: null, skipped: false, ...extra,
});
const render = (element: ReactElement, open = false): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  // an opened row, as the chat's row memory keeps it
  const memory = { toggles: new Map<string, boolean | null>(open ? [["question", true]] : []), outputs: new Map<string, string>() };
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatRowMemoryContext.Provider, { value: memory, children: element }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("QuestionSummary", () => {
  it("question_summary_reads_like_vscode", () => {
    const html = render(createElement(QuestionSummary, { part: part() }));
    expect(text(html)).toContain("Question: FICTIONAL which color?");
    expect(text(html)).toContain("Answered: Blue");
    expect(html).toContain("question-summary-prefix");
    // the L connector, and folded
    expect(html).toContain("question-summary-decision");
    expect(html).not.toContain("question-summary-options");
    // opened: the options, a check by the chosen one
    const open = render(createElement(QuestionSummary, { part: part() }), true);
    expect(text(open)).toContain("Options");
    const items = [...open.matchAll(/<li class="([^"]*)"[^>]*>(.*?)<\/li>/g)].map((m) => ({ cls: m[1], body: m[2] }));
    expect(items.map((item) => text(item.body!))).toEqual(["Red", "Blue"]);
    expect(items[1]!.cls).toContain("is-selected");
    expect(items[1]!.body).toContain("lucide-check");
    expect(items[0]!.body).not.toContain("lucide-check");
  });

  it("an ask_user report opens under the question, as markdown, folded at first", () => {
    const report = "FICTIONAL **Shipped** the fix.\n\n- FICTIONAL one\n- FICTIONAL two";
    const asked = part({ text: "FICTIONAL Shipped the fix.", report, options: [], chosen: [], custom: "FICTIONAL merge it" });
    const folded = render(createElement(QuestionSummary, { part: asked }));
    expect(folded).toContain('aria-expanded="false"');
    expect(text(folded)).toContain("Report: FICTIONAL Shipped the fix.");
    expect(folded).not.toContain("question-summary-report-body");
    const memory = { toggles: new Map<string, boolean | null>([["question:report", true]]), outputs: new Map<string, string>() };
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let open = "";
    try { open = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(QuestionSummary, { part: asked }) }) })); }
    finally { if (saved) Object.defineProperty(navigator, "languages", saved); else Reflect.deleteProperty(navigator, "languages"); }
    expect(open).toContain("question-summary-report-body");
    expect(open).toContain("<strong><span>Shipped</span></strong>");
    expect(open.match(/<li>/g)?.length).toBe(2);
    expect(open).toContain('aria-expanded="true"');
    expect(text(open)).toContain("Answered: FICTIONAL merge it");
    // a question without one has no such row
    expect(render(createElement(QuestionSummary, { part: part() }))).not.toContain("question-summary-report");
  });

  it("a form's report comes first, named by its first line, then the question it led to", () => {
    const report = "## FICTIONAL Short answer: not today\n\nFICTIONAL details";
    const html = render(createElement(QuestionSummary, { part: part({ text: "FICTIONAL Next", report }) }));
    const words = text(html);
    expect(words).toContain("Report: FICTIONAL Short answer: not today");
    expect(words.indexOf("Report:")).toBeLessThan(words.indexOf("Question: FICTIONAL Next"));
    expect(html).not.toContain("question-summary-report-body");
  });

  it("a skipped question shows Skipped question, no Answered prefix", () => {
    const html = render(createElement(QuestionSummary, { part: part({ chosen: [], skipped: true }) }));
    expect(text(html)).toContain("Skipped question");
    expect(text(html)).not.toContain("Answered:");
  });

  it("a typed answer reads as itself, and opened as Custom answer", () => {
    const html = render(createElement(QuestionSummary, { part: part({ chosen: [], custom: "FICTIONAL teal" }) }), true);
    expect(text(html)).toContain("Answered: FICTIONAL teal");
    expect(text(html)).toContain("Custom answer: FICTIONAL teal");
  });

  it("answers as VS Code formats them: single takes the typed text first, multi joins all", () => {
    expect(answerText(part({ chosen: ["Blue"], custom: "navy" }), false)).toBe("navy");
    expect(answerText(part({ chosen: ["Red", "Blue"], custom: "navy" }), true)).toBe("Red, Blue, navy");
    // a text question has no options: its answer is the text
    expect(answerText(part({ options: [], chosen: [], custom: "FICTIONAL large" }), false)).toBe("FICTIONAL large");
  });

  it("a question with no options does not expand", () => {
    const html = render(createElement(QuestionSummary, { part: part({ options: [], chosen: [], custom: "FICTIONAL large" }) }), true);
    expect(html).not.toContain("question-summary-options");
    expect(html).not.toContain("aria-expanded");
  });
});

describe("an assumed answer (ask_user_async, ZAC-326)", () => {
  const ASSUMED = part({ text: "FICTIONAL keep the table?", options: ["FICTIONAL keep", "FICTIONAL drop"], chosen: ["FICTIONAL drop"], assumed: true, correctable: { session: "copilotcli:/FICTIONAL", async_id: "ask-0a1b2c3d" } });

  it("an assumed answer reads Assumed: and offers Change", () => {
    const html = render(createElement(QuestionSummary, { part: ASSUMED }));
    expect(text(html)).toContain("Assumed: FICTIONAL drop");
    expect(text(html)).not.toContain("Answered:");
    expect(html).toContain("question-summary-prefix is-assumed");
    expect(text(html)).toContain("You were away · Change");
    expect(html).toMatch(/<button[^>]*class="question-summary-change"[^>]*>Change<\/button>/);
    // assumed, but with nothing to send a correction to (the store forgot it): no Change
    const { correctable: _gone, ...uncorrectable } = ASSUMED;
    const bare = render(createElement(QuestionSummary, { part: uncorrectable }));
    expect(text(bare)).toContain("Assumed: FICTIONAL drop");
    expect(bare).not.toContain("question-summary-change");
    // a plain answered part has neither
    const plain = render(createElement(QuestionSummary, { part: part() }));
    expect(text(plain)).not.toContain("Assumed:");
    expect(plain).not.toContain("question-summary-change");
    expect(text(plain)).not.toContain("You were away");
  });

  describe("Change", () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const realFetch = globalThis.fetch;
    let renderer: ReactTestRenderer | undefined;
    let posted: { url: string; body: unknown }[] = [];
    let reply: () => Response;

    beforeEach(() => {
      for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {},
      } });
      posted = [];
      reply = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        posted.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
        return reply();
      }) as typeof fetch;
    });

    afterEach(async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      globalThis.fetch = realFetch;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      descriptors.clear();
    });

    const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
    const classed = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
      root.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));
    async function mount(): Promise<ReactTestInstance> {
      await act(async () => {
        renderer = create(createElement(MachineContext.Provider, { value: "FICTIONAL-pc", children: createElement(SettingsProvider, { children: createElement(QuestionSummary, { part: ASSUMED }) }) }));
      });
      return renderer!.root;
    }
    const press = async (node: ReactTestInstance) => { await act(async () => { (node.props["onClick"] as () => void)(); }); };

    it("Change sends a correction", async () => {
      const root = await mount();
      expect(classed(root, "question-summary-change-option")).toEqual([]);
      await press(classed(root, "question-summary-change")[0]!);
      const options = classed(root, "question-summary-change-option");
      expect(options.map(textOf)).toEqual(["FICTIONAL keep", "FICTIONAL drop"]);
      // the assumed one is marked as what it is now
      expect(options[1]!.props["aria-pressed"]).toBe(true);
      await press(options[0]!);
      expect(posted).toEqual([{ url: "/api/machines/FICTIONAL-pc/host-chats/chat/answer", body: { session: "copilotcli:/FICTIONAL", async_id: "ask-0a1b2c3d", option_ids: ["0"], correction: true } }]);
      // sent: the picker closes, and the line says what goes to the agent until the transcript has it
      expect(classed(root, "question-summary-change-option")).toEqual([]);
      expect(classed(root, "question-summary-change")).toEqual([]);
      expect(textOf(classed(root, "question-summary-away")[0]!)).toBe("Changed to FICTIONAL keep");
    });

    it("a correction the bridge refuses says so and keeps Change", async () => {
      reply = () => new Response(JSON.stringify({ error: { code: "prompt_changed", message: "gone" } }), { status: 409, headers: { "content-type": "application/json" } });
      const root = await mount();
      await press(classed(root, "question-summary-change")[0]!);
      await press(classed(root, "question-summary-change-option")[0]!);
      expect(posted.length).toBe(1);
      expect(textOf(classed(root, "question-summary-change-error")[0]!)).toBe("Couldn't send the change. Try again.");
      expect(classed(root, "question-summary-change").length).toBe(1);
    });
  });
});
