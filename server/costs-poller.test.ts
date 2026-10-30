import { expect, it } from "bun:test";
import { createCostsPoller } from "./costs-poller.ts";

/**
 * The cold-cache alert's poll (ZAC-260 review): a slow read is never doubled, nothing reads while
 * nobody wants the alert, and only the ticks read.
 */

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("poller did not reach the expected state"); await Bun.sleep(5); }
}

it("keeps one read in flight: a tick that finds the last one still running is skipped", async () => {
  let started = 0;
  let release!: () => void;
  const poller = createCostsPoller({ intervalMs: 10, wanted: () => true, read: () => { started++; return new Promise<void>((resolve) => { release = resolve; }); } });
  poller.start();
  expect(started).toBe(1);
  await Bun.sleep(80); // fixed wait: proving several ticks pass without a second read
  expect(started).toBe(1);
  release();
  await until(() => started === 2);
  poller.stop();
  release();
});

it("reads nothing while nobody wants the alert, and starts on the next tick once someone does", async () => {
  let wanted = false;
  let reads = 0;
  const poller = createCostsPoller({ intervalMs: 10, wanted: () => wanted, read: async () => { reads++; } });
  poller.start();
  await Bun.sleep(60); // fixed wait: proving no tick reads
  expect(reads).toBe(0);
  wanted = true;
  await until(() => reads > 0);
  poller.stop();
});

it("stops reading once stopped, and outlives a read that failed", async () => {
  let reads = 0;
  const poller = createCostsPoller({ intervalMs: 10, wanted: () => true, read: async () => { reads++; throw new Error("bridge gone"); } });
  poller.start();
  await until(() => reads >= 2);
  poller.stop();
  await poller.idle();
  const after = reads;
  await Bun.sleep(50); // fixed wait: proving no tick reads after stop
  expect(reads).toBe(after);
});
