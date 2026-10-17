import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findServerCli, startHost } from "./host-start.ts";
import type { HostEntry } from "./registry.ts";

const dirs: string[] = [];
const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-vscode-home-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function cli(home: string, name: string, mtimeSeconds: number, mode = 0o755): string {
  const file = join(home, ".vscode-server", name);
  mkdirSync(join(home, ".vscode-server"), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

const ENTRY: HostEntry = { pid: 4242, host: "127.0.0.1", port: 41100, token: "fictional-token", protocol: "1.0.0", file: "/tmp/fictional-entry.json" };

describe("host start", () => {
  it("findServerCli picks the newest code-<sha> and ignores code-insiders and short names", () => {
    const home = tempHome();
    expect(findServerCli(home)).toBeNull();
    cli(home, `code-${SHA_A}`, 1000);
    const newest = cli(home, `code-${SHA_B}`, 2000);
    cli(home, `code-${SHA_C}`, 5000, 0o644); // not executable
    cli(home, "code-insiders", 6000);
    cli(home, "code-abc123", 7000);
    cli(home, `code-insiders-${SHA_A}`, 8000);
    expect(findServerCli(home)).toBe(newest);
  });

  it("startHost spawns agent host without --replace and returns the entry the poll finds", async () => {
    const spawned: string[][] = [];
    let polls = 0;
    const found = await startHost("/fictional-home/.vscode-server/code-" + SHA_A, {
      spawn: (argv) => { spawned.push(argv); },
      poll: () => (++polls >= 3 ? ENTRY : null),
      deadlineMs: 30_000,
      sleep: async () => {},
    });
    expect(found).toEqual(ENTRY);
    expect(spawned).toHaveLength(1);
    const argv = spawned[0]!;
    expect(argv).toEqual([`/fictional-home/.vscode-server/code-${SHA_A}`, "--cli-data-dir", "/fictional-home/.vscode-server/cli", "agent", "host"]);
    expect(argv.slice(-2)).toEqual(["agent", "host"]);
    expect(argv).not.toContain("--replace");
    expect(argv).not.toContain("--new-instance");
  });

  it("startHost gives up at the deadline and returns null", async () => {
    let clock = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const found = await startHost("/fictional-home/.vscode-server/code-" + SHA_A, {
      spawn: () => {},
      poll: () => { polls += 1; return null; },
      deadlineMs: 1_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    expect(found).toBeNull();
    expect(polls).toBeGreaterThan(1);
    expect(clock).toBeGreaterThanOrEqual(1_000);
    expect(clock).toBeLessThan(1_000 + Math.max(...sleeps) + 1);
  });

  it("startHost reports a spawn that throws as null, not an exception", async () => {
    const found = await startHost("/fictional-home/.vscode-server/code-" + SHA_A, {
      spawn: () => { throw new Error("spawn failed"); },
      poll: () => ENTRY,
      deadlineMs: 1_000,
      sleep: async () => {},
    });
    expect(found).toBeNull();
  });
});
