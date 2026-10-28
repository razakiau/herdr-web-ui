import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readProcessBirth } from "./process-owner.ts";
import { posixAliveScript, windowsAliveScript } from "./remote-host.ts";

// The scripts run on the remote PC; here they run on this machine against real processes, the way
// a rebuilt container hands a dead bridge's PID to another process (Coder workspace, 2026-10-28).
const posix = process.platform !== "win32";
const children: Bun.Subprocess[] = [];
afterEach(async () => { for (const c of children.splice(0)) { c.kill(); await c.exited; } });

function spawnOther(): number {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child.pid;
}
function birthOf(pid: number) {
  const reading = readProcessBirth(pid);
  if (reading.state !== "identified") throw new Error(`no birth for ${pid}`);
  return reading.birth;
}
const run = (script: string) => Bun.spawnSync(["/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
/** A well-formed birth of this platform that no running process has. */
const otherBirth = () => ({ platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : "Thu Jan 1 00:00:00 1970" });

describe.if(posix)("posixAliveScript", () => {
  it("is live for the process the descriptor recorded", () => {
    const pid = spawnOther();
    expect(run(posixAliveScript({ pid, birth: birthOf(pid) }))).toBe("live");
  });
  it("is not live when another process holds the recorded PID", () => {
    const pid = spawnOther();
    expect(run(posixAliveScript({ pid, birth: otherBirth() }))).toBe("");
  });
  it("is not live for a free PID", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(run(posixAliveScript({ pid: child.pid, birth: otherBirth() }))).toBe("");
    expect(run(posixAliveScript({ pid: child.pid }))).toBe("");
  });
  it("falls back to the PID alone without a usable birth (an older bridge)", () => {
    const pid = spawnOther();
    expect(run(posixAliveScript({ pid }))).toBe("live");
    expect(run(posixAliveScript({ pid, birth: { platform: process.platform, value: "garbage" } }))).toBe("live");
    // a birth recorded on another platform cannot be compared here
    expect(run(posixAliveScript({ pid, birth: { platform: "win32", value: "1" } }))).toBe("live");
  });
  it("quotes the recorded value", () => {
    expect(posixAliveScript({ pid: 1, birth: { platform: "darwin", value: "Thu Jan 1 00:00:00 1970" } })).toContain("want='Thu Jan 1 00:00:00 1970'");
  });
});

describe("windowsAliveScript", () => {
  it("compares the CIM creation time when a win32 birth was recorded", () => {
    const script = windowsAliveScript({ pid: 4242, birth: { platform: "win32", value: "1793213263885" } });
    expect(script).toContain("ProcessId=4242");
    expect(script).toContain("-eq '1793213263885'");
  });
  it("keeps the PID-only probe without a win32 birth", () => {
    expect(windowsAliveScript({ pid: 4242 })).toBe("if (Get-Process -Id 4242 -ErrorAction SilentlyContinue) { Write-Output 'live' }");
  });
});
