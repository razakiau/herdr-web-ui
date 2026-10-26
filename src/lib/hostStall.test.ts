import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { STALL_MS, stalledMessage } from "./hostStall.ts";

const at = Date.parse("2026-10-25T17:51:50.000Z");
const user = (text: string, extra: ConversationTurn["parts"] = []): ConversationTurn => ({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text }, ...extra] });
const answer = (parts: ConversationTurn["parts"] = []): ConversationTurn => ({ role: "assistant", ts: new Date(at).toISOString(), parts });

describe("a sent message the agent never started on (owner, ZAC-233)", () => {
  it("is stalled once the running turn has shown nothing for STALL_MS", () => {
    const turns = [user("FICTIONAL did we start the UI?"), answer()];
    expect(stalledMessage({ busy: true, turns }, at + STALL_MS)).toEqual({ text: "FICTIONAL did we start the UI?" });
  });

  it("is not stalled before then", () => {
    expect(stalledMessage({ busy: true, turns: [user("FICTIONAL x"), answer()] }, at + STALL_MS - 1)).toBeNull();
  });

  it("is not stalled once the turn shows anything, reasoning included", () => {
    expect(stalledMessage({ busy: true, turns: [user("FICTIONAL x"), answer([{ kind: "thinking", text: "FICTIONAL hmm" } as ConversationTurn["parts"][number]])] }, at + 10 * STALL_MS)).toBeNull();
  });

  it("is not stalled on an idle chat", () => {
    expect(stalledMessage({ busy: false, turns: [user("FICTIONAL x"), answer()] }, at + 10 * STALL_MS)).toBeNull();
  });

  it("offers no resend for a message that carried pictures: they cannot be sent again from the transcript", () => {
    const turns = [user("FICTIONAL look", [{ kind: "image", media_type: "image/png", ref: "turn:t1:0" } as ConversationTurn["parts"][number]]), answer()];
    expect(stalledMessage({ busy: true, turns }, at + 10 * STALL_MS)).toBeNull();
  });
});
