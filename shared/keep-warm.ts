/**
 * Keep-warm (ZAC-260 phase 2): the OmniRoute plugin on CT 204 (zhomelab
 * ansible/roles/omniroute/files/plugins/keep-warm) resends a big idle chat's last request every
 * ~55 min with a 1-token answer, so its prompt cache stays warm. It publishes what it keeps in its
 * own plugin config (`state`), and reads the owner's switches from it (`settings`).
 *
 * The plugin sees requests, not chats: it knows a conversation by a hash of its key name, system
 * prompt and first user message. Ovis matches a chat to one by what both sides log of the last
 * call: its prompt size and its time.
 */

/** One conversation the plugin tracks: only a big one (cold restart at least its threshold). */
export interface KeepWarmKey {
  key: string; model: string; apiKey: string;
  /** what the cache holds after the last real call (prompt, or read + write) */
  tokens: number;
  /** the last real call's prompt tokens, as OmniRoute's usage gives them */
  prompt: number;
  /** when the last real call reached OmniRoute (ms) */
  lastRealAt: number;
  lastPingAt: number | null;
  /** the next ping, while kept warm */
  nextPingAt: number | null;
  /** when keep-warm stops for this chat: windowHours after its last real call (ms) */
  until: number;
  /** today's pings for this chat, and what they cost */
  pings: number; usd: number;
  /** what a cold restart would cost now */
  restartUsd: number;
  /** a ping read nothing back (or failed twice): the cache is gone, pings stopped until a real call */
  missed: boolean;
  /** turned off by the owner (settings.disabled) */
  disabled: boolean;
  /** kept warm now */
  kept: boolean;
}

export interface KeepWarmToday { day: string; pings: number; usd: number; avoided: number; avoidedUsd: number; fuseHit: boolean }

export interface KeepWarmState {
  v: 1; at: number; enabled: boolean; windowHours: number; fusePerDay: number; idleMin: number; thresholdUsd: number;
  /** the plugin has its OmniRoute key: without it no ping can go */
  available: boolean;
  problem: string | null;
  today: KeepWarmToday;
  keys: KeepWarmKey[];
}

/** What the owner sets, from Ovis: the plugin reads it at its next sync (within a minute). */
export interface KeepWarmSettings { enabled?: boolean; windowHours?: number; fusePerDay?: number; disabled?: string[] }

/** What GET /api/keepwarm answers: the plugin's state, or why there is none (keep-warm unavailable). */
export interface KeepWarmAnswer {
  /** false: no gateway set, the plugin is not installed, or it could not be read */
  ok: boolean;
  state: KeepWarmState | null;
  settings: KeepWarmSettings;
  /** Ovis can change the settings (a write token is set) */
  writable: boolean;
  problem: string | null;
}

export const KEEP_WARM_WINDOW_HOURS_MAX = 24;
export const KEEP_WARM_FUSE_MAX = 1000;

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The plugin's state as it came over the wire, or null when it is not one (a plugin before v1). */
export function keepWarmStateFrom(raw: unknown): KeepWarmState | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<KeepWarmState>;
  if (state.v !== 1 || !Array.isArray(state.keys) || !state.today || typeof state.today !== "object") return null;
  const keys = state.keys.filter((each): each is KeepWarmKey => !!each && typeof each === "object"
    && typeof each.key === "string" && num(each.lastRealAt) && num(each.until) && num(each.prompt));
  return { ...state, keys } as KeepWarmState;
}

/** The settings as stored, with anything malformed dropped. */
export function keepWarmSettingsFrom(raw: unknown): KeepWarmSettings {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const settings: KeepWarmSettings = {};
  if (typeof value["enabled"] === "boolean") settings.enabled = value["enabled"];
  if (num(value["windowHours"]) && value["windowHours"] > 0) settings.windowHours = Math.min(KEEP_WARM_WINDOW_HOURS_MAX, value["windowHours"]);
  if (num(value["fusePerDay"]) && value["fusePerDay"] > 0) settings.fusePerDay = Math.min(KEEP_WARM_FUSE_MAX, Math.floor(value["fusePerDay"]));
  if (Array.isArray(value["disabled"])) settings.disabled = [...new Set(value["disabled"].filter((each): each is string => typeof each === "string" && each.length <= 64))].slice(0, 500);
  return settings;
}

/**
 * How far the CLI's log time of a call (the answer, written once it ends) may be from the plugin's
 * (the request, as it reaches OmniRoute): a long answer streams for minutes.
 */
export const KEEP_WARM_MATCH_MS = 10 * 60_000;
/** How far the two prompt counts may be: the same call, counted by the CLI and by the provider. */
export const KEEP_WARM_MATCH_TOKENS = 0.02;

const bare = (model: string): string => (model.split("/").at(-1) ?? model).toLowerCase().replace(/[._]/g, "-");

/**
 * The plugin's conversation for a chat: the one whose last real call has the chat's prompt size
 * (within 2%) at the chat's last call (within 10 min), the closest in time; a same-model one wins a
 * tie. Null when none fits: the chat is not one the plugin keeps (another key, a small chat, a
 * sub-agent's), or the plugin has not seen its last call yet.
 */
export function keepWarmKeyFor(
  chat: { lastCallAt: string | null; context: number | null; lastModel?: string | null },
  keys: readonly KeepWarmKey[],
): KeepWarmKey | null {
  const at = Date.parse(chat.lastCallAt ?? "");
  const context = chat.context ?? 0;
  if (!Number.isFinite(at) || context <= 0) return null;
  const model = chat.lastModel ? bare(chat.lastModel) : null;
  let best: { key: KeepWarmKey; score: number } | null = null;
  for (const key of keys) {
    const gap = Math.abs(key.lastRealAt - at);
    if (gap > KEEP_WARM_MATCH_MS) continue;
    if (Math.abs(key.prompt - context) > Math.max(500, context * KEEP_WARM_MATCH_TOKENS)) continue;
    const score = gap + (model && bare(key.model) === model ? 0 : KEEP_WARM_MATCH_MS);
    if (!best || score < best.score) best = { key, score };
  }
  return best?.key ?? null;
}

/** Kept warm at `now`: the plugin keeps it, no ping missed, and its window has not ended. */
export function keptWarm(key: KeepWarmKey | null | undefined, now: number): boolean {
  return !!key && key.kept && !key.missed && !key.disabled && now < key.until;
}
