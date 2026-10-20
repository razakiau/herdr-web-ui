import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostChatRow } from "../shared/host-chats.ts";
import type { Machine } from "../shared/machines.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

/**
 * A remote PC's host chats reach the alerts (server/push.ts onHostChats): its list is read when
 * the bridge connects, as the baseline, and again each time the bridge says the list changed.
 */

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await Bun.sleep(5); }
  throw new Error("fixture did not reach the expected state");
}

const row = (status: HostChatRow["status"]): HostChatRow => ({ session: "ahp:/s1", title: "fix", status, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived: false });

async function fixture(agentHost: boolean) {
  const root = mkdtempSync(join(tmpdir(), "herdr-host-alerts-"));
  const seen: { rows: HostChatRow[]; machine: string | undefined; name: string | undefined }[] = [];
  const push = { seed() {}, async onStatus() {}, async onEnded() {}, onHostChats(rows: HostChatRow[], machine?: string, name?: string) { seen.push({ rows, machine, name }); } } as unknown as PushService;
  const manager = new MachineManager(join(root, "state"), push, new CompletionTracker(null), async () => { throw new Error("local offline"); }, agentHost);
  let chats: HostChatRow[] = [row("working")];
  let reads = 0;
  let observer: { send(data: string): unknown } | undefined;
  const bridge = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/ws") { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }
      if (path === "/api/host-chats/chats") {
        if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
        reads++;
        return Response.json({ chats });
      }
      return Response.json({ snapshot: { protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], agents: [], panes: [] } });
    },
    websocket: { open(ws) { observer = ws; }, message() {} },
  });
  cleanups.push(() => { manager.stop(); bridge.stop(true); rmSync(root, { recursive: true, force: true }); });
  const drive = manager as unknown as { machines: Map<string, unknown>; runtime(machine: Machine): { endpoint?: unknown; ssh?: unknown; machine: Machine }; observe(runtime: unknown): Promise<void> };
  const runtime = drive.runtime({ id: "mac", name: "Mac", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null });
  runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "fixture-token" };
  runtime.ssh = { close() {} };
  drive.machines.set("mac", runtime);
  await drive.observe(runtime);
  await until(() => observer !== undefined);
  return { seen, reads: () => reads, setChats: (next: HostChatRow[]) => { chats = next; }, send: (message: ServerMessage) => observer!.send(JSON.stringify(message)) };
}

it("reads a remote PC's host chats on connect and on each list change, for the alerts", async () => {
  const { seen, setChats, send } = await fixture(true);
  await until(() => seen.length === 1);
  expect(seen[0]).toEqual({ rows: [row("working")], machine: "mac", name: "Mac" });
  setChats([row("asks")]);
  send({ type: "host-chat-changed", session: null });
  await until(() => seen.length === 2);
  expect(seen[1]!.rows).toEqual([row("asks")]);
  // a change inside one chat (a turn streaming) is not a list change: no read
  send({ type: "host-chat-changed", session: "ahp:/s1" });
  await Bun.sleep(50); // fixed wait: proving no read follows
  expect(seen).toHaveLength(2);
});

it("reads nothing when this server shows no host chats", async () => {
  const { seen, reads, send } = await fixture(false);
  send({ type: "host-chat-changed", session: null });
  await Bun.sleep(50); // fixed wait: proving no read follows
  expect(reads()).toBe(0);
  expect(seen).toEqual([]);
});
