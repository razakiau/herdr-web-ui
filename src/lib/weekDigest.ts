/**
 * The weekly cost digest in the page (ZAC-262): the saved weeks (GET /api/costs/digests, newest
 * first, each the snapshot the notification was built from) and which one the "This week" page
 * shows. Three ways open it: the digest's push or ntfy tap (`?digest=<week>` on a cold start, an
 * `open-digest` message from public/sw.js to an open window) and the Costs sheet's "This week"
 * link. One store outside React, so App draws the page wherever it was asked for.
 */
import { useSyncExternalStore } from "react";

import type { DigestSnapshot } from "../../shared/digest.ts";
import { getJson } from "./api.ts";

const WEEK = /^\d{4}-\d{2}-\d{2}$/;

/** The week an address names (`?digest=2026-10-26`, the digest's tap); null for anything else. */
export function digestFromSearch(search: string): string | null {
  const week = new URLSearchParams(search).get("digest")?.trim() ?? "";
  return WEEK.test(week) ? week : null;
}

export function fetchDigests(): Promise<DigestSnapshot[]> {
  return getJson<{ digests: DigestSnapshot[] }>("/api/costs/digests", { cache: "no-store", signal: AbortSignal.timeout(15_000) }).then((body) => body.digests);
}

/** The page's state: the saved weeks once read (null before), and the page when open (`week` null: the newest). */
export interface WeekDigestState { digests: DigestSnapshot[] | null; open: { week: string | null } | null }

export function createWeekDigest(fetcher: () => Promise<DigestSnapshot[]> = fetchDigests) {
  let state: WeekDigestState = { digests: null, open: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<WeekDigestState>): void => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  let flying: Promise<void> | null = null;
  /** read the list again: a digest saved since the page loaded shows up */
  const load = (): Promise<void> => flying ??= fetcher().then(
    // a server before the digest, or one down, has none to show
    (digests) => { flying = null; set({ digests }); },
    () => { flying = null; if (state.digests === null) set({ digests: [] }); },
  );
  return {
    read: (): WeekDigestState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    open(week: string | null): void { set({ open: { week } }); void load(); },
    close(): void { set({ open: null }); },
    /** for tests: no list, nothing open */
    reset(): void { flying = null; state = { digests: null, open: null }; },
  };
}

export const weekDigest = createWeekDigest();

export function useWeekDigest(): WeekDigestState {
  return useSyncExternalStore(weekDigest.subscribe, weekDigest.read, weekDigest.read);
}
