/**
 * Whether this page is in use: on screen and holding the focus, the same test PaneTerminal's
 * `inUse` makes. Every PC connection tells its server (WS `presence`), and while any page is in
 * use the server sends no web push to any device (#751).
 */
export function pageInUse(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** Calls `listener` with `pageInUse()` now and again whenever focus or visibility changes. */
export function watchPageInUse(listener: (active: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const update = (): void => listener(pageInUse());
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pagehide", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", update);
    document.removeEventListener("visibilitychange", update);
  };
}

/** how often a page in use says so again: the server forgets one after 45 s of silence (server/page-presence.ts) */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Tells this server, over HTTP, whether this page is in use, now, on every change and every
 * PRESENCE_HEARTBEAT_MS while it is. A PC's WebSocket says the same, but only a page showing a
 * terminal opens one: a phone reading host chats had none, so ntfy rang while its in-app alert
 * showed (ZAC-207). Returns a stop that tells the server the page has gone.
 */
export function reportPageInUse(post: (active: boolean, page: string) => void = postPresence): () => void {
  const page = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `page-${Math.random().toString(36).slice(2, 14)}`;
  let active: boolean | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopWatching = watchPageInUse((now) => {
    if (now === active) return;
    active = now;
    post(now, page);
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (now) timer = setInterval(() => post(true, page), PRESENCE_HEARTBEAT_MS);
  });
  return () => {
    stopWatching();
    if (timer !== null) clearInterval(timer);
    if (active) post(false, page);
  };
}

function postPresence(active: boolean, page: string): void {
  void fetch("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page, active }),
    // the page may be going away: the "no longer in use" still reaches the server
    keepalive: true,
  }).catch(() => undefined);
}
