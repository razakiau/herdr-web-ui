/**
 * VS Code's local agent-host endpoint registry: one JSON file per running host, written by VS Code
 * under `Code/agent-host/local-endpoint/entries`. Only `standalone` hosts are ours to talk to; an
 * `editor` entry is a window's own in-process host, which goes away with the window.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HostEntry { pid: number; host: string; port: number; token: string; protocol: string | null; file: string }

const ENTRIES = ["Code", "agent-host", "local-endpoint", "entries"];

/** Where VS Code writes its registry entries on this platform; none on Windows (unsupported). */
export function registryDirs(home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === "darwin") return [join(home, "Library", "Application Support", ...ENTRIES)];
  if (platform === "win32") return [];
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  return [join(config, ...ENTRIES)];
}

/** One file's entry when it is a live standalone TCP host, else null. Never throws. */
function readEntry(file: string, alive: (pid: number) => boolean): HostEntry | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (data["type"] !== "standalone") return null;
    const endpoint = data["endpoint"] as Record<string, unknown> | undefined;
    if (!endpoint || endpoint["type"] !== "tcp") return null;
    const { pid } = data;
    const { host, port } = endpoint;
    const token = data["connectionToken"];
    const protocol = data["protocolVersion"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof host !== "string" || !host || typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof token !== "string") return null;
    if (!alive(pid)) return null;
    return { pid, host, port, token, protocol: typeof protocol === "string" ? protocol : null, file };
  } catch {
    return null;
  }
}

/** The newest (by mtime) live standalone TCP entry across `dirs`; a malformed file is skipped. */
export function liveStandalone(dirs: string[], alive: (pid: number) => boolean): HostEntry | null {
  let best: { entry: HostEntry; mtime: number } | null = null;
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      let mtime: number;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (best && mtime <= best.mtime) continue;
      const entry = readEntry(file, alive);
      if (entry) best = { entry, mtime };
    }
  }
  return best?.entry ?? null;
}
