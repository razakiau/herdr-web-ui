/** The subscriptions whose plan limits GET /api/usage can read from a CLI's own sign-in. */
export type UsageProviderId = "claude" | "codex" | "cursor" | "copilot" | "grok" | "antigravity" | "opencode";
/** A provider herdr reads itself, or another an OmniRoute gateway reports ("glm", "kimi-coding"): lowercase, digits and dashes. */
export type UsageProviderName = UsageProviderId | (string & {});

/** One limit of a plan: how much of it is used and when it starts over. */
export interface UsageWindow {
  /** the span the limit counts over: a rolling session (5 hours), a day, a week or a billing month */
  readonly kind: "session" | "day" | "week" | "month";
  /** the model or quota a plan limits on its own ("Sonnet", "Premium"); null for the plan-wide limit */
  readonly scope: string | null;
  /** 0 to 100 */
  readonly used_percent: number;
  /** ISO 8601; null when the provider does not say */
  readonly resets_at: string | null;
  /** ISO 8601 time this window began counting; null when the provider states neither it nor the window's length */
  readonly starts_at: string | null;
}

/**
 * Why a provider's numbers are missing or old: its sign-in expired or was refused; the provider
 * asked to slow down; the request failed; the macOS keychain holding the sign-in could not be
 * read from this server's session.
 */
export type UsageProblem = "expired" | "rate_limited" | "failed" | "locked";

export interface ProviderUsage {
  readonly id: UsageProviderName;
  /**
   * One account of one provider, stable across reads: the provider and its account id, or, for a
   * sign-in that does not say whose it is, the provider and where it was found. A PC signed in to
   * two accounts of one provider lists both.
   */
  readonly key: string;
  /** whose plan this is, as its owner knows the account: an email, or a GitHub login; null when unknown */
  readonly account: string | null;
  /** the plan's name as the provider states it ("max", "pro"), when it does */
  readonly plan: string | null;
  /** the last numbers read; kept through a later failure, which `problem` then names */
  readonly windows: readonly UsageWindow[];
  readonly problem: UsageProblem | null;
  /** ISO 8601 time `windows` were read; null when they never were */
  readonly checked_at: string | null;
}

/** GET /api/usage: only providers a CLI on this PC is signed in to are listed, once per account. */
export interface UsageReport {
  readonly providers: readonly ProviderUsage[];
}

/**
 * An OmniRoute gateway this server reads plan limits from (HERDR_WEB_OMNIROUTE_URL and _TOKEN in
 * its environment, else saved from Settings): its accounts are in /api/usage, keyed
 * `<provider>:omniroute:<connection>`.
 */
export interface OmniRouteStatus {
  readonly configured: boolean;
  /** env: the server's environment, which Settings cannot change; saved: from Settings; null when not configured */
  readonly source: "env" | "saved" | null;
  /** null when not configured */
  readonly url: string | null;
  readonly ok: boolean;
  readonly problem: string | null;
  /** ISO 8601 time the gateway last answered */
  readonly checked_at: string | null;
}

/** A model's list price, USD per million tokens, as OmniRoute prices it; `cached` when cache reads cost less. */
export interface ModelPrice { input: number; output: number; cached?: number }
/** By provider (OmniRoute's ids: cc, gh, anthropic, openai…), then model. */
export type ModelPrices = Record<string, Record<string, ModelPrice>>;
