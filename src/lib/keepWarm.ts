/**
 * Keep-warm in the page (ZAC-260 phase 2): OmniRoute's keep-warm plugin state, read from this
 * server (GET /api/usage/omniroute/keepwarm) once a minute while a list, a Cache tab or Settings
 * shows it, and the owner's switches written back (PUT). Without the plugin every view shows what
 * it showed before keep-warm (phase 1): nothing here is required.
 */
import { useEffect, useSyncExternalStore } from "react";

import { keepWarmKeyFor, keptWarm, type KeepWarmAnswer, type KeepWarmKey, type KeepWarmSettings } from "../../shared/keep-warm.ts";
import type { HostChatCost } from "../../shared/host-chats.ts";
import { getJson } from "./api.ts";

/** The plugin syncs its state once a minute: asking more often shows nothing new. */
export const KEEP_WARM_REFRESH_MS = 60_000;

const URL_PATH = "/api/usage/omniroute/keepwarm";

export function fetchKeepWarm(): Promise<KeepWarmAnswer | null> {
  return getJson<KeepWarmAnswer>(URL_PATH, { cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
}

export function saveKeepWarm(settings: KeepWarmSettings): Promise<KeepWarmAnswer> {
  return getJson<KeepWarmAnswer>(URL_PATH, { method: "PUT", cache: "no-store", body: JSON.stringify(settings), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000) });
}

const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/** The page's keep-warm answer, outside React: `want()` registers a view and returns its release. */
export function createKeepWarmFeed(fetcher: () => Promise<KeepWarmAnswer | null> = fetchKeepWarm) {
  let answer: KeepWarmAnswer | null = null;
  let wants = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flying = false;
  const listeners = new Set<() => void>();
  const emit = (next: KeepWarmAnswer | null): void => { answer = next; for (const listener of listeners) listener(); };
  const ask = (): void => {
    if (flying) return;
    flying = true;
    void fetcher().then((next) => { flying = false; if (next) emit(next); }, () => { flying = false; });
  };
  return {
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: (): KeepWarmAnswer | null => answer,
    want(): () => void {
      wants += 1;
      if (answer === null || wants === 1) ask();
      timer ??= setInterval(() => { if (!hidden()) ask(); }, KEEP_WARM_REFRESH_MS);
      return () => {
        wants -= 1;
        if (wants === 0 && timer !== null) { clearInterval(timer); timer = null; }
      };
    },
    /** what a PUT answered: shown at once, not at the next read */
    set: (next: KeepWarmAnswer): void => emit(next),
    ask,
    /** forget the answer (a test starts from none) */
    reset: (): void => emit(null),
  };
}

export const keepWarmFeed = createKeepWarmFeed();

/** The page's keep-warm answer while `on`: null while off, or until the server answers. */
export function useKeepWarm(on: boolean): KeepWarmAnswer | null {
  useEffect(() => (on ? keepWarmFeed.want() : undefined), [on]);
  const answer = useSyncExternalStore(keepWarmFeed.subscribe, keepWarmFeed.read, keepWarmFeed.read);
  return on ? answer : null;
}

/** A chat's conversation in the plugin's state, and whether it is kept warm at `now`. */
export function keepWarmFor(answer: KeepWarmAnswer | null, log: HostChatCost | undefined, now: number): { key: KeepWarmKey; kept: boolean } | null {
  if (!answer?.ok || !answer.state || !log) return null;
  const key = keepWarmKeyFor(log, answer.state.keys);
  return key ? { key, kept: keptWarm(key, now) } : null;
}

/** What the cache views take of a chat kept warm now (sessionCost's `KeptWarm`): its last ping; null when not kept (ZAC-266). */
export function keptWarmOf(found: { key: KeepWarmKey; kept: boolean } | null | undefined): { lastPingAt: number | null } | null {
  return found?.kept ? { lastPingAt: found.key.lastPingAt } : null;
}

/**
 * The settings with one chat turned on or off. A big chat (kept by default) is turned off by its key
 * in `disabled`; a small one is turned on by its key in `forced` (ZAC-267). Either way the key leaves
 * the other list, so it is never in both.
 */
export function withChat(settings: KeepWarmSettings, key: string, on: boolean, big = true): KeepWarmSettings {
  const disabled = new Set(settings.disabled ?? []);
  const forced = new Set(settings.forced ?? []);
  disabled.delete(key);
  forced.delete(key);
  if (big && !on) disabled.add(key);
  if (!big && on) forced.add(key);
  return { ...settings, disabled: [...disabled], forced: [...forced] };
}
