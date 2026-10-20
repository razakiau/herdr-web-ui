/**
 * The plan limits an OmniRoute gateway already holds for the accounts connected to it: Claude,
 * Copilot, OpenCode Go, GLM, Kimi… one account per connection, read from OmniRoute's own cache
 * (GET /api/usage/provider-limits, which it refreshes on its own schedule) and never refreshed
 * from here. A `read` scope access token (oma_…) is all it needs: OmniRoute grants GETs to it and
 * nothing else. The token comes from the server's environment and never leaves this file: errors
 * are fixed words.
 */

import type { OmniRouteStatus, ProviderUsage, UsageWindow } from "../shared/protocol.ts";
import { FRESH_MS, MIN_REFRESH_MS, RETRY_MS } from "./usage.ts";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ANSWER_BYTES = 1024 * 1024;

/** OmniRoute's provider ids for the providers herdr reads itself; any other keeps OmniRoute's id */
const PROVIDER_IDS: Readonly<Record<string, string>> = {
  claude: "claude", github: "copilot", codex: "codex", cursor: "cursor", "opencode-go": "opencode",
  antigravity: "antigravity", agy: "antigravity", "xai-oauth": "grok", xao: "grok", "grok-cli": "grok",
};
/** Copilot's quotas, named as herdr's own Copilot reading names them */
const QUOTA_SCOPES: Readonly<Record<string, string>> = { premium_interactions: "Premium", chat: "Chat", completions: "Completions" };

const WINDOW_WORDS: readonly [RegExp, UsageWindow["kind"]][] = [
  [/5h|session|hourly/, "session"], [/7d|week/, "week"], [/month|30d/, "month"], [/daily|\bday\b|24h/, "day"],
];
const WINDOW_WORD = /\(?\b(5h|7d|30d|24h|session|hourly|weekly|week|monthly|month|daily|day)\b\)?/gi;

/** A quota's span: from its own name, else from how far its reset is from when it was read. */
function windowKind(name: string, resetMs: number | null, readMs: number): UsageWindow["kind"] | null {
  const lower = name.toLowerCase();
  for (const [words, kind] of WINDOW_WORDS) if (words.test(lower)) return kind;
  if (resetMs === null) return null;
  const left = resetMs - readMs;
  // a reset within the hour is an API rate limit (requests a minute), no plan's
  if (left < HOUR_MS) return null;
  return left <= 6 * HOUR_MS ? "session" : left <= 1.5 * DAY_MS ? "day" : left <= 8 * DAY_MS ? "week" : "month";
}

/**
 * What a quota limits besides its span ("Premium", "Tokens", "MCP"), from its key; null for the
 * plan-wide limit. Not its displayName: OpenCode's reads "$12 / 5 hour", a price, not a scope.
 */
function quotaScope(key: string): string | null {
  if (QUOTA_SCOPES[key]) return QUOTA_SCOPES[key];
  const rest = key.replace(/_/g, " ").replace(WINDOW_WORD, " ").replace(/[\s()-]+/g, " ").trim();
  if (!rest) return null;
  return rest.length <= 3 ? rest.toUpperCase() : rest.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function quotaWindow(key: string, value: unknown, readMs: number): UsageWindow | null {
  const quota = record(value);
  if (!quota || quota["unlimited"] === true) return null;
  const left = number(quota["remainingPercentage"]);
  const used = number(quota["used"]), total = number(quota["total"]);
  const usedPercent = left !== null ? 100 - left : used !== null && total !== null && total > 0 ? used / total * 100 : null;
  if (usedPercent === null) return null;
  const resetText = text(quota["resetAt"]);
  const resetMs = resetText === null ? null : Date.parse(resetText);
  const reset = resetMs === null || Number.isNaN(resetMs) ? null : resetMs;
  const kind = windowKind(key, reset, readMs);
  if (kind === null) return null;
  return { kind, scope: quotaScope(key), used_percent: percent(usedPercent), resets_at: reset === null ? null : new Date(reset).toISOString(), starts_at: null };
}

/**
 * OmniRoute's cached limits as herdr's accounts: one per active connection whose cache holds a plan
 * limit. A cache left by a removed or disabled connection, and API rate limits, are left out.
 */
export function omniRouteUsages(limits: unknown, providers: unknown): ProviderUsage[] {
  const caches = record(record(limits)?.["caches"]);
  const list = record(providers)?.["connections"];
  if (!caches || !Array.isArray(list)) return [];
  return list.flatMap((item): ProviderUsage[] => {
    const connection = record(item);
    const id = text(connection?.["id"]), provider = text(connection?.["provider"])?.toLowerCase();
    if (!connection || !id || !provider || connection["isActive"] !== true || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) return [];
    const cache = record(caches[id]);
    const quotas = record(cache?.["quotas"]);
    const fetched = text(cache?.["fetchedAt"]);
    const readMs = fetched === null ? NaN : Date.parse(fetched);
    if (!cache || !quotas || Number.isNaN(readMs)) return [];
    const windows = Object.entries(quotas).flatMap(([key, value]) => { const window = quotaWindow(key, value, readMs); return window ? [window] : []; });
    if (windows.length === 0) return [];
    const herdrId = PROVIDER_IDS[provider] ?? provider;
    return [{
      id: herdrId, key: `${herdrId}:omniroute:${encodeURIComponent(id)}`,
      account: text(connection["email"]) ?? text(connection["name"]),
      plan: text(cache["plan"]), windows, problem: null, checked_at: new Date(readMs).toISOString(),
    }];
  });
}

export interface OmniRouteConfig { url: string; token: string }

/** An OmniRoute gateway's limits for /api/usage, and its state for Settings. */
export class OmniRouteUsage {
  private readonly url: string | null;
  private entries: readonly ProviderUsage[] = [];
  private problem: string | null = null;
  private readAt: number | null = null;
  private nextAt = 0;
  private pending: Promise<readonly ProviderUsage[]> | null = null;

  constructor(private readonly config: OmniRouteConfig,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now) {
    let url: URL | null = null;
    try { url = config.url && config.token ? new URL(config.url) : null; } catch { url = null; }
    this.url = url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href.replace(/\/+$/, "") : null;
  }

  status(): OmniRouteStatus {
    return { configured: this.url !== null, url: this.url, ok: this.url !== null && this.readAt !== null && this.problem === null,
      problem: this.problem, checked_at: this.readAt === null ? null : new Date(this.readAt).toISOString() };
  }

  report(refresh = false): Promise<readonly ProviderUsage[]> {
    if (this.url === null) return Promise.resolve([]);
    if (this.pending) return this.pending;
    const now = this.now();
    const sooner = refresh && this.readAt !== null && now - this.readAt >= MIN_REFRESH_MS;
    if (now < this.nextAt && !sooner) return Promise.resolve(this.entries);
    const pass = this.collect(now).finally(() => { if (this.pending === pass) this.pending = null; });
    this.pending = pass;
    return pass;
  }

  private async collect(now: number): Promise<readonly ProviderUsage[]> {
    try {
      const [limits, providers] = await Promise.all([this.get("/api/usage/provider-limits"), this.get("/api/providers")]);
      this.entries = omniRouteUsages(limits, providers);
      this.problem = null; this.readAt = now; this.nextAt = now + FRESH_MS;
    } catch (error) {
      this.problem = error instanceof OmniRouteRefused ? "OmniRoute refused the token" : "Could not reach OmniRoute";
      this.nextAt = now + RETRY_MS;
    }
    return this.entries;
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json", authorization: `Bearer ${this.config.token}` },
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new OmniRouteRefused(); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("upstream"); }
    const raw = await response.text();
    if (raw.length > MAX_ANSWER_BYTES) throw new Error("too large");
    return JSON.parse(raw) as unknown;
  }
}

class OmniRouteRefused extends Error {}

/** The gateway named in the server's environment (HERDR_WEB_OMNIROUTE_URL, HERDR_WEB_OMNIROUTE_TOKEN). */
export const omniRouteFromEnv = (env: Record<string, string | undefined> = process.env): OmniRouteUsage =>
  new OmniRouteUsage({ url: env["HERDR_WEB_OMNIROUTE_URL"]?.trim() ?? "", token: env["HERDR_WEB_OMNIROUTE_TOKEN"]?.trim() ?? "" });
