import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { byAge, byCost, folderPills, groupSubtotal } from "./hostChatGroups.ts";
import type { CostSplit } from "./sessionCost.ts";

const row = (session: string, modified_at: string, cwd: string | null = "/tmp/a"): HostChatRow =>
  ({ session, title: session, status: "idle", modified_at, cwd, unread: false, archived: false });
// 2026-03-10 15:00 local
const NOW = new Date(2026, 2, 10, 15, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 2, day, hour, 0).toISOString();

describe("byAge: VS Code's session groups", () => {
  it("files chats under Today, Yesterday, Last 7 days, Last 30 days and Older by calendar day, newest first, leaving empty ones out", () => {
    const rows = [row("old", at(1, 1).replace("2026-03", "2025-12")), row("y-early", at(9, 0)), row("today-early", at(10, 0)), row("today", at(10, 14)), row("week", at(4, 12)), row("month", at(1, 12))];
    expect(byAge(rows, NOW).map((group) => [group.age, group.chats.map((each) => each.session)])).toEqual([
      ["today", ["today", "today-early"]],
      ["yesterday", ["y-early"]],
      ["week", ["week"]],
      ["month", ["month"]],
      ["older", ["old"]],
    ]);
  });

  it("a day 7 days back is still the week; 8 days back is the month", () => {
    expect(byAge([row("seven", at(3, 10)), row("eight", at(2, 10))], NOW).map((group) => [group.age, group.chats.map((each) => each.session)]))
      .toEqual([["week", ["seven"]], ["month", ["eight"]]]);
  });

  it("an unreadable time is Older", () => {
    expect(byAge([row("bad", "not a date")], NOW).map((group) => group.age)).toEqual(["older"]);
  });
});

describe("folderPills", () => {
  it("one pill per folder, the most recently active first, chats without a folder last; counts the chats", () => {
    const rows = [row("a1", at(5, 1), "/tmp/a"), row("b1", at(9, 1), "/tmp/b/"), row("a2", at(8, 1), "/tmp/a"), row("n", at(10, 1), null)];
    expect(folderPills(rows)).toEqual([{ cwd: "/tmp/b", count: 1 }, { cwd: "/tmp/a", count: 2 }, { cwd: null, count: 1 }]);
  });
});

const split = (usd: number, floor = false, missing: string[] = []): CostSplit => ({ usd, reads: usd * 0.6, writes: usd * 0.3, output: usd * 0.1, fresh: 0, floor, missing });

describe("groupSubtotal", () => {
  it("sums the chats that have a cost, part by part, and is a floor when any of them is", () => {
    const rows = [row("a", at(10, 1)), row("b", at(10, 2)), row("claude", at(10, 3))];
    const costs = new Map([["a", split(10)], ["b", split(5, true, ["m-x"])]]);
    const total = groupSubtotal(rows, costs);
    expect(total.usd).toBeCloseTo(15);
    expect(total.reads).toBeCloseTo(9);
    expect(total.writes).toBeCloseTo(4.5);
    expect(total.output).toBeCloseTo(1.5);
    expect(total.floor).toBe(true);
    expect(total.missing).toEqual(["m-x"]);
  });

  it("is zero and no floor without any cost", () => {
    expect(groupSubtotal([row("claude", at(10, 3))], new Map())).toEqual({ usd: 0, reads: 0, writes: 0, output: 0, fresh: 0, floor: false, missing: [] });
  });
});

describe("byCost", () => {
  it("one flat list, biggest first, leaving out the chats without a cost", () => {
    const rows = [row("small", at(10, 1)), row("none", at(10, 2)), row("big", at(1, 2)), row("mid", at(9, 3))];
    const costs = new Map([["small", split(1)], ["big", split(38)], ["mid", split(6, true)]]);
    expect(byCost(rows, costs).map((each) => each.session)).toEqual(["big", "mid", "small"]);
  });
});
