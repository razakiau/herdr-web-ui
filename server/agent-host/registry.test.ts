import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveStandalone, liveStandalones, registryDirs } from "./registry.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-agent-host-registry-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => pid === process.pid;

function entry(dir: string, name: string, body: unknown, mtimeSeconds: number): void {
  const file = join(dir, name);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  utimesSync(file, mtimeSeconds, mtimeSeconds);
}

describe("registry", () => {
  it("takes the newest live standalone entry and ignores editor entries", () => {
    const dir = tempDir();
    entry(dir, "live.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41001 }, connectionToken: "fictional-token-live", protocolVersion: "1.0.0" }, 1000);
    entry(dir, "dead.json", { schemaVersion: 1, type: "standalone", pid: 999999, endpoint: { type: "tcp", host: "127.0.0.1", port: 41002 }, connectionToken: "fictional-token-dead", protocolVersion: "1.0.0" }, 3000);
    // newest of all, live pid, but an editor's own host: never ours
    entry(dir, "editor.json", { schemaVersion: 1, type: "editor", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41003 }, connectionToken: "fictional-token-editor", protocolVersion: "1.0.0" }, 4000);
    entry(dir, "socket.json", { schemaVersion: 1, type: "editor", pid: process.pid, endpoint: { type: "socket", path: "/tmp/fictional.sock" }, connectionToken: "fictional-token-socket", protocolVersion: "1.0.0" }, 5000);
    const found = liveStandalone([dir], alive);
    expect(found?.port).toBe(41001);
    expect(found).toEqual({ pid: process.pid, host: "127.0.0.1", port: 41001, token: "fictional-token-live", protocol: "1.0.0", file: join(dir, "live.json") });
  });

  it("prefers the newer of two live standalone entries", () => {
    const dir = tempDir();
    entry(dir, "old.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41011 }, connectionToken: "fictional-a" }, 1000);
    entry(dir, "new.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41012 }, connectionToken: "fictional-b" }, 2000);
    const found = liveStandalone([dir], alive);
    expect(found?.port).toBe(41012);
    expect(found?.protocol).toBeNull();
  });

  it("liveStandalones lists every live standalone entry, newest first", () => {
    const dir = tempDir();
    entry(dir, "a.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41031 }, connectionToken: "fictional-a" }, 1000);
    entry(dir, "c.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41033 }, connectionToken: "fictional-c" }, 3000);
    entry(dir, "dead.json", { schemaVersion: 1, type: "standalone", pid: 999999, endpoint: { type: "tcp", host: "127.0.0.1", port: 41034 }, connectionToken: "fictional-d" }, 4000);
    entry(dir, "b.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41032 }, connectionToken: "fictional-b" }, 2000);
    expect(liveStandalones([dir], alive).map((found) => found.port)).toEqual([41033, 41032, 41031]);
    expect(liveStandalones([join(dir, "missing")], alive)).toEqual([]);
  });

  it("a malformed entry is skipped, not thrown", () => {
    const dir = tempDir();
    entry(dir, "broken.json", "{not json", 3000);
    entry(dir, "wrong-shape.json", { type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: "nope" } }, 2500);
    entry(dir, "good.json", { schemaVersion: 1, type: "standalone", pid: process.pid, endpoint: { type: "tcp", host: "127.0.0.1", port: 41021 }, connectionToken: "fictional-c", protocolVersion: "1.0.0" }, 1000);
    expect(liveStandalone([dir], alive)?.port).toBe(41021);
    expect(liveStandalone([join(dir, "missing")], alive)).toBeNull();
  });

  it("Windows has no registry dirs", () => {
    expect(registryDirs("/h", "win32", {})).toEqual([]);
  });

  it("macOS reads Application Support", () => {
    expect(registryDirs("/h", "darwin", {})).toEqual(["/h/Library/Application Support/Code/agent-host/local-endpoint/entries"]);
  });

  it("Linux honours XDG_CONFIG_HOME", () => {
    expect(registryDirs("/h", "linux", { XDG_CONFIG_HOME: "/x/cfg" })).toEqual(["/x/cfg/Code/agent-host/local-endpoint/entries"]);
    expect(registryDirs("/h", "linux", {})).toEqual(["/h/.config/Code/agent-host/local-endpoint/entries"]);
  });
});
