import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster, byAttention, restingSplit } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps the pinned card first in pin order and each PC's rows in its own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    // blocked first, then the latest change, within each PC; the PCs keep their order
    expect(split.rest.map(key)).toEqual(["local/b", "local/a", "remote/e"]);
  });

  it("needs you, then working, then unread, then the rest, keeping the order inside a group", () => {
    const rows = ["idle1", "work1", "done1", "block1", "work2", "idle2"].map((id) => ({ id, status: id.replace(/\d$/, "").replace("block", "blocked").replace("work", "working") }));
    const sorted = byAttention(rows, (row) => row.status === "idle" ? "idle" : row.status);
    expect(sorted.map((row) => row.id)).toEqual(["block1", "work1", "work2", "done1", "idle1", "idle2"]);
  });

  it("pinned rows stay in the card whatever their status", () => {
    const machines = [machine("local", "connected", [["a", "blocked"], ["b", "idle"]])];
    const split = agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [sidebarPinKey("local", "b")] });
    expect(split.pinned.map(({ entry }) => entry.pane.pane_id)).toEqual(["b"]);
  });
});

describe("restingSplit (the owner, 2026-10-25: many agents)", () => {
  type Row = { id: string; status: AgentStatus | undefined };
  const row = (id: string, status: AgentStatus | undefined): Row => ({ id, status });
  const ids = (rows: readonly Row[]) => rows.map((each) => each.id);
  const split = (rows: Row[], selected: string | null = null, all = false) => restingSplit(rows, (each) => each.status, (each) => each.id === selected, all);

  it("keeps what needs you, works or finished unread, and folds the rest into resting", () => {
    const result = split([row("ask", "blocked"), row("run", "working"), row("fin", "done"), row("idle", "idle"), row("away", undefined)]);
    expect(ids(result.shown)).toEqual(["ask", "run", "fin"]);
    expect(ids(result.resting)).toEqual(["idle", "away"]);
    expect(result.hidden).toBe(0);
  });

  it("shows 8 of the ones that need you or work, and counts the rest for Show all; asks come first so they are never cut", () => {
    const busy = [row("a1", "blocked"), ...Array.from({ length: 10 }, (_, n) => row(`w${n}`, "working")), row("fin", "done")];
    const result = split(busy);
    expect(ids(result.shown)).toEqual(["a1", "w0", "w1", "w2", "w3", "w4", "w5", "w6", "fin"]);
    expect(result.hidden).toBe(3);
    expect(ids(split(busy, null, true).shown)).toHaveLength(12);
  });

  it("the selected row is always shown, even when resting or past the cap", () => {
    const busy = Array.from({ length: 10 }, (_, n) => row(`w${n}`, "working"));
    expect(ids(split(busy, "w9").shown)).toContain("w9");
    expect(split(busy, "w9").hidden).toBe(1);
    const quiet = split([row("run", "working"), row("idle", "idle")], "idle");
    expect(ids(quiet.shown)).toEqual(["run", "idle"]);
    expect(quiet.resting).toEqual([]);
  });
});
