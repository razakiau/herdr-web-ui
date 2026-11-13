import { badRequest, readJsonObject } from "./http.ts";

/**
 * Pages of the app that are on screen and focused, as each says over `POST /api/presence`
 * (src/lib/presence.ts), whether or not it has a PC's WebSocket open. The WebSocket's own
 * `presence` frame only comes from a page showing a terminal, so a phone reading host chats
 * never held the alerts back: it showed an in-app alert and ntfy rang as well (ZAC-207).
 *
 * A page says so again every HEARTBEAT while it stays in use; one that goes quiet for `ttl`
 * (closed, killed, offline) no longer counts, so a page that vanished cannot mute alerts.
 */
export class PagePresence {
  private readonly pages = new Map<string, number>();

  constructor(private readonly ttl = 45_000, private readonly now: () => number = Date.now) {}

  set(page: string, active: boolean): void {
    if (active) this.pages.set(page, this.now() + this.ttl);
    else this.pages.delete(page);
  }

  /** whether any page is in use now; expired pages are dropped as they are found */
  inUse(): boolean {
    const now = this.now();
    for (const [page, until] of this.pages) {
      if (until > now) return true;
      this.pages.delete(page);
    }
    return false;
  }
}

const PAGE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** POST /api/presence { page, active } -> 204: one page of the app says it is (or is no longer) in use. */
export async function handlePresenceRequest(request: Request, presence: PagePresence): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", `${request.method} is not supported on /api/presence`);
  const body = await readJsonObject<{ page?: unknown; active?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body.page !== "string" || !PAGE_ID.test(body.page) || typeof body.active !== "boolean") {
    return badRequest("invalid_presence", "Expected { page, active }");
  }
  presence.set(body.page, body.active);
  return new Response(null, { status: 204 });
}

/** a bridge counts a connection server's last word this long: one that goes quiet is not in use (ZAC-326) */
export const BRIDGE_PRESENCE_TTL_MS = 60_000;
/** how often a connection server says it again to each bridge while nothing changes */
export const PRESENCE_RELAY_MS = 30_000;
/** how often the connection server looks for a change to tell (a page's word also tells at once) */
export const PRESENCE_CHECK_MS = 5_000;

/**
 * Whether Ovis is in use, as a bridge with async questions sees it (ask_user_async, ZAC-326): a page
 * of its own server (`local`, PagePresence.inUse), or the connection server's last word
 * (POST /api/host-chats/presence) while it is under `ttl` old. Each word, and each `sync`, is told
 * to `tell` (AsyncAskStore.setInUse); the chats whose goal waits for the owner go to `tellWaiting`
 * (AsyncAskStore.setWaiting).
 */
export class BridgePresence {
  private remote = false;
  private heardAt = -Infinity;

  constructor(
    private readonly local: () => boolean,
    private readonly tell: (inUse: boolean) => void,
    private readonly tellWaiting: (sessions: readonly string[]) => void = () => {},
    private readonly ttl = BRIDGE_PRESENCE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  report(inUse: boolean): void {
    this.remote = inUse;
    this.heardAt = this.now();
    this.sync();
  }

  /** The chats whose goal waits for the owner, as the connection server last listed them. */
  wait(sessions: readonly string[]): void { this.tellWaiting(sessions); }

  inUse(): boolean {
    return this.local() || (this.remote && this.now() - this.heardAt < this.ttl);
  }

  sync(): void { this.tell(this.inUse()); }
}

/** the most chats a connection server lists as waiting in one word */
const MAX_WAIT = 500;

/**
 * POST /api/host-chats/presence { in_use, wait? } -> 204: the connection server says whether a page of
 * Ovis is in use, and which chats' goals wait for the owner. An older one sends no `wait`: the last
 * list stays, so a goal set to wait keeps waiting.
 */
export async function handleBridgePresenceRequest(request: Request, presence: BridgePresence): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", `${request.method} is not supported on /api/host-chats/presence`);
  const body = await readJsonObject<{ in_use?: unknown; wait?: unknown }>(request);
  if (body instanceof Response) return body;
  const wait = body.wait;
  if (typeof body.in_use !== "boolean" || (wait !== undefined && !(Array.isArray(wait) && wait.length <= MAX_WAIT && wait.every((each) => typeof each === "string")))) {
    return badRequest("invalid_presence", `Expected { in_use, wait?: up to ${MAX_WAIT} chat ids }`);
  }
  if (wait !== undefined) presence.wait(wait as string[]);
  presence.report(body.in_use);
  return new Response(null, { status: 204 });
}

export const BRIDGE_PRESENCE_PATH = "/api/host-chats/presence";

/**
 * The connection server's side (ZAC-326): it tells each connected bridge (its address and token, as
 * any /api/host-chats/ call goes) whether a page is in use and which of its chats' goals wait for
 * the owner, on each change and every PRESENCE_RELAY_MS. A bridge that did not take "not in use,
 * none waiting" (gone, older, no host chats: 404) is not asked again with it until PRESENCE_RELAY_MS
 * has passed; a refused "in use" or wait list is tried again on the next check, and a change goes at
 * once. One tick at a time.
 */
export class PresenceRelay {
  /** each URL's last word tried (`wait` as its JSON), when, and whether the bridge took it */
  private readonly told = new Map<string, { inUse: boolean; wait: string; at: number; ok: boolean }>();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: {
    inUse: () => boolean;
    targets: () => { id: string; url: string; token: string }[];
    /** the chats on that PC whose goal waits for the owner */
    waiting: (machineId: string) => string[];
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
  }) {}

  /** Tells every bridge whose last word differs or is PRESENCE_RELAY_MS old; resolves once all have answered. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.send().finally(() => { this.running = null; });
    return this.running;
  }

  private async send(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const inUse = this.deps.inUse();
    const targets = this.deps.targets();
    const urls = new Set(targets.map((target) => target.url));
    for (const url of this.told.keys()) if (!urls.has(url)) this.told.delete(url);
    await Promise.all(targets.map(async (target) => {
      const wait = this.deps.waiting(target.id);
      const waitKey = JSON.stringify(wait);
      // the same word, said or refused under PRESENCE_RELAY_MS ago, waits: a refusing bridge is not asked every check.
      // A refused "in use" or wait list does not wait: until the bridge hears it, it may answer for the user.
      const last = this.told.get(target.url);
      if (last && last.inUse === inUse && last.wait === waitKey && now - last.at < PRESENCE_RELAY_MS && (last.ok || (!inUse && wait.length === 0))) return;
      let ok = false;
      try {
        const response = await this.deps.fetch(`${target.url}${BRIDGE_PRESENCE_PATH}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body: JSON.stringify({ in_use: inUse, wait }),
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        ok = response.ok;
      } catch { /* gone: tried again after PRESENCE_RELAY_MS, or on a change */ }
      this.told.set(target.url, { inUse, wait: waitKey, at: now, ok });
    }));
  }
}

/** What the relay needs of the PC registry (server/machines.ts MachineManager). */
export interface RelayMachines {
  list(): { id: string; kind: string; state: string }[];
  endpoint(id: string): { url: string; token: string } | undefined;
}

/**
 * The connection server's relay to its connected remote PCs' bridges, or null with no PC registry.
 * Whether host chats run on this server does not matter: a remote PC's bridge runs its own, and
 * without the word it would count as away and answer while the user is looking at Ovis.
 */
export function presenceRelayFor(machines: RelayMachines | null, inUse: () => boolean, waiting: (machineId: string) => string[], fetch: (url: string, init: RequestInit) => Promise<Response>, now?: () => number): PresenceRelay | null {
  if (!machines) return null;
  return new PresenceRelay({
    inUse,
    targets: () => machines.list().flatMap((machine) => {
      if (machine.kind === "local" || machine.state !== "connected") return [];
      const endpoint = machines.endpoint(machine.id);
      return endpoint ? [{ id: machine.id, url: endpoint.url, token: endpoint.token }] : [];
    }),
    waiting,
    fetch,
    ...(now ? { now } : {}),
  });
}
