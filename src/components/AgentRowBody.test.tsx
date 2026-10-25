import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { agentsSummary, AgentRowBody, sinceText, SummaryMarks } from "./AgentSidebar.tsx";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const base = { mark: "claude", markKind: null, title: "Sidebar focus", name: null, place: "Mac", context: "herdr-web-ui", tokens: [] as string[] };
const html = (props: Partial<Parameters<typeof AgentRowBody>[0]>): string =>
  renderToStaticMarkup(<SettingsProvider><AgentRowBody {...base} {...props} /></SettingsProvider>);

const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
beforeAll(() => { Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } }); });
afterAll(() => { if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore); else Reflect.deleteProperty(globalThis, "navigator"); });

describe("AgentRowBody", () => {

  it("says a blocked agent's ask in the ask tone", () => {
    const out = html({ status: "blocked", now: { text: "Waiting for you", tone: "ask" } });
    expect(out).toContain('class="agent-now is-ask"');
    expect(out).toContain("Waiting for you");
  });

  it("names the PC on its own, before the place", () => {
    expect(html({}).indexOf('class="agent-pc"')).toBeLessThan(html({}).indexOf("herdr-web-ui"));
  });

  it("shows how long under the state when the pane is stamped", () => {
    expect(html({ status: "working", since: "4m" })).toMatch(/class="agent-since"[^>]*>4m</);
  });

  it("shows no time without a stamp (an older bridge)", () => {
    expect(html({ status: "working", since: null })).not.toContain("agent-since");
  });
});

describe("agentsSummary", () => {
  it("counts what needs you and what works, leaving out zeros", () => {
    expect(agentsSummary(["blocked", "working", "working", "idle"], t)).toEqual([{ status: "blocked", text: "1 waiting on you", count: 1 }, { status: "working", text: "2 working", count: 2 }]);
    expect(agentsSummary(["working"], t)).toEqual([{ status: "working", text: "1 working", count: 1 }]);
    expect(agentsSummary(["idle", undefined], t)).toEqual([]);
  });

  it("counts the finished ones not looked at too, after what works (owner, ZAC-233: the green rows were left out)", () => {
    expect(agentsSummary(["done", "working", "done", "blocked"], t).map((part) => [part.status, part.count])).toEqual([["blocked", 1], ["working", 1], ["done", 2]]);
  });

  it("draws each count with the rows' own mark, so it breathes and follows Settings -> Status indicators", () => {
    const head = (indicators: "classic" | "dots"): string =>
      renderToStaticMarkup(<SettingsProvider><SummaryMarks parts={agentsSummary(["working", "blocked", "done"], t)} indicators={indicators} /></SettingsProvider>);
    const classic = head("classic");
    expect(classic).toMatch(/data-status="working"[^>]*>(<[^>]+>)*<span class="sidebar-status-dot"/);
    expect(classic).toContain('class="sidebar-status-mark" aria-hidden="true">?</span>');
    expect(classic).toMatch(/data-status="done"[^>]*>(<[^>]+>)*<span class="sidebar-status-dot"/);
    expect(head("dots")).toContain("sidebar-status-glyph");
    // each mark in its state's colour, as a row's badge is (styles.css .badge-<status>)
    for (const status of ["working", "blocked", "done"]) expect(classic).toContain(`class="badge badge-${status} sidebar-status agent-summary-mark"`);
    // a decoration beside the words: no live region per mark
    expect(classic).not.toContain('role="status"');
  });
});

describe("sinceText", () => {
  const ja = (key: string, vars?: Record<string, string | number>): string => ({ "now": "今", "{n}m": "{n}分", "{n}h": "{n}時間", "{n}d": "{n}日" } as Record<string, string>)[key]!.replace("{n}", String(vars?.["n"] ?? ""));
  it("goes through the dictionary for every unit", () => {
    expect([sinceText({ unit: "now" }, ja), sinceText({ unit: "m", n: 4 }, ja), sinceText({ unit: "h", n: 2 }, ja), sinceText({ unit: "d", n: 3 }, ja)]).toEqual(["今", "4分", "2時間", "3日"]);
    expect(sinceText({ unit: "m", n: 4 }, t)).toBe("4m");
    expect(sinceText(null, t)).toBeNull();
  });
});
