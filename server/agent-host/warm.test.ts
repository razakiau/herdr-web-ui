import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { createWarmKeeper, WARM_MAX, WARM_MS } from "./warm.ts";

const row = (session: string, status: HostChatRow["status"], extra: Partial<HostChatRow> = {}): HostChatRow =>
  ({ session, title: "FICTIONAL", status, modified_at: "2026-01-01T00:00:00.000Z", cwd: null, unread: false, archived: false, ...extra });

function rig() {
  const watched: string[] = [];
  const released: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const keeper = createWarmKeeper(
    { watch: async (session) => { watched.push(session); return () => released.push(session); } },
    { setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: (id) => { timers.delete(id as number); } },
  );
  const fire = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  return { keeper, watched, released, timers, fire };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("warm keeper (ZAC-340)", () => {
  it("holds a chat whose turn just ended, for WARM_MS, and nothing else", async () => {
    const r = rig();
    r.keeper.onRows([row("copilotcli:/1", "working"), row("copilotcli:/2", "idle")]);
    expect(r.watched).toEqual([]);
    r.keeper.onRows([row("copilotcli:/1", "idle"), row("copilotcli:/2", "idle")]);
    expect(r.watched).toEqual(["copilotcli:/1"]);
    expect([...r.timers.values()].map((timer) => timer.ms)).toEqual([WARM_MS]);
    r.fire();
    await settle();
    expect(r.released).toEqual(["copilotcli:/1"]);
    expect(r.keeper.held()).toEqual([]);
  });

  it("holds a fork's session, holds an asking chat, never an archived one", () => {
    const r = rig();
    r.keeper.onRows([row("ahp-chat:/f", "working", { fork_of: "copilotcli:/1" }), row("copilotcli:/2", "working"), row("copilotcli:/3", "working")]);
    r.keeper.onRows([row("ahp-chat:/f", "idle", { fork_of: "copilotcli:/1" }), row("copilotcli:/2", "asks"), row("copilotcli:/3", "idle", { archived: true })]);
    expect(r.watched).toEqual(["copilotcli:/1", "copilotcli:/2"]);
  });

  it("a second finish renews the hold without a second watch; past WARM_MAX the oldest goes", async () => {
    const r = rig();
    const cycle = (session: string) => { r.keeper.onRows([row(session, "working")]); r.keeper.onRows([row(session, "idle")]); };
    cycle("copilotcli:/0");
    cycle("copilotcli:/0");
    expect(r.watched).toEqual(["copilotcli:/0"]);
    for (let n = 1; n <= WARM_MAX; n++) cycle(`copilotcli:/${n}`);
    await settle();
    expect(r.released).toEqual(["copilotcli:/0"]);
    expect(r.keeper.held().length).toBe(WARM_MAX);
  });
});
