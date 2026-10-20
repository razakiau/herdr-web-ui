import { describe, expect, it } from "bun:test";
import type { HostChatRow } from "../../shared/host-chats.ts";
import { byAge, folderPills } from "./hostChatGroups.ts";

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
