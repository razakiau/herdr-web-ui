/**
 * The cold-cache alert's reading of a PC's chat cost logs (ZAC-260): one read at a time, at most
 * one per interval, and none while nobody wants the alert. A read can be a slow one (the bridge's
 * first scan of the logs), so a tick that finds one still running is skipped, never queued. Nothing
 * else starts a read: a list change (a streaming turn fires many) waits for the next tick, which
 * leaves the alert at worst one interval late against its 10 minute lead.
 */
export interface CostsPoller {
  /** starts the ticks, with a first read now */
  start(): void;
  stop(): void;
  /** Tests: the read in flight, if any. */
  idle(): Promise<void>;
}

export function createCostsPoller({ intervalMs, wanted, read }: {
  intervalMs: number;
  /** whether a device or the ntfy topic wants the alert (server/push.ts wantsCold) */
  wanted: () => boolean;
  read: () => Promise<void>;
}): CostsPoller {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  const tick = (): void => {
    if (inFlight || !wanted()) return;
    inFlight = read().catch(() => { /* the next tick tries again */ }).finally(() => { inFlight = null; });
  };
  return {
    start() {
      clearInterval(timer);
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() { clearInterval(timer); timer = undefined; },
    idle: () => inFlight ?? Promise.resolve(),
  };
}
