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
