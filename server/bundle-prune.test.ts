import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_BUNDLE_VERSIONS, POSIX_BUNDLE_PRUNE } from "./remote-host.ts";

const dirs: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** a `herdr-web-ui` dir laid out as installs leave it: a `remote-vN` link to `remote-vN-<sha>` */
function layout(versions: number[]) {
  const root = mkdtempSync(join(tmpdir(), "bundle-prune-"));
  dirs.push(root);
  const base = join(root, "herdr-web-ui");
  mkdirSync(base);
  for (const n of versions) {
    const release = join(base, `remote-v${n}-${String(n).padStart(16, "a")}`);
    mkdirSync(join(release, "bin"), { recursive: true });
    writeFileSync(join(release, "bin", "payload"), "x");
    symlinkSync(release, join(base, `remote-v${n}`));
  }
  return base;
}

function prune(base: string, current: number) {
  const result = Bun.spawnSync(["sh", "-c", `set -eu; base=${JSON.stringify(base)}; current=${current}; (set +e; ${POSIX_BUNDLE_PRUNE}) || true`]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

const versionsIn = (base: string) =>
  [...new Set(readdirSync(base).flatMap((name) => /^remote-v(\d+)/.exec(name)?.[1] ?? []).map(Number))].sort((a, b) => b - a);

describe("POSIX bundle prune", () => {
  it("keeps the current version and the two before it, link and dir", () => {
    expect(KEPT_BUNDLE_VERSIONS).toBe(3);
    const base = layout([1001, 1002, 1050, 1086, 1087, 1088]);
    const output = prune(base, 1088);
    expect(versionsIn(base)).toEqual([1088, 1087, 1086]);
    for (const n of [1086, 1087, 1088]) {
      expect(lstatSync(join(base, `remote-v${n}`)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(base, `remote-v${n}`, "bin", "payload"))).toBe(true);
    }
    expect(output).toContain("pruned remote-v1001-");
    expect(output).toContain("pruned remote-v1050\n");
  });

  it("never removes a version a running process uses", () => {
    const base = layout([1001, 1002, 1086, 1087, 1088]);
    // launched the way start() launches a bridge: through the `remote-vN` link
    const script = join(base, "remote-v1002", "bin", "hold.sh");
    writeFileSync(script, "sleep 30\n");
    const child = Bun.spawn(["sh", script]);
    children.push(child);
    const deadline = Date.now() + 5_000;
    while (!Bun.spawnSync(["sh", "-c", "ps axww -o command= 2>/dev/null || ps -eo args="]).stdout.toString().includes("remote-v1002/bin/hold.sh")) {
      if (Date.now() > deadline) throw new Error("the holding process never showed in ps");
      Bun.sleepSync(50);
    }
    prune(base, 1088);
    expect(versionsIn(base)).toEqual([1088, 1087, 1086, 1002]);
    expect(existsSync(join(base, "remote-v1002", "bin", "hold.sh"))).toBe(true);
  });

  it("keeps the version just installed even when newer ones are on the PC", () => {
    const base = layout([1080, 1081, 1082, 1083, 1084]);
    prune(base, 1080);
    expect(versionsIn(base)).toEqual([1084, 1083, 1082, 1080]);
  });

  it("leaves staging, the lock and unversioned names alone", () => {
    const base = layout([1, 2, 3, 4]);
    for (const name of ["install.abc123", "install.lock", "remote-vx", "notes"]) mkdirSync(join(base, name));
    prune(base, 4);
    expect(readdirSync(base).sort()).toEqual(
      ["install.abc123", "install.lock", "notes", "remote-v2", "remote-v2-aaaaaaaaaaaaaaa2", "remote-v3", "remote-v3-aaaaaaaaaaaaaaa3", "remote-v4", "remote-v4-aaaaaaaaaaaaaaa4", "remote-vx"],
    );
  });

  it("does nothing on a PC with no bundle", () => {
    const base = layout([]);
    expect(prune(base, 1088)).toBe("");
    expect(readdirSync(base)).toEqual([]);
  });
});
