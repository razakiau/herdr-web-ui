/**
 * ntfy: the alerts web push sends (server/push.ts), also posted to one ntfy topic, for a phone
 * that follows the topic in the ntfy app instead of (or as well as) installing this app. The
 * deployment configures it, never a device: one topic for the whole server, with its own choice
 * of alerts, as a device's (shared/notify-policy.ts AlertPrefs). It rides web push's schedule:
 * the same delays, the same call-off when the pane moves on, and nothing while a window of the
 * app is in use.
 *
 *   HERDR_WEB_NTFY_URL         the ntfy server (https://ntfy.sh, or your own)       required
 *   HERDR_WEB_NTFY_TOPIC       the topic                                             required
 *   HERDR_WEB_NTFY_TOKEN       an access token (tk_…), or HERDR_WEB_NTFY_TOKEN_FILE  optional
 *   HERDR_WEB_NTFY_CLICK_URL   this app's address: a tap opens the pane there        optional
 *   HERDR_WEB_NTFY_ICON        an image URL the phone shows beside each alert        optional
 *   HERDR_WEB_NTFY_INPUT       on|off: an agent waiting on you (default on)
 *   HERDR_WEB_NTFY_DONE        off|long|always: a finished turn (default long)
 */
import { readFileSync } from "node:fs";

import type { AgentStatus } from "../shared/protocol.ts";
import { type AlertPrefs, DEFAULT_ALERTS, parseAlerts } from "../shared/notify-policy.ts";

const NTFY_TIMEOUT_MS = 10_000;

export interface NtfyConfig {
  url: string;
  topic: string;
  token: string | null;
  click: string | null;
  /** the phone fetches it itself: a public http(s) address */
  icon: string | null;
  alerts: AlertPrefs;
}

const httpUrl = (name: string, value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${name} must be http(s): ${parsed.protocol}`);
  return value;
};

/** null: not configured. Throws on a URL (or icon) that is not http(s), so a typo fails the start, not every alert. */
export function ntfyFromEnv(env: Readonly<Record<string, string | undefined>>): NtfyConfig | null {
  const url = env["HERDR_WEB_NTFY_URL"]?.trim();
  const topic = env["HERDR_WEB_NTFY_TOPIC"]?.trim();
  if (!url || !topic) return null;
  httpUrl("HERDR_WEB_NTFY_URL", url);
  const icon = env["HERDR_WEB_NTFY_ICON"]?.trim();
  const file = env["HERDR_WEB_NTFY_TOKEN_FILE"]?.trim();
  const token = (file ? readFileSync(file, "utf8") : env["HERDR_WEB_NTFY_TOKEN"] ?? "").trim();
  const click = env["HERDR_WEB_NTFY_CLICK_URL"]?.trim();
  const input = env["HERDR_WEB_NTFY_INPUT"]?.trim();
  return {
    url: url.replace(/\/+$/, ""),
    topic,
    token: token || null,
    click: click ? click.replace(/\/+$/, "") : null,
    icon: icon ? httpUrl("HERDR_WEB_NTFY_ICON", icon) : null,
    alerts: parseAlerts({ input: input === "off" ? false : input === "on" ? true : DEFAULT_ALERTS.input, done: env["HERDR_WEB_NTFY_DONE"]?.trim() }),
  };
}

/** What one alert says, and where its tap lands. */
export interface NtfyAlert {
  title: string;
  status: AgentStatus | "ended" | "error";
  body: string;
  machineId: string;
  /** a pane's alert names the pane; a host chat's names its session instead */
  paneId?: string;
  session?: string;
  workspaceId?: string;
}

const PRIORITY: Partial<Record<string, number>> = { blocked: 4 };
const TAGS: Partial<Record<string, string>> = { blocked: "question", done: "white_check_mark", ended: "stop_sign", error: "x" };

/** The app's address for the pane or the chat, as a tapped web push opens it (public/sw.js, src/lib/deepLink.ts). */
function clickFor(base: string, alert: NtfyAlert): string {
  const query = new URLSearchParams();
  if (alert.machineId !== "local") query.set("machine", alert.machineId);
  if (alert.session !== undefined) query.set("chat", alert.session);
  else {
    if (alert.workspaceId) query.set("ws", alert.workspaceId);
    query.set("pane", alert.paneId ?? "");
    query.set("view", "chat");
  }
  return `${base}/?${query.toString()}`;
}

/** One post to the topic (ntfy's JSON publish: POST to the server's root). Never throws. */
export async function postNtfy(config: NtfyConfig, alert: NtfyAlert): Promise<boolean> {
  const tag = TAGS[alert.status];
  const body = {
    topic: config.topic,
    title: alert.title,
    message: alert.body,
    priority: PRIORITY[alert.status] ?? 3,
    ...(tag ? { tags: [tag] } : {}),
    ...(config.click ? { click: clickFor(config.click, alert) } : {}),
    ...(config.icon ? { icon: config.icon } : {}),
  };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    if (response.ok) return true;
    console.error(`ntfy: ${new URL(config.url).host} refused the alert: ${response.status}`);
  } catch (error) {
    console.error(`ntfy: ${new URL(config.url).host} unreachable (${error instanceof Error ? error.name : "error"})`);
  }
  return false;
}
