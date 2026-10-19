import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { checkpointRows } from "./hostCheckpoints.ts";

const said = (role: ConversationTurn["role"]): ConversationTurn => ({ role, ts: null, parts: [{ kind: "text", text: role }] });
const cp = (turn: string) => ({ turn, files: [] });

describe("which checkpoint each shown user message is (VS Code's Restore Checkpoint / Start Over)", () => {
  it("pairs user messages with the read's checkpoints from the newest back; the chat's first is Start Over", () => {
    const rows = checkpointRows([said("user"), said("assistant"), said("user"), said("assistant")], [cp("t1"), cp("t2")], null, false);
    expect(rows.get(0)).toEqual({ turn: "t1", first: true, files: [], faded: false });
    expect(rows.get(2)).toEqual({ turn: "t2", first: false, files: [], faded: false });
    expect(rows.has(1)).toBe(false);
  });

  it("a page that does not reach the chat's start has no Start Over", () => {
    // older turns not loaded: the shown first message is the host's second turn
    const rows = checkpointRows([said("user"), said("assistant")], [cp("t1"), cp("t2")], null, true);
    expect(rows.get(0)?.first).toBe(false);
    expect(rows.get(0)?.turn).toBe("t2");
    // checkpoints listed for the shown window only: the counts line up, older turns still exist
    expect(checkpointRows([said("user"), said("assistant")], [cp("t5")], null, true).get(0)?.first).toBe(false);
  });

  it("after a restore, that message and every row after it are faded", () => {
    const turns = [said("user"), said("assistant"), said("user"), said("assistant")];
    const rows = checkpointRows(turns, [cp("t1"), cp("t2")], "t2", false);
    expect(rows.get(0)?.faded).toBe(false);
    expect(rows.get(2)?.faded).toBe(true);
    expect([...rows.entries()].filter(([, row]) => row.faded).map(([index]) => index)).toEqual([2, 3]);
  });
});
