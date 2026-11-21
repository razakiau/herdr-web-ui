/**
 * Keeps a host chat loaded for a while after its turn ends, the moment Ovis may tell the phone about
 * it. The host unloads a chat nobody watches, and the next open reloads its whole record: 5.1 s for a
 * 56 MB record against 0.02 s loaded (the Mac, 2026-11-20), before the trip to the phone even starts.
 * A held watch is a subscription like a phone's; at most WARM_MAX at once, the oldest let go first,
 * as each loaded chat costs the host memory.
 */
import type { HostChatRow } from "../../shared/host-chats.ts";

export const WARM_MS = 15 * 60_000;
export const WARM_MAX = 6;

interface WarmHost { watch(session: string): Promise<() => void> }
interface WarmClock { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export interface WarmKeeper {
  /** The chat list as it now stands: a chat whose turn just ended is held. */
  onRows(rows: readonly HostChatRow[]): void;
  /** The sessions held now, oldest first. */
  held(): string[];
  stop(): void;
}

export function createWarmKeeper(host: WarmHost, clock: WarmClock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }): WarmKeeper {
  const holds = new Map<string, { release: Promise<(() => void) | null>; timer: unknown }>();
  const was = new Map<string, HostChatRow["status"]>();
  const letGo = (session: string): void => {
    const hold = holds.get(session);
    if (!hold) return;
    holds.delete(session);
    clock.clearTimeout(hold.timer);
    void hold.release.then((release) => release?.());
  };
  const keep = (session: string): void => {
    const hold = holds.get(session);
    if (hold) {
      clock.clearTimeout(hold.timer);
      holds.delete(session);
      holds.set(session, { ...hold, timer: clock.setTimeout(() => letGo(session), WARM_MS) });
      return;
    }
    while (holds.size >= WARM_MAX) letGo(holds.keys().next().value!);
    // a watch that fails (the chat went) holds nothing
    holds.set(session, { release: host.watch(session).catch(() => null), timer: clock.setTimeout(() => letGo(session), WARM_MS) });
  };
  return {
    onRows(rows) {
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.session);
        const before = was.get(row.session);
        was.set(row.session, row.status);
        // a fork's chat lives in its session: the session's watch loads it
        if (before === "working" && row.status !== "working" && !row.archived) keep(row.fork_of ?? row.session);
      }
      for (const session of [...was.keys()]) if (!seen.has(session)) was.delete(session);
    },
    held: () => [...holds.keys()],
    stop() { for (const session of [...holds.keys()]) letGo(session); },
  };
}
