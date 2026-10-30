/**
 * The two buttons of the keep-warm window-end alert (ZAC-260, owner's pick X): "Keep 8 h more" and
 * "Let it cool". A button is a signed address, POST /api/keepwarm/act/<payload>.<signature>: the
 * ntfy app runs it as an http action, with no cookie and no Origin, and a service worker posts it
 * from a notification. The signature is the credential, so the route is open without sign-in
 * (server/auth.ts requiresAuth), like a rendered page's media address. What it can do is narrow:
 * set one chat's window, for the real call the alert was about, up to the plugin's 48 h cap
 * (shared/keep-warm.ts withWindow), until an hour after the announced end.
 *
 * The key is this server's own, made once in its state directory (0600).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type KeepWarmKey, keptWarm, withWindow } from "../shared/keep-warm.ts";
import { jsonResponse } from "./http.ts";
import type { OmniRouteLink } from "./omniroute.ts";
import { writePrivateState } from "./private-state.ts";

export type KeepWarmHow = "extend" | "cool";

/** What a button stands for: this chat's window, as the alert announced it, and what to do. */
export interface KeepWarmAct {
  key: string;
  /** the real call the alert was about (the plugin's lastRealAt) */
  from: number;
  /** the window's end the alert announced */
  announced: number;
  how: KeepWarmHow;
}

export const KEEP_WARM_ACT_ROUTE = /^\/api\/keepwarm\/act\/([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;
/** A button works until an hour after the end it announced: by then the cache is gone anyway. */
export const KEEP_WARM_ACT_GRACE_MS = 3_600_000;

export class KeepWarmActions {
  private secret: Buffer | null = null;

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  private key(): Buffer {
    if (this.secret) return this.secret;
    const path = join(this.stateDir, "keepwarm-actions.json");
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { secret?: unknown };
      if (typeof raw.secret === "string" && raw.secret.length >= 43) return (this.secret = Buffer.from(raw.secret, "base64url"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const secret = randomBytes(32);
    writePrivateState(path, { secret: secret.toString("base64url") });
    return (this.secret = secret);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key()).update(`keepwarm-act:${payload}`).digest("base64url");
  }

  /** The button's path, `/api/keepwarm/act/...`: prefix it with the app's public address for ntfy. */
  path(act: KeepWarmAct): string {
    const payload = Buffer.from(JSON.stringify([act.key, act.from, act.announced, act.how])).toString("base64url");
    return `/api/keepwarm/act/${payload}.${this.sign(payload)}`;
  }

  /** The act a path stands for, or null: not one of ours, altered, or past its grace. */
  read(pathname: string): KeepWarmAct | null {
    const match = KEEP_WARM_ACT_ROUTE.exec(pathname);
    if (!match) return null;
    const [, payload, signature] = match as unknown as [string, string, string];
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [key, from, announced, how] = value as unknown[];
    if (typeof key !== "string" || typeof from !== "number" || typeof announced !== "number" || (how !== "extend" && how !== "cool")) return null;
    if (this.now() > announced + KEEP_WARM_ACT_GRACE_MS) return null;
    return { key, from, announced, how };
  }
}

/**
 * POST /api/keepwarm/act/<signed>: sets the chat's window and answers its new end. 404 for an
 * address that is not a live button (forged, altered, expired); 409 once the chat moved on (a new
 * real call: the plugin already started a new window for it), or keep-warm lost it.
 */
export async function handleKeepWarmAct(request: Request, pathname: string, actions: KeepWarmActions, link: Pick<OmniRouteLink, "keepWarm" | "saveKeepWarm">, now: () => number = Date.now): Promise<Response> {
  const reply = (value: unknown, status = 200) => jsonResponse(value, status, { "cache-control": "no-store" });
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  const act = actions.read(pathname);
  if (!act) return reply({ error: { code: "not_found", message: "This button has expired" } }, 404);
  const answer = await link.keepWarm(true);
  const current = answer.state?.keys.find((each) => each.key === act.key);
  if (!answer.ok || !current) return reply({ error: { code: "keepwarm_gone", message: "Keep-warm no longer follows this chat" } }, 409);
  if (current.lastRealAt !== act.from) return reply({ error: { code: "chat_moved_on", message: "You wrote to this chat since" } }, 409);
  try {
    const saved = await link.saveKeepWarm(withWindow(answer.settings, act.key, act.from, act.announced, act.how, now()));
    return reply({ ok: true, until: saved.settings.extend?.[act.key]?.until ?? null });
  } catch {
    return reply({ error: { code: "keepwarm_unavailable", message: "Keep-warm is unavailable" } }, 502);
  }
}

/**
 * An archived chat's "Let it cool" (ZAC-262), as the button saves it: the plugin is read again
 * first, so a window let go since is left as it is, and the save keeps the owner's other settings.
 * False when that read cannot vouch for the call push matched (no answer, the key gone, or a newer
 * real call: push's cached read lagged), so push looks again at its next poll; a failed save throws.
 */
export async function coolArchivedChat(key: KeepWarmKey, link: Pick<OmniRouteLink, "keepWarm" | "saveKeepWarm">, now: () => number = Date.now): Promise<boolean> {
  const answer = await link.keepWarm(true);
  const current = answer.state?.keys.find((each) => each.key === key.key);
  if (!answer.ok || !current || current.lastRealAt !== key.lastRealAt) return false;
  const at = now();
  if (!keptWarm(current, at)) return true;
  await link.saveKeepWarm(withWindow(answer.settings, key.key, key.lastRealAt, at, "cool", at));
  return true;
}
