import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { closestFirst, composerUsage, groupWindow, planLabel, planWeight, providerGroups, formatPercent, formatResetIn, glanceWindow, meterPercent, meterText, moveInOrder, newOmniRouteProviders, orderProviders, providerForAgent, providerMark, providerName, shownUsages, statusWindows, tightestWindow, usageName, viaOmniRoute, windowLabel } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const window = (used_percent: number, kind: UsageWindow["kind"] = "week", scope: string | null = null): UsageWindow => ({ kind, scope, used_percent, resets_at: null, starts_at: null });
const provider = (id: ProviderUsage["id"], windows: UsageWindow[], account: string | null = null): ProviderUsage => ({
  id, key: account ? `${id}:${account}` : id, account, plan: null, windows, problem: null, checked_at: null,
});

describe("usage meters", () => {
  it("uses the agent's provider and the first visible account in Settings order", () => {
    const accounts = [provider("claude", [window(40)]), provider("codex", [window(20)], "a@x"), provider("codex", [window(80)], "b@x")];
    expect(composerUsage(accounts, "codex", ["codex:b@x"], [])?.account).toBe("b@x");
    expect(composerUsage(accounts, "codex", ["codex:b@x"], ["codex:b@x"])?.account).toBe("a@x");
    expect(composerUsage(accounts, "pi", [], [])).toBeUndefined();
    expect(composerUsage(accounts, null, [], [])).toBeUndefined();
    expect(providerForAgent("agy")).toBe("antigravity");
    expect(providerForAgent("opencode")).toBe("opencode");
  });

  it("prioritizes the plan-wide five-hour session, with weekly fallback only", () => {
    expect(statusWindows(provider("claude", [window(99, "week", "Sonnet"), window(84), window(22, "session")]))).toEqual([window(22, "session"), window(84)]);
    expect(statusWindows(provider("codex", [window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("claude", [window(22, "session", "Opus"), window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("cursor", [window(80, "month")]))).toEqual([]);
  });
  it("shows the limit closest to running out", () => {
    expect(tightestWindow(provider("codex", [window(12, "session"), window(77)]))).toEqual(window(77));
    expect(tightestWindow(provider("claude", []))).toBeNull();
  });

  it("shows the chosen limit of the whole plan, and the closest to running out where a plan has none", () => {
    const claude = provider("claude", [window(80, "session"), window(30), window(95, "week", "Sonnet")]);
    expect(glanceWindow(claude, "week")).toEqual(window(30));
    expect(glanceWindow(claude, "session")).toEqual(window(80, "session"));
    expect(glanceWindow(provider("codex", [window(30)]), "session")).toEqual(window(30));
    expect(glanceWindow(provider("cursor", [window(20, "month"), window(60, "month", "Premium")]), "week")).toEqual(window(60, "month", "Premium"));
    expect(glanceWindow(provider("grok", []), "week")).toBeNull();
  });

  it("keeps the server's order until the user arranges the accounts", () => {
    const order = orderProviders([provider("claude", []), provider("codex", [window(40)]), provider("copilot", [window(90, "month")])]);
    expect(order.map((usage) => usage.id)).toEqual(["claude", "codex", "copilot"]);
  });

  it("follows the user's order first, then the server's", () => {
    const providers = [provider("claude", [window(10)]), provider("codex", [window(40)], "a@x"), provider("codex", [window(90)], "b@x"), provider("grok", [window(50)])];
    const keys = (order: string[]) => orderProviders(providers, order).map((usage) => usage.key);
    expect(keys([])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
    expect(keys(["claude", "codex:a@x", "gone"])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
  });

  it("moves an account one place and keeps accounts not reported now", () => {
    expect(moveInOrder(["a", "b", "c"], ["x", "b"], "c", -1)).toEqual(["a", "c", "b", "x"]);
    expect(moveInOrder(["a", "b", "c"], [], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], [], "a", 1)).toEqual(["b", "a"]);
  });

  it("counts a meter as used or left, and names the account", () => {
    expect(meterPercent(window(77.4), "used")).toBe(77.4);
    expect(meterPercent(window(77.4), "left")).toBe(22.6);
    expect(meterText(window(77), "used")).toBe("77%");
    expect(meterText(window(77), "left")).toBe("23% left");
    expect(usageName(provider("codex", [], "me@example.com"))).toBe("Codex · me@example.com");
    expect(usageName(provider("grok", []))).toBe("Grok");
  });

  it("formats the time to a reset, and nothing for a past or unknown one", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetIn(at(12 * 60_000), NOW)).toBe("12m");
    expect(formatResetIn(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h 59m");
    expect(formatResetIn(at(50 * 3600_000), NOW)).toBe("2d 2h");
    expect(formatResetIn(at(-1000), NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
  });

  it("keeps a sliver above zero visible and rounds the rest", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(2.2)).toBe("2%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("names a window by its span and its scope", () => {
    expect(windowLabel(window(1, "session"))).toBe("Session");
    expect(windowLabel(window(1, "week", "Sonnet"))).toBe("Weekly · Sonnet");
    expect(windowLabel(window(1, "month", "Premium"))).toBe("Monthly · Premium");
    expect(windowLabel(window(1, "month", "Cursor models"))).toBe("Monthly · Cursor models");
  });
});

describe("OmniRoute accounts", () => {
  const own = provider("claude", [window(10)], "me");
  const viaClaude: ProviderUsage = { ...provider("claude", [window(90)]), key: "claude:omniroute:c1", account: "work" };
  const viaGlm: ProviderUsage = { ...provider("glm", [window(40, "session")]), key: "glm:omniroute:g1" };

  it("names providers herdr does not know, and gives them a lettered mark", () => {
    expect(providerName("glm")).toBe("GLM");
    expect(providerName("kimi-coding")).toBe("Kimi");
    expect(providerName("acme-cloud")).toBe("Acme Cloud");
    expect(providerName("copilot")).toBe("GitHub Copilot");
    expect(providerMark("antigravity")).toBe("agy");
    expect(providerMark("glm")).toBe("glm");
    expect(usageName(viaGlm)).toBe("GLM");
  });

  it("tells an OmniRoute account from this PC's", () => {
    expect([own, viaClaude, viaGlm].map(viaOmniRoute)).toEqual([false, true, true]);
  });

  it("shows this PC's accounts unless hidden, and OmniRoute's only for providers chosen", () => {
    const all = [own, viaClaude, viaGlm];
    expect(shownUsages(all, { order: [], hidden: [], shown: [] }).map((usage) => usage.key)).toEqual(["claude:me"]);
    expect(shownUsages(all, { order: [], hidden: [], shown: ["glm"] }).map((usage) => usage.key)).toEqual(["claude:me", "glm:omniroute:g1"]);
    expect(shownUsages(all, { order: [], hidden: ["glm:omniroute:g1"], shown: ["glm", "claude"] }).map((usage) => usage.key)).toEqual(["claude:me", "claude:omniroute:c1"]);
  });

  it("the providers OmniRoute reports that Settings has not offered yet, once each", () => {
    expect(newOmniRouteProviders([own, viaClaude, viaGlm, { ...viaGlm, key: "glm:omniroute:g2" }], [])).toEqual(["claude", "glm"]);
    expect(newOmniRouteProviders([own, viaClaude, viaGlm], ["claude"])).toEqual(["glm"]);
  });

  it("closest to its limit first, by each account's tightest window; ties keep their order", () => {
    const a = provider("codex", [window(20), window(70, "session")], "a");
    const b = provider("codex", [window(50)], "b");
    const c = provider("codex", [], "c");
    const d = provider("codex", [window(50)], "d");
    expect(closestFirst([c, b, a, d]).map((usage) => usage.account)).toEqual(["a", "b", "d", "c"]);
  });
});

describe("planLabel", () => {
  it("names a plan the way its provider sells it, short enough for a pill", () => {
    expect(planLabel("default_claude_max_20x", "claude")).toBe("Ultra");
    expect(planLabel("default_claude_max_5x", "claude")).toBe("Max 5x");
    expect(planLabel("claude_pro", "claude")).toBe("Pro");
    expect(planLabel("default_raven", "claude")).toBe("Raven");
    expect(planLabel("OpenCode Go", "opencode")).toBe("Go");
    expect(planLabel("business", "copilot")).toBe("Business");
    expect(planLabel("max", "claude")).toBe("Max");
  });
  it("shows no pill for an empty plan or one that only repeats the provider", () => {
    expect(planLabel(null, "claude")).toBeNull();
    expect(planLabel("  ", "claude")).toBeNull();
    expect(planLabel("OpenCode", "opencode")).toBeNull();
    expect(planLabel("default", "claude")).toBeNull();
  });
});

describe("one chip per provider", () => {
  const plan = (usage: ProviderUsage, name: string): ProviderUsage => ({ ...usage, plan: name });
  it("groups a provider's accounts in the order its first one is shown", () => {
    const a = provider("codex", [window(10)], "a@x"), b = provider("claude", [window(20)], "b@x"), c = provider("codex", [window(30)], "c@x");
    expect(providerGroups([a, b, c])).toEqual([[a, c], [b]]);
    expect(providerGroups([a, b, c], "account")).toEqual([[a], [b], [c]]);
  });
  it("weighs each account by its plan's weekly size (claude.com/pricing): Ultra, once Max 20x, is 10 Pro, Max 5", () => {
    const big = plan(provider("claude", [window(10)], "a"), "default_claude_max_20x");
    const small = plan(provider("claude", [window(90)], "b"), "default_claude_max_5x");
    expect(planWeight(big)).toBe(10);
    expect(planWeight(plan(provider("claude", []), "default_claude_ultra"))).toBe(10);
    expect(planWeight(small)).toBe(5);
    expect(planWeight(plan(provider("claude", []), "claude_pro"))).toBe(1);
    expect(groupWindow([big, small], "week")?.used_percent).toBe(36.7);
  });
  it("weighs Copilot by its monthly premium requests, and an unknown plan as 1", () => {
    expect(planWeight(plan(provider("copilot", []), "Copilot Pro"))).toBe(300);
    expect(planWeight(plan(provider("copilot", []), "Copilot Pro+"))).toBe(1500);
    expect(planWeight(plan(provider("copilot", []), "free"))).toBe(50);
    expect(planWeight(plan(provider("opencode", []), "OpenCode Go"))).toBe(1);
    expect(planWeight(provider("codex", []))).toBe(1);
  });
  it("same-plan accounts average plainly; an account without the limit is left out", () => {
    expect(groupWindow([provider("codex", [window(20)], "a"), provider("codex", [window(60)], "b")], "week")?.used_percent).toBe(40);
    expect(groupWindow([provider("codex", [window(20)], "a"), provider("codex", [], "b")], "week")?.used_percent).toBe(20);
    expect(groupWindow([provider("codex", [], "a")], "week")).toBeNull();
  });
  it("a single account is its own window", () => {
    const one = provider("claude", [window(22, "session"), window(84)], "a");
    expect(groupWindow([one], "session")).toEqual(window(22, "session"));
  });
});
