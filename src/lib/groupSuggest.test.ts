import { describe, expect, it } from "bun:test";
import type { ChatGroup } from "../../shared/groups.ts";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { chatKey } from "./groups.ts";
import { groupMatches, suggestGroups, SUGGESTED, ticketKeys, type GroupFacts } from "./groupSuggest.ts";

// FICTIONAL data: chats on one pc, a group per test with the members it needs
const row = (session: string, title: string): HostChatRow => ({ session, title } as HostChatRow);
const ROWS = new Map<string, HostChatRow>([
  ["a", row("a", "zac-265 digest wording")],
  ["b", row("b", "ZAC-26 old notes")],
  ["c", row("c", "Cost chart")],
  ["d", row("d", "Ticker sync")],
].map(([session, value]) => [chatKey("pc", session as string), value as HostChatRow]));
const group = (id: number, name: string, sessions: string[] = []): ChatGroup =>
  ({ id, name, createdAt: "", updatedAt: "", members: sessions.map((session) => ({ pc: "pc", session })) } as ChatGroup);
const facts = (id: number, name: string, folder: string | null, active: number, sessions: string[] = []): GroupFacts =>
  ({ group: group(id, name, sessions), folder, active });
const ids = (list: { facts: GroupFacts }[]): number[] => list.map((each) => each.facts.group.id);

describe("ticket keys", () => {
  it("finds whole keys, any case, upper-cased", () => {
    expect([...ticketKeys("zac-265: digest, SPK-45 and Ovis")]).toEqual(["ZAC-265", "SPK-45"]);
    expect(ticketKeys("ZAC-2650").has("ZAC-265")).toBe(false);
    expect(ticketKeys("xZAC-265").has("ZAC-265")).toBe(false);
  });
});

describe("suggested groups", () => {
  it("a shared ticket beats the same folder, which beats recency", () => {
    const list = suggestGroups({ title: "ZAC-265 cost note", folder: "ovis" }, [
      facts(1, "Recent", null, 300),
      facts(2, "Same folder", "ovis", 200),
      facts(3, "Ticket by a chat", "other", 100, ["a"]),
    ], ROWS);
    expect(ids(list)).toEqual([3, 2, 1]);
    expect(list.map((each) => each.reason)).toEqual([{ kind: "ticket", key: "ZAC-265" }, { kind: "folder", folder: "ovis" }, { kind: "recent", at: 300 }]);
  });

  it("matches a ticket in the group's name, case-insensitively", () => {
    const list = suggestGroups({ title: "Zac-265 follow-up", folder: null }, [facts(1, "x", null, 900), facts(2, "zac-265 groups", null, 1)], ROWS);
    expect(list[0]!.reason).toEqual({ kind: "ticket", key: "ZAC-265" });
    expect(ids(list)[0]).toBe(2);
  });

  it("ZAC-26 does not match ZAC-265", () => {
    const list = suggestGroups({ title: "ZAC-26 retro", folder: null }, [facts(1, "ZAC-265 groups", null, 5, ["a"]), facts(2, "Notes", null, 1, ["b"])], ROWS);
    expect(ids(list)).toEqual([2, 1]);
    expect(list[0]!.reason).toEqual({ kind: "ticket", key: "ZAC-26" });
    expect(list[1]!.reason.kind).toBe("recent");
  });

  it("at most three, the newest first within a rank, the chat's own group left out", () => {
    const list = suggestGroups({ title: "Untitled", folder: null },
      [facts(1, "g1", null, 1), facts(2, "g2", null, 5), facts(3, "g3", null, 3), facts(4, "g4", null, 4), facts(5, "g5", null, 9)], ROWS, 5);
    expect(list).toHaveLength(SUGGESTED);
    expect(ids(list)).toEqual([2, 4, 3]);
  });
});

describe("group search", () => {
  it("every word in the name or a chat's title, any case", () => {
    expect(groupMatches(group(1, "Ovis keep-warm", ["c"]), ROWS, "cost")).toBe(true);
    expect(groupMatches(group(1, "Ovis keep-warm", ["c"]), ROWS, "ovis CHART")).toBe(true);
    expect(groupMatches(group(1, "Ovis keep-warm", ["c"]), ROWS, "ovis ticker")).toBe(false);
    expect(groupMatches(group(1, "Ovis", []), ROWS, "  ")).toBe(true);
  });
});
