/**
 * The two buttons of the keep-warm window-end alert (ZAC-260, owner's pick X): "Keep 8 h more" and
 * "Let it cool"; and "Hand off now" on it and on the cold-cache alert (ZAC-262). A button is a signed address, POST /api/keepwarm/act/<payload>.<signature>: the
 * ntfy app runs it as an http action, with no cookie and no Origin, and a service worker posts it
 * from a notification. The signature is the credential, so the route is open without sign-in
 * (server/auth.ts requiresAuth), like a rendered page's media address. What it can do is narrow:
 * set one chat's window, for the real call the alert was about, up to the plugin's 48 h cap
 * (shared/keep-warm.ts withWindow), until an hour after the announced end; or start one chat's
 * hand-off on its PC (createHandoffFollower), until 2 h after the alert went.
 *
 * The key is this server's own, made once in its state directory (0600).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoffJob } from "../shared/host-chats.ts";
import { type KeepWarmKey, keptWarm, withArchived, withRestored, withWindow } from "../shared/keep-warm.ts";
import { jsonResponse } from "./http.ts";
import type { OmniRouteLink } from "./omniroute.ts";
import { writePrivateState } from "./private-state.ts";

/** What a window button stands for: this chat's window, as the alert announced it, and what to do. */
export interface KeepWarmAct {
  key: string;
  /** the real call the alert was about (the plugin's lastRealAt) */
  from: number;
  /** the window's end the alert announced */
  announced: number;
  how: "extend" | "cool";
}

/**
 * "Hand off now" (ZAC-262): this chat on this PC. The cold alert has no plugin window to tie it to,
 * so it carries its own end; the title is what the outcome's ntfy names the chat by.
 */
export interface HandoffAct {
  how: "handoff";
  machineId: string;
  session: string;
  title: string;
  expires: number;
  /**
   * How the PC hands it off (ZAC-266): `note` asks the chat for a `/handoff` note (chat/handoff), a
   * model call on its cache; `fresh` starts the next chat from the old one's CLI record
   * (chat/continue), so a cold chat is never woken. A link signed before ZAC-266 reads as `note`.
   */
  mode: HandoffMode;
}

export type HandoffMode = HandoffJob["mode"];

export type KeepWarmHow = KeepWarmAct["how"] | HandoffAct["how"];

/**
 * 2048: a hand-off's payload holds a session URI and a title of up to 80 characters, 4 bytes each
 * in UTF-8 when they are emoji, so ~800 base64url characters at the longest seen; a window
 * button's is under 100.
 */
export const KEEP_WARM_ACT_ROUTE = /^\/api\/keepwarm\/act\/([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
/** A button works until an hour after the end it announced: by then the cache is gone anyway. */
export const KEEP_WARM_ACT_GRACE_MS = 3_600_000;
/** "Hand off now" works until 2 h after its alert went (spec §2): a cold chat is still worth handing off for a while. */
export const HANDOFF_ACT_TTL_MS = 2 * 3_600_000;
const HANDOFF_TITLE_CHARS = 80;

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

  /**
   * A hand-off starts model calls on a PC, so it is signed in a domain of its own: a window
   * button's signature never vouches for a hand-off's payload, nor the other way (ZAC-262).
   */
  private sign(payload: string, domain: "keepwarm-act" | "keepwarm-handoff"): string {
    return createHmac("sha256", this.key()).update(`${domain}:${payload}`).digest("base64url");
  }

  /** The button's path, `/api/keepwarm/act/...`: prefix it with the app's public address for ntfy. */
  path(act: KeepWarmAct | HandoffAct): string {
    const fields = act.how === "handoff"
      ? ["h", act.machineId, act.session, Array.from(act.title).slice(0, HANDOFF_TITLE_CHARS).join(""), act.expires, act.mode]
      : [act.key, act.from, act.announced, act.how];
    const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
    return `/api/keepwarm/act/${payload}.${this.sign(payload, act.how === "handoff" ? "keepwarm-handoff" : "keepwarm-act")}`;
  }

  /** The act a path stands for, or null: not one of ours, altered, or past its grace. */
  read(pathname: string): KeepWarmAct | HandoffAct | null {
    const match = KEEP_WARM_ACT_ROUTE.exec(pathname);
    if (!match) return null;
    const [, payload, signature] = match as unknown as [string, string, string];
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    // the domain the payload's shape names: one signed for the other shape fails here
    const handoff = Array.isArray(value) && value[0] === "h";
    const expected = Buffer.from(this.sign(payload, handoff ? "keepwarm-handoff" : "keepwarm-act"));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (handoff) {
      // 5 fields: a link signed before ZAC-266, which only knew the note path
      const length = (value as unknown[]).length;
      if (length !== 5 && length !== 6) return null;
      const [, machineId, session, title, expires, mode = "note"] = value as unknown[];
      if (typeof machineId !== "string" || typeof session !== "string" || typeof title !== "string" || typeof expires !== "number") return null;
      if (mode !== "note" && mode !== "fresh") return null;
      if (this.now() > expires) return null;
      return { how: "handoff", machineId, session, title, expires, mode };
    }
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
 * real call: the plugin already started a new window for it), or keep-warm lost it. "Hand off now"
 * goes to `startHandoff` (createHandoffFollower's start), which answers at once.
 */
export async function handleKeepWarmAct(request: Request, pathname: string, actions: KeepWarmActions, link: Pick<OmniRouteLink, "keepWarm" | "saveKeepWarm">, now: () => number = Date.now,
  options: { startHandoff?: (machineId: string, session: string, title: string, mode: HandoffMode) => Promise<Response> } = {}): Promise<Response> {
  const reply = (value: unknown, status = 200) => jsonResponse(value, status, { "cache-control": "no-store" });
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  const act = actions.read(pathname);
  if (!act) return reply({ error: { code: "not_found", message: "This button has expired" } }, 404);
  if (act.how === "handoff") {
    if (!options.startHandoff) return reply({ error: { code: "handoff_unavailable", message: "This server cannot hand off" } }, 503);
    return options.startHandoff(act.machineId, act.session, act.title, act.mode);
  }
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
 * An archived chat's keep-warm, turned off (ZAC-262, ZAC-271): its window cools now, and its switch
 * goes off (`disabled`, remembered for `chat` so restoring it gives the default back). The plugin is
 * read again first, so a chat let go since is left as it is, and the save keeps the owner's other
 * settings. A chat not kept and not forced on is left alone: off already, and no write.
 * False when that read cannot vouch for the call push matched (no answer, the key gone, or a newer
 * real call: push's cached read lagged), so push looks again at its next poll; a failed save throws.
 */
export async function coolArchivedChat(key: KeepWarmKey, chat: string, link: Pick<OmniRouteLink, "keepWarm" | "saveKeepWarm">, now: () => number = Date.now): Promise<boolean> {
  const answer = await link.keepWarm(true);
  const current = answer.state?.keys.find((each) => each.key === key.key);
  if (!answer.ok || !current || current.lastRealAt !== key.lastRealAt) return false;
  const at = now();
  const forced = (answer.settings.forced ?? []).includes(key.key);
  if (!keptWarm(current, at) && !forced) return true;
  const live = new Set(answer.state!.keys.map((each) => each.key));
  await link.saveKeepWarm(withArchived(withWindow(answer.settings, key.key, key.lastRealAt, at, "cool", at), key.key, chat, live));
  return true;
}

/**
 * A restored chat's keep-warm back on the default rules (ZAC-271, owner: "like a new chat"): the
 * keys its archive turned off leave `disabled` and `archived`. Nothing to save, nothing written.
 */
export async function restoreArchivedChat(chat: string, link: Pick<OmniRouteLink, "keepWarm" | "saveKeepWarm">): Promise<boolean> {
  const answer = await link.keepWarm(true);
  if (!answer.ok) return false;
  const restored = withRestored(answer.settings, chat);
  if (restored === null) return true;
  await link.saveKeepWarm(restored);
  return true;
}

/** What a hand-off's outcome says, and which chat its tap opens (the new one once there is one). */
export interface HandoffOutcome { title: string; body: string; machineId: string; session: string }

export interface HandoffFollowerOptions {
  /**
   * one call to the PC's bridge: the POST starts the job, /api/host-chats/chat/handoff {session} for
   * `note`, chat/continue for `fresh`; the GET reads either job (chat/handoff?session=). Null: the
   * PC is not reachable (disconnected, no agent host here, the request failed)
   */
  bridge: (machineId: string, method: "POST" | "GET", session: string, mode: HandoffMode) => Promise<Response | null>;
  /** posts the outcome (an ntfy, server/ntfy.ts status `handoff`); never throws */
  tell: (outcome: HandoffOutcome) => Promise<unknown>;
  /** the PC's name for "Update the bridge on <PC>" */
  pcName: (machineId: string) => string;
  /** HANDOFF_POLL_MS; tests shorten it */
  pollMs?: number;
  now?: () => number;
}

/** How often a followed job is asked, and for how long: the bridge's own limit is 20 min for the turn, plus starting the next chat. */
export const HANDOFF_POLL_MS = 5_000;
export const HANDOFF_FOLLOW_MS = 25 * 60_000;
const ENDED = new Set<HandoffJob["state"]>(["done", "no_resume", "timeout", "failed"]);
/** A fresh hand-off's `done` (ZAC-266): no note was asked for, and the old chat is not archived. */
export const FRESH_HANDOFF_DONE_BODY = "Cold: the new chat reads the old one's record (no note written). Old chat kept.";

/**
 * "Hand off now" from an alert (ZAC-262, spec §2/§2b): the tap is answered at once (the ntfy app
 * waits on it), then the PC's bridge is asked to start the job and the job is followed until it
 * ends; one ntfy says how. A tap while that chat's job is still followed starts nothing more.
 */
export function createHandoffFollower(options: HandoffFollowerOptions) {
  const pollMs = options.pollMs ?? HANDOFF_POLL_MS;
  const now = options.now ?? Date.now;
  const following = new Map<string, Promise<void>>();
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });
  const jobOf = async (response: Response): Promise<HandoffJob | null> => {
    try {
      const { job } = await response.json() as { job?: HandoffJob };
      return job && typeof job.state === "string" ? job : null;
    } catch { return null; }
  };
  const codeOf = async (response: Response): Promise<string | null> => {
    try { return ((await response.json()) as { error?: { code?: unknown } }).error?.code as string ?? null; } catch { return null; }
  };
  const safely = async (call: Promise<Response | null>): Promise<Response | null> => { try { return await call; } catch { return null; } };

  async function follow(machineId: string, session: string, title: string, mode: HandoffMode): Promise<void> {
    const tell = (text: string, opens = session, body = title) => options.tell({ title: text, body, machineId, session: opens });
    const offline = `Couldn't hand off "${title}": its PC is offline`;
    const lost = `Lost track of the hand-off of "${title}": open the chat`;
    const started = now();
    const posted = await safely(options.bridge(machineId, "POST", session, mode));
    if (!posted || posted.status >= 500) return void await tell(offline);
    if (!posted.ok) {
      const code = await codeOf(posted);
      if (posted.status === 409) {
        if (code === "busy") return void await tell(`Couldn't hand off "${title}": it's working. Tap again when it's done.`);
        if (mode === "fresh") {
          // chat/continue's own refusals (ZAC-266): it needs /resume, the CLI record, and the folder
          if (code === "no_resume") return void await tell(`Couldn't hand off "${title}": this chat has no /resume`);
          if (code === "no_record") return void await tell(`Couldn't hand off "${title}": its record isn't on its PC`);
          if (code === "no_folder") return void await tell(`Couldn't hand off "${title}": its folder isn't on its PC`);
        }
        if (code === "no_handoff" || code === "no_folder") return void await tell(`Couldn't hand off "${title}": this chat has no /handoff`);
        if (code === "recent_handoff") return void await tell(`A hand-off of "${title}" was just written: open the chat`);
      }
      // the bridge's own refusals: host chats off there, the chat gone from it
      if (code === "host_chats_off") return void await tell(offline);
      if (code === "host_chat_missing") return void await tell(lost);
      // a bridge before this route answers its unknown-endpoint 404
      if (posted.status === 404) return void await tell(`Update the bridge on ${options.pcName(machineId)} to hand off from here`);
      return void await tell(`Hand-off of "${title}" didn't finish: open the chat`);
    }
    let job = await jobOf(posted);
    while (!stopped && job && !ENDED.has(job.state)) {
      await sleep(pollMs);
      if (stopped || now() - started > HANDOFF_FOLLOW_MS) break;
      const read = await safely(options.bridge(machineId, "GET", session, mode));
      // the PC dropped, or its bridge restarted and forgot the job (404 job_not_found)
      if (!read || read.status === 404) { job = null; break; }
      // anything else (a 502 while the host reconnects): asked again at the next poll
      if (read.ok) job = await jobOf(read) ?? job;
    }
    if (stopped) return;
    if (!job || !ENDED.has(job.state)) return void await tell(lost);
    if (job.state === "done" && job.newSession) return void await tell(`Handed off "${title}" → new chat`, job.newSession, mode === "fresh" ? FRESH_HANDOFF_DONE_BODY : title);
    if (job.state === "no_resume") return void await tell(`Hand-off note written for "${title}", but no /resume line: open the chat`);
    // timeout, failed (a new chat made but its /resume not sent: that one is opened), done without a new chat
    await tell(`Hand-off of "${title}" didn't finish: open the chat`, job.newSession ?? session);
  }

  return {
    async start(machineId: string, session: string, title: string, mode: HandoffMode): Promise<Response> {
      const key = `${machineId}\u0000${session}`;
      if (!stopped && !following.has(key)) {
        const done = follow(machineId, session, title, mode)
          .catch((error: unknown) => { console.error(`hand-off follow failed: ${error instanceof Error ? error.message : String(error)}`); })
          .finally(() => { following.delete(key); });
        following.set(key, done);
      }
      return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
    },
    /** resolves once every followed job was told (tests wait) */
    async settled(): Promise<void> {
      while (following.size > 0) await Promise.all([...following.values()]);
    },
    stop(): void { stopped = true; },
  };
}

const HANDOFF_PATH = "/api/host-chats/chat/handoff";
/** the fresh path's start (ZAC-266); its job is read at HANDOFF_PATH like a note's */
const CONTINUE_PATH = "/api/host-chats/chat/continue";

/**
 * The follower's `bridge` (ZAC-262): the chat's PC asked as the app asks it, a remote one through
 * its bridge's address and token (server/machines.ts pollCosts), this one in process
 * (agent-host/routes.ts hostChatsRoute). Null: not connected, or no agent host here.
 */
export function bridgeHandoff(deps: {
  endpoint: (machineId: string) => { url: string; token: string } | undefined;
  /** hostChatsRoute bound to this PC's agent host; null without one */
  local: ((request: Request, pathname: string) => Promise<Response> | null) | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}): HandoffFollowerOptions["bridge"] {
  return async (machineId, method, session, mode) => {
    const init: RequestInit = method === "POST"
      ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ session }) }
      : { method };
    const query = method === "GET" ? `?session=${encodeURIComponent(session)}` : "";
    const path = method === "POST" && mode === "fresh" ? CONTINUE_PATH : HANDOFF_PATH;
    if (machineId === "local") return deps.local ? deps.local(new Request(`http://local${path}${query}`, init), path) : null;
    const endpoint = deps.endpoint(machineId);
    if (!endpoint) return null;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${endpoint.token}`);
    return deps.fetch(`${endpoint.url}${path}${query}`, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  };
}
