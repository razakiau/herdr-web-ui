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

/** One conversation the plugin tracks: every sized main-agent chat since ZAC-267 (only big ones before). */
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
  /** its restart costs at least the threshold, so it is kept by default; absent from a plugin before ZAC-267 (all keys were big) */
  big?: boolean;
  /** under the threshold, turned on by the owner (settings.forced, ZAC-267) */
  forced?: boolean;
  /** what a ping reading the whole cache costs (0: no price known) */
  pingUsd?: number;
  /** over an hour since its last call or ping: the cache is gone, and it is not kept until its next call (ZAC-267) */
  expired?: boolean;
  /** why kept is false: "fuse" when the daily ping limit is hit (ZAC-275) */
  fuseReason?: string | null;
}

export interface KeepWarmToday { day: string; pings: number; usd: number; avoided: number; avoidedUsd: number; fuseHit: boolean }

/** One finished UTC day's pings and what they saved, as the plugin's `rollDay` keeps it (ZAC-262, the weekly digest). */
export interface KeepWarmDay { day: string; pings: number; usd: number; avoided: number; avoidedUsd: number }

export interface KeepWarmState {
  v: 1; at: number; enabled: boolean; windowHours: number; fusePerDay: number; idleMin: number; thresholdUsd: number;
  /** the plugin has its OmniRoute key: without it no ping can go */
  available: boolean;
  problem: string | null;
  today: KeepWarmToday;
  keys: KeepWarmKey[];
  /** the last 14 finished UTC days, oldest first; [] from a plugin before ZAC-262 (a day missing counts as 0) */
  history?: KeepWarmDay[];
}

/**
 * One chat's own window, set from the window-end alert ("Keep 8 h more", "Let it cool"): for the
 * real call at `from` only (the plugin drops it at the chat's next call), until `until` (ms).
 */
export interface KeepWarmWindow { from: number; until: number }

/** What the owner sets, from Ovis: the plugin reads it at its next sync (within a minute). */
export interface KeepWarmSettings {
  enabled?: boolean; windowHours?: number; fusePerDay?: number; disabled?: string[];
  /** chats under the threshold the owner keeps warm anyway (ZAC-267); `disabled` wins */
  forced?: string[];
  extend?: Record<string, KeepWarmWindow>;
  /**
   * The keys archiving turned off (ZAC-271), each with its chat (archivedChatRef): restoring that
   * chat gives them back the default. The plugin ignores it.
   */
  archived?: Record<string, string>;
}

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
  const history = (Array.isArray(state.history) ? state.history : []).filter((each): each is KeepWarmDay => !!each && typeof each === "object"
    && typeof each.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(each.day) && num(each.pings) && num(each.usd) && num(each.avoided) && num(each.avoidedUsd));
  return { ...state, keys, history } as KeepWarmState;
}

/** The settings as stored, with anything malformed dropped. */
export function keepWarmSettingsFrom(raw: unknown): KeepWarmSettings {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const settings: KeepWarmSettings = {};
  if (typeof value["enabled"] === "boolean") settings.enabled = value["enabled"];
  if (num(value["windowHours"]) && value["windowHours"] > 0) settings.windowHours = Math.min(KEEP_WARM_WINDOW_HOURS_MAX, value["windowHours"]);
  if (num(value["fusePerDay"]) && value["fusePerDay"] > 0) settings.fusePerDay = Math.min(KEEP_WARM_FUSE_MAX, Math.floor(value["fusePerDay"]));
  const keys = (raw: unknown): string[] | undefined => Array.isArray(raw) ? [...new Set(raw.filter((each): each is string => typeof each === "string" && each.length <= 64))].slice(0, 500) : undefined;
  const disabled = keys(value["disabled"]);
  if (disabled) settings.disabled = disabled;
  const forced = keys(value["forced"]);
  if (forced) settings.forced = forced;
  const extend = value["extend"];
  if (extend && typeof extend === "object" && !Array.isArray(extend)) {
    const windows = Object.entries(extend as Record<string, unknown>).flatMap(([key, each]): [string, KeepWarmWindow][] => {
      const window = each as Partial<KeepWarmWindow> | null;
      return key.length <= 64 && window && num(window.from) && num(window.until) ? [[key, { from: window.from, until: window.until }]] : [];
    }).slice(0, 500);
    if (windows.length > 0) settings.extend = Object.fromEntries(windows);
  }
  const archived = value["archived"];
  if (archived && typeof archived === "object" && !Array.isArray(archived)) {
    const chats = Object.entries(archived as Record<string, unknown>)
      .filter((entry): entry is [string, string] => entry[0].length <= 64 && typeof entry[1] === "string" && entry[1].length <= 512).slice(0, 500);
    if (chats.length > 0) settings.archived = Object.fromEntries(chats);
  }
  return settings;
}

/** A host chat as push names it, and as `archived` remembers it. */
export const archivedChatRef = (machineId: string, session: string): string => `chat:${encodeURIComponent(machineId)}:${encodeURIComponent(session)}`;

/**
 * The settings with an archived chat's key turned off (ZAC-271, owner: archiving turns the switch
 * off): in `disabled`, out of `forced`, and remembered for `chat` so restoring it undoes exactly this.
 */
export function withArchived(settings: KeepWarmSettings, key: string, chat: string, live?: ReadonlySet<string>): KeepWarmSettings {
  // an archive the plugin has since let go of (pruned an hour past its window) goes, with its `disabled`
  // entry: the lists would grow with every archive and the reader keeps 500
  const gone = new Set(Object.keys(settings.archived ?? {}).filter((each) => live !== undefined && each !== key && !live.has(each)));
  const disabled = new Set((settings.disabled ?? []).filter((each) => !gone.has(each)));
  disabled.add(key);
  const archived = Object.entries(settings.archived ?? {}).filter(([each]) => !gone.has(each));
  return { ...settings, disabled: [...disabled], forced: (settings.forced ?? []).filter((each) => each !== key), archived: { ...Object.fromEntries(archived), [key]: chat } };
}

/**
 * The settings with a restored chat back on the default rules (owner: "like a new chat"): every key
 * its archive turned off leaves `disabled`, `forced` and `archived`. Null when its archive turned
 * nothing off, so there is nothing to save.
 */
export function withRestored(settings: KeepWarmSettings, chat: string): KeepWarmSettings | null {
  const keys = new Set(Object.entries(settings.archived ?? {}).filter(([, each]) => each === chat).map(([key]) => key));
  if (keys.size === 0) return null;
  const archived = Object.entries(settings.archived ?? {}).filter(([key]) => !keys.has(key));
  const extend = Object.entries(settings.extend ?? {}).filter(([key]) => !keys.has(key));
  const { archived: _, extend: __, ...rest } = settings;
  return { ...rest, ...(extend.length > 0 ? { extend: Object.fromEntries(extend) } : {}), disabled: (settings.disabled ?? []).filter((key) => !keys.has(key)), forced: (settings.forced ?? []).filter((key) => !keys.has(key)),
    ...(archived.length > 0 ? { archived: Object.fromEntries(archived) } : {}) };
}

/** How much longer "Keep 8 h more" keeps a chat warm, and the plugin's cap after its last real call (EXTEND_MAX_HOURS). */
export const KEEP_WARM_EXTEND_HOURS = 8;
export const KEEP_WARM_EXTEND_MAX_HOURS = 48;
/** How long before a kept chat's window ends its alert goes (owner's pick X, ZAC-260). */
export const KEEP_WARM_WINDOW_LEAD_MS = 15 * 60_000;

/**
 * The settings with one chat's window set for its current call: "extend" keeps it warm 8 h past
 * the end the alert announced (so a second tap on the same alert adds nothing), "cool" stops it
 * now. Windows already over for an hour are dropped: the plugin pruned their chats or moved on.
 */
export function withWindow(settings: KeepWarmSettings, key: string, from: number, announced: number, how: "extend" | "cool", now: number): KeepWarmSettings {
  const kept = Object.entries(settings.extend ?? {}).filter(([, each]) => each.until > now - 3_600_000);
  const until = how === "extend" ? Math.min(Math.max(announced, now) + KEEP_WARM_EXTEND_HOURS * 3_600_000, from + KEEP_WARM_EXTEND_MAX_HOURS * 3_600_000) : now;
  return { ...settings, extend: { ...Object.fromEntries(kept), [key]: { from, until } } };
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
    // `tokens` or `prompt`, either one: OmniRoute's prompt_tokens can leave out what the call newly
    // cached (live 2026-10-30: prompt 87 for a 27,353-token first call), and `tokens` (the larger of
    // prompt and read + write) can overshoot when the provider counts the write on top of the read
    // (live 2026-10-31: prompt 74,278, tokens 161,920, chat context 74,278: no match, no switch).
    const near = (size: number): boolean => size > 0 && Math.abs(size - context) <= Math.max(500, context * KEEP_WARM_MATCH_TOKENS);
    if (!near(key.tokens) && !near(key.prompt)) continue;
    const score = gap + (model && bare(key.model) === model ? 0 : KEEP_WARM_MATCH_MS);
    if (!best || score < best.score) best = { key, score };
  }
  return best?.key ?? null;
}

/** Kept warm at `now`: the plugin keeps it, no ping missed, and its window has not ended. */
export function keptWarm(key: KeepWarmKey | null | undefined, now: number): boolean {
  return !!key && key.kept && !key.missed && !key.disabled && now < key.until;
}
