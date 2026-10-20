import { describe, expect, it } from "bun:test";
import { OmniRouteUsage, omniRouteUsages } from "./omniroute.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TOKEN = "oma_FICTIONAL_token_never_in_answers";

const limits = {
  caches: {
    c1: { fetchedAt: at(-4 * 60_000), plan: "max", quotas: {
      "session (5h)": { used: 31, total: 100, remainingPercentage: 69, resetAt: at(3 * HOUR), unlimited: false },
      "weekly (7d)": { used: 12, total: 100, remainingPercentage: 88, resetAt: at(5 * DAY), unlimited: false },
    } },
    gh: { fetchedAt: at(-60_000), plan: "business", quotas: {
      premium_interactions: { used: 150, total: 300, remainingPercentage: 50, resetAt: at(20 * DAY), unlimited: false },
      chat: { used: 0, total: 0, remainingPercentage: 100, resetAt: at(20 * DAY), unlimited: true },
    } },
    glm: { fetchedAt: at(-60_000), plan: null, quotas: {
      tokens_5h: { used: 75, total: 100, resetAt: at(2 * HOUR), unlimited: false, displayName: "$12 / 5 hour" },
      mcp_monthly: { used: 5, total: 100, resetAt: at(25 * DAY), unlimited: false },
    } },
    // API rate limits: they start over within the minute, they are no plan
    api: { fetchedAt: at(-60_000), plan: null, quotas: {
      requests: { used: 1, total: 50, remainingPercentage: 98, resetAt: at(40_000), unlimited: false },
    } },
    // a connection removed long ago left its cache
    stale: { fetchedAt: at(-90 * DAY), plan: null, quotas: { session: { used: 1, total: 10, resetAt: at(-89 * DAY), unlimited: false } } },
    // a disabled connection
    off: { fetchedAt: at(-60_000), plan: null, quotas: { session: { used: 1, total: 10, resetAt: at(HOUR), unlimited: false } } },
  },
};
const connections = { connections: [
  { id: "c1", provider: "claude", isActive: true, name: "FICTIONAL work", email: "fictional@example.test" },
  { id: "gh", provider: "github", isActive: true },
  { id: "glm", provider: "glm", isActive: true, name: "FICTIONAL glm" },
  { id: "api", provider: "anthropic", isActive: true, name: "FICTIONAL api" },
  { id: "off", provider: "codex", isActive: false, name: "FICTIONAL off" },
] };

describe("omniRouteUsages", () => {
  const usages = omniRouteUsages(limits, connections);

  it("one account per active connection with a plan limit, keyed by its connection", () => {
    expect(usages.map((usage) => usage.key)).toEqual(["claude:omniroute:c1", "copilot:omniroute:gh", "glm:omniroute:glm"]);
  });

  it("maps OmniRoute's provider ids to herdr's, and keeps the ones herdr does not know", () => {
    expect(usages.map((usage) => usage.id)).toEqual(["claude", "copilot", "glm"]);
  });

  it("reads windows: 5h is the session, 7d the week, a reset 20 days out the month; unlimited ones leave", () => {
    expect(usages[0]!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 31, resets_at: at(3 * HOUR), starts_at: null },
      { kind: "week", scope: null, used_percent: 12, resets_at: at(5 * DAY), starts_at: null },
    ]);
    expect(usages[1]!.windows).toEqual([{ kind: "month", scope: "Premium", used_percent: 50, resets_at: at(20 * DAY), starts_at: null }]);
  });

  it("without remainingPercentage, used over total; the scope comes from the key, never a price-like displayName", () => {
    expect(usages[2]!.windows).toEqual([
      { kind: "session", scope: "Tokens", used_percent: 75, resets_at: at(2 * HOUR), starts_at: null },
      { kind: "month", scope: "MCP", used_percent: 5, resets_at: at(25 * DAY), starts_at: null },
    ]);
  });

  it("names the account by email, else connection name; plan and fetch time pass through", () => {
    expect(usages.map((usage) => usage.account)).toEqual(["fictional@example.test", null, "FICTIONAL glm"]);
    expect(usages[0]!.plan).toBe("max");
    expect(usages[0]!.checked_at).toBe(at(-4 * 60_000));
    expect(usages.every((usage) => usage.problem === null)).toBe(true);
  });

  it("an unreadable answer is no accounts", () => {
    expect(omniRouteUsages(null, connections)).toEqual([]);
    expect(omniRouteUsages({ caches: [] }, { connections: "x" })).toEqual([]);
  });
});

describe("OmniRouteUsage", () => {
  const fetcher = (answers: Record<string, () => Response>, seen: { url: string; auth: string | null }[] = []) => async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization") });
    const path = new URL(url).pathname;
    return answers[path]?.() ?? new Response("{}", { status: 404 });
  };
  const ok = { "/api/usage/provider-limits": () => Response.json(limits), "/api/providers": () => Response.json(connections) };

  it("is off without a URL and a token", async () => {
    const service = new OmniRouteUsage({ url: "", token: "" }, fetcher(ok));
    expect(service.status()).toEqual({ configured: false, url: null, ok: false, problem: null, checked_at: null });
    expect(await service.report()).toEqual([]);
  });

  it("reads the cache with the token, once per FRESH window, and says it is connected", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    let now = NOW;
    const service = new OmniRouteUsage({ url: "http://omniroute.test:20128/", token: TOKEN }, fetcher(ok, seen), () => now);
    expect((await service.report()).length).toBe(3);
    expect(seen.map((call) => call.url)).toEqual(["http://omniroute.test:20128/api/usage/provider-limits", "http://omniroute.test:20128/api/providers"]);
    expect(seen.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    now += 60_000;
    await service.report();
    expect(seen.length).toBe(2);
    expect(service.status()).toEqual({ configured: true, url: "http://omniroute.test:20128", ok: true, problem: null, checked_at: new Date(NOW).toISOString() });
  });

  it("never sends a refresh to the providers: only GETs", async () => {
    const methods: string[] = [];
    const service = new OmniRouteUsage({ url: "http://omniroute.test", token: TOKEN }, async (url, init) => { methods.push(init.method ?? "GET"); return fetcher(ok)(url, init); }, () => NOW);
    await service.report(true);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("a refused token keeps the last numbers and says so, without the token in the words", async () => {
    let refuse = false;
    let now = NOW;
    const service = new OmniRouteUsage({ url: "http://omniroute.test", token: TOKEN },
      fetcher({ ...ok, "/api/usage/provider-limits": () => refuse ? new Response(`bad ${TOKEN}`, { status: 401 }) : Response.json(limits) }), () => now);
    await service.report();
    refuse = true; now += 10 * 60_000;
    const kept = await service.report();
    expect(kept.length).toBe(3);
    expect(service.status().ok).toBe(false);
    expect(service.status().problem).toBe("OmniRoute refused the token");
    expect(JSON.stringify(service.status())).not.toContain(TOKEN);
  });

  it("an unreachable OmniRoute says so", async () => {
    const service = new OmniRouteUsage({ url: "http://omniroute.test", token: TOKEN }, async () => { throw new Error(`down ${TOKEN}`); }, () => NOW);
    expect(await service.report()).toEqual([]);
    expect(service.status().problem).toBe("Could not reach OmniRoute");
  });
});
