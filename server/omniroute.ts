/**
 * The plan limits an OmniRoute gateway already holds for the accounts connected to it: Claude,
 * Copilot, OpenCode Go, GLM, Kimi… one account per connection, read from OmniRoute's own cache
 * (GET /api/usage/provider-limits, which it refreshes on its own schedule) and never refreshed
 * from here. A `read` scope access token (oma_…) is all it needs: OmniRoute grants GETs to it and
 * nothing else. The token comes from the server's environment, else from Settings (OmniRouteLink),
 * and never leaves this file: errors are fixed words.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelPrice, ModelPrices, OmniRouteStatus, ProviderUsage, UsageWindow } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";
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

/** How long a price table is kept: OmniRoute's own sync runs daily at most */
const PRICES_MS = 6 * HOUR_MS;

/** OmniRoute's prices as its cost calculator reads them (computeCostFromPricing), nothing else of the table. */
export function pricesFrom(raw: unknown): ModelPrices {
  const table: ModelPrices = {};
  for (const [provider, models] of Object.entries(record(raw) ?? {})) {
    const byModel: Record<string, ModelPrice> = {};
    for (const [model, value] of Object.entries(record(models) ?? {})) {
      const price = record(value);
      const input = number(price?.["input"]), output = number(price?.["output"]), cached = number(price?.["cached"]);
      if (input === null || output === null || input < 0 || output < 0) continue;
      byModel[model] = { input, output, ...(cached !== null && cached >= 0 ? { cached } : {}) };
    }
    if (Object.keys(byModel).length > 0) table[provider] = byModel;
  }
  return table;
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
  private prices: ModelPrices | null = null;
  private pricesAt = 0;
  private pricesRetryAt = 0;
  private pricesPending: Promise<void> | null = null;

  constructor(private readonly config: OmniRouteConfig,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now) {
    let url: URL | null = null;
    try { url = config.url && config.token ? new URL(config.url) : null; } catch { url = null; }
    this.url = url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href.replace(/\/+$/, "") : null;
  }

  status(): Omit<OmniRouteStatus, "source"> {
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

  /**
   * OmniRoute's price table (GET /api/pricing: defaults, LiteLLM, models.dev and the user's own,
   * merged), USD per million tokens by provider and model, for a chat's cost estimate. Read at most
   * every PRICES_MS; a failed read keeps the last table. Null when no gateway is set or none was read.
   */
  async pricing(): Promise<ModelPrices | null> {
    if (this.url === null) return null;
    const now = this.now();
    if (this.prices !== null && now < this.pricesAt + PRICES_MS) return this.prices;
    if (now < this.pricesRetryAt) return this.prices;
    this.pricesPending ??= this.get("/api/pricing").then((raw) => {
      this.prices = pricesFrom(raw); this.pricesAt = this.now();
    }, () => { this.pricesRetryAt = this.now() + RETRY_MS; }).finally(() => { this.pricesPending = null; });
    await this.pricesPending;
    return this.prices;
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
export const omniRouteFromEnv = (env: Record<string, string | undefined> = process.env,
  fetcher?: (url: string, init: RequestInit) => Promise<Response>, now?: () => number): OmniRouteUsage =>
  new OmniRouteUsage({ url: env["HERDR_WEB_OMNIROUTE_URL"]?.trim() ?? "", token: env["HERDR_WEB_OMNIROUTE_TOKEN"]?.trim() ?? "" }, fetcher, now);

export class OmniRouteError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
const invalid = () => new OmniRouteError("invalid_omniroute_request", 400, "Invalid OmniRoute settings");
const pinned = () => new OmniRouteError("omniroute_env", 409, "OmniRoute is set by the server");

/**
 * The gateway this server reads, and where it came from. The server's environment wins: whoever
 * runs the server set it on purpose, so Settings shows it and cannot change it. Without it, the one
 * saved from Settings, in `omniroute.json` in the state folder (mode 0600, like the Hub's).
 */
export class OmniRouteLink {
  private readonly path: string;
  private readonly pinned: boolean;
  private saved: OmniRouteConfig | null = null;
  private unreadable = false;
  private usage: OmniRouteUsage;

  constructor(stateDir: string, env: Record<string, string | undefined> = process.env,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now) {
    this.path = join(stateDir, "omniroute.json");
    const fromEnv = omniRouteFromEnv(env, fetcher, now);
    this.pinned = fromEnv.status().configured;
    if (this.pinned) { this.usage = fromEnv; return; }
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const json = record(value);
      if (json && Object.keys(json).length === 0) this.saved = null;
      else if (json && typeof json["url"] === "string" && typeof json["token"] === "string") this.saved = { url: json["url"], token: json["token"] };
      else throw new Error("shape");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.unreadable = true;
        console.warn("omniroute: Could not read the OmniRoute settings");
      }
    }
    this.usage = new OmniRouteUsage(this.saved ?? { url: "", token: "" }, fetcher, now);
  }

  status(): OmniRouteStatus {
    const status = this.usage.status();
    return { ...status, source: status.configured ? (this.pinned ? "env" : "saved") : null,
      problem: status.problem ?? (this.unreadable && !status.configured ? "Could not read the OmniRoute settings" : null) };
  }

  report(refresh = false): Promise<readonly ProviderUsage[]> { return this.usage.report(refresh); }

  pricing(): Promise<ModelPrices | null> { return this.usage.pricing(); }

  /** Saves `{url, token?}` and reads the gateway once; a blank token keeps the saved one for the same URL. */
  async save(value: unknown): Promise<OmniRouteStatus> {
    if (this.pinned) throw pinned();
    const json = record(value);
    if (!json || typeof json["url"] !== "string" || json["url"].length > 2000) throw invalid();
    const url = normalizeUrl(json["url"]);
    const supplied = json["token"];
    if (supplied !== undefined && (typeof supplied !== "string" || !supplied.trim())) throw invalid();
    const token = typeof supplied === "string" ? supplied.trim() : this.saved && normalizeUrl(this.saved.url) === url ? this.saved.token : null;
    if (!token || token.length > 2000 || /\s/.test(token) || url.includes(token)) throw invalid();
    this.persist({ url, token });
    await this.usage.report(true);
    return this.status();
  }

  remove(): OmniRouteStatus {
    if (this.pinned) throw pinned();
    this.persist(null);
    return this.status();
  }

  private persist(config: OmniRouteConfig | null): void {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(config ?? {}), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.saved = config;
    this.unreadable = false;
    this.usage = new OmniRouteUsage(config ?? { url: "", token: "" }, this.fetcher, this.now);
  }
}

function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
  return url.href.replace(/\/+$/, "");
}

/** GET /api/usage/omniroute/pricing: the gateway's prices for a chat's cost estimate, `null` when there are none. */
export async function handleOmniRoutePricing(request: Request, link: OmniRouteLink): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405, { allow: "GET" });
  return jsonResponse({ prices: await link.pricing() }, 200, { "cache-control": "no-store" });
}

/** GET, PUT `{url, token?}` and DELETE on /api/usage/omniroute; only fixed words leave it. */
export async function handleOmniRouteRequest(request: Request, link: OmniRouteLink): Promise<Response> {
  const reply = (value: unknown, status = 200) => jsonResponse(value, status, { "cache-control": "no-store" });
  try {
    switch (request.method) {
      case "GET": return reply(link.status());
      case "PUT": {
        let body: unknown;
        try { body = await request.json(); } catch { throw invalid(); }
        return reply(await link.save(body));
      }
      case "DELETE": return reply(link.remove());
      default: return reply({ error: { code: "method_not_allowed", message: "Unknown OmniRoute operation" } }, 405);
    }
  } catch (error) {
    const safe = error instanceof OmniRouteError ? error : invalid();
    return reply({ error: { code: safe.code, message: safe.message } }, safe.status);
  }
}
