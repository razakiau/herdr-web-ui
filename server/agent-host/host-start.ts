/**
 * Starting VS Code's standalone agent host when none is running, through the VS Code server CLI
 * that a Remote-SSH (or `code tunnel`) connection left in `~/.vscode-server`.
 *
 * `code-<sha> --cli-data-dir ~/.vscode-server/cli agent host` reuses a compatible supervisor that is
 * already running, so a second starter that raced us is harmless. Never pass `--replace` (it would
 * cut off the host VS Code itself is using) or `--new-instance`.
 */
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostEntry } from "./registry.ts";

const SERVER_CLI = /^code-[0-9a-f]{40}$/;
const POLL_MS = 250;
export const START_DEADLINE_MS = 30_000;

/** The newest executable `~/.vscode-server/code-<40 hex>`, or null when there is none. */
export function findServerCli(home: string): string | null {
  const dir = join(home, ".vscode-server");
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!SERVER_CLI.test(name)) continue;
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      accessSync(file, constants.X_OK);
      if (!best || stat.mtimeMs > best.mtime) best = { file, mtime: stat.mtimeMs };
    } catch { continue; }
  }
  return best?.file ?? null;
}

export interface StartHostDeps {
  spawn: (argv: string[]) => void;
  poll: () => HostEntry | null;
  deadlineMs: number;
  /** Tests only: an injected clock and sleep, so the deadline test never waits. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** True once the caller gave up (the bridge is stopping): the poll ends at once with null. */
  aborted?: () => boolean;
}

/** Spawns `agent host` detached, then polls for its registry entry until the deadline or an abort: the entry, or null. */
export async function startHost(cli: string, deps: StartHostDeps): Promise<HostEntry | null> {
  const now = deps.now ?? Date.now;
  const sleep: (ms: number) => Promise<void> = deps.sleep ?? Bun.sleep;
  const aborted = deps.aborted ?? (() => false);
  const deadline = now() + (deps.deadlineMs > 0 ? deps.deadlineMs : START_DEADLINE_MS);
  if (aborted()) return null;
  try {
    deps.spawn([cli, "--cli-data-dir", join(dirname(cli), "cli"), "agent", "host"]);
  } catch {
    return null;
  }
  for (;;) {
    if (aborted()) return null;
    const entry = deps.poll();
    if (entry) return entry;
    if (now() >= deadline) return null;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
}
