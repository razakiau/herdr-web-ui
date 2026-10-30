import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostChatCost, HostChatRow } from "../shared/host-chats.ts";
import type { Machine } from "../shared/machines.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { ColdPrices, PushService } from "./push.ts";

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

const cost: HostChatCost = { session: "ahp:/s1", models: [], lastCallAt: "2026-03-10T10:00:00Z", context: 268_000, peak: 268_000, rewrites: 0, days: {}, partial: false };
const PRICES: ColdPrices = { prices: null, fallback: null };

async function fixture(agentHost: boolean, cold: { wants?: boolean; costs?: "answer" | "missing"; pollMs?: number } | null = null) {
  const root = mkdtempSync(join(tmpdir(), "herdr-host-alerts-"));
  const seen: { rows: HostChatRow[]; machine: string | undefined; name: string | undefined }[] = [];
  const costs: { chats: HostChatCost[]; prices: ColdPrices; machine: string | undefined; name: string | undefined }[] = [];
  const push = {
    seed() {}, async onStatus() {}, async onEnded() {},
    onHostChats(rows: HostChatRow[], machine?: string, name?: string) { seen.push({ rows, machine, name }); },
    wantsCold: () => cold?.wants ?? true,
    onHostChatCosts(chats: HostChatCost[], prices: ColdPrices, machine?: string, name?: string) { costs.push({ chats, prices, machine, name }); },
  } as unknown as PushService;
  const manager = new MachineManager(join(root, "state"), push, new CompletionTracker(null), async () => { throw new Error("local offline"); }, { agentHost, ...(cold ? { coldPrices: async () => PRICES, costsPollMs: cold.pollMs ?? 40 } : {}) });
  let costReads = 0;
  const costQueries: string[] = [];
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
      if (path === "/api/host-chats/costs") {
        if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
        costReads++;
        costQueries.push(new URL(request.url).search);
        // a bridge from before the costs answers 404
        return cold?.costs === "missing" ? new Response(null, { status: 404 }) : Response.json({ chats: [cost], complete: true });
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
  return { seen, costs, costQueries, costReads: () => costReads, reads: () => reads, setChats: (next: HostChatRow[]) => { chats = next; }, send: (message: ServerMessage) => observer!.send(JSON.stringify(message)) };
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

it("polls a remote PC's chat cost logs for the cold-cache alert, with the prices (ZAC-260)", async () => {
  const { costs } = await fixture(true, {});
  // read on connect, then again on the poll: the last call moves with every call, unannounced
  await until(() => costs.length >= 2);
  expect(costs[0]).toEqual({ chats: [cost], prices: PRICES, machine: "mac", name: "Mac" });
});

it("reads no costs while nobody wants the cold-cache alert, nor without prices to weigh them", async () => {
  const quiet = await fixture(true, { wants: false });
  const unpriced = await fixture(true);
  await Bun.sleep(150); // fixed wait: proving no read follows across several polls
  expect(quiet.costReads()).toBe(0);
  expect(unpriced.costReads()).toBe(0);
});

it("lets a bridge from before the costs be: its 404 reaches no alert", async () => {
  const { costs, costReads } = await fixture(true, { costs: "missing" });
  await until(() => costReads() >= 2);
  expect(costs).toEqual([]);
});

it("reads no costs on a list change, only on its poll (ZAC-260 review: a streaming turn fires many)", async () => {
  const { costReads, send } = await fixture(true, { pollMs: 60_000 });
  await until(() => costReads() === 1);
  for (let change = 0; change < 5; change++) send({ type: "host-chat-changed", session: null });
  await Bun.sleep(80); // fixed wait: proving no read follows the changes
  expect(costReads()).toBe(1);
});

it("asks the bridge for the poll's small read budget", async () => {
  const { costQueries } = await fixture(true, {});
  await until(() => costQueries.length > 0);
  expect(costQueries[0]).toBe("?poll=1");
});
