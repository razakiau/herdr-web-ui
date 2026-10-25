import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { agentsSummary, AgentRowBody } from "./AgentSidebar.tsx";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const base = { mark: "claude", markKind: null, title: "Sidebar focus", name: null, place: "Mac", context: "herdr-web-ui", tokens: [] as string[] };
const html = (props: Partial<Parameters<typeof AgentRowBody>[0]>): string =>
  renderToStaticMarkup(<SettingsProvider><AgentRowBody {...base} {...props} /></SettingsProvider>);

describe("AgentRowBody", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  beforeAll(() => { Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } }); });
  afterAll(() => { if (before) Object.defineProperty(globalThis, "navigator", before); else Reflect.deleteProperty(globalThis, "navigator"); });

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
    expect(agentsSummary(["blocked", "working", "working", "idle"], t)).toEqual([{ status: "blocked", text: "1 needs you" }, { status: "working", text: "2 working" }]);
    expect(agentsSummary(["working"], t)).toEqual([{ status: "working", text: "1 working" }]);
    expect(agentsSummary(["idle", undefined], t)).toEqual([]);
  });
});
