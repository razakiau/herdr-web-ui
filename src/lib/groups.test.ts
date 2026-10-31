import { describe, expect, it } from "bun:test";

import type { ChatGroup } from "../../shared/groups.ts";
import type { HostArtifact, HostChatRow, HostLink } from "../../shared/host-chats.ts";
import { chainOrder, chatKey, createGroupsFeed, dedupArtifacts, shortChatName, trailTo } from "./groups.ts";

const PC = "mac";
const row = (session: string, title: string, modified: string, over: Partial<HostChatRow> = {}): HostChatRow =>
  ({ session, title, status: "idle", modified_at: modified, cwd: "/w/zhomelab", unread: false, archived: false, ...over });
const member = (session: string, joined: "link" | "manual", addedAt = "2026-10-31T10:00:00Z") => ({ pc: PC, session, joined, addedAt });

// the owner's real chain: ZAC-262 handed off to 265, then to 266; the Haiku pricing chat was added by hand
const GROUP: ChatGroup = {
  id: 1, name: "Ovis keep-warm", createdAt: "2026-10-29T09:00:00Z", updatedAt: "2026-10-31T12:00:00Z",
  members: [member("s262", "link"), member("s265", "link"), member("s266", "link"), member("h", "manual")],
};
const LINKS: (HostLink & { pc: string })[] = [
  { pc: PC, from: "s262", to: "s265", kind: "resume", at: "2026-10-31T10:00:00Z" },
  { pc: PC, from: "s262", to: "s266", kind: "resume", at: "2026-10-31T11:00:00Z" },
];
const ROWS = new Map([
  [chatKey(PC, "s262"), row("s262", "ZAC-262 Ovis keep-warm follow-ups", "2026-10-31T08:00:00Z", { archived: true })],
  [chatKey(PC, "s265"), row("s265", "ZAC-265 Ovis groups", "2026-10-31T17:00:00Z", { status: "working" })],
  [chatKey(PC, "s266"), row("s266", "ZAC-266 Cold hand-off", "2026-10-31T16:00:00Z")],
  [chatKey(PC, "h"), row("h", "Haiku pricing check", "2026-10-31T18:00:00Z")],
]);

describe("chainOrder", () => {
  it("follows the hand-offs oldest first, then places a chat added by hand", () => {
    const order = chainOrder(GROUP, LINKS, ROWS);
    expect(order.map((each) => each.session)).toEqual(["s262", "s265", "s266", "h"]);
    expect(order[0]!.join).toBeNull();
    expect(order[1]!.join).toEqual({ kind: "resume", from: "s262" });
    expect(order[1]!.forkNote).toBeUndefined();
  });

  it("notes where the trail forks, and a chat added by hand", () => {
    const order = chainOrder(GROUP, LINKS, ROWS);
    expect(order[2]!.forkNote).toBe("s262");
    expect(order[2]!.join).toEqual({ kind: "resume", from: "s262" });
    expect(order[3]!.join?.kind).toBe("manual");
  });

  it("places a chat added by hand by when it last changed, among the chains", () => {
    const rows = new Map(ROWS);
    rows.set(chatKey(PC, "h"), row("h", "Haiku pricing check", "2026-10-30T12:00:00Z"));
    expect(chainOrder(GROUP, LINKS, rows).map((each) => each.session)).toEqual(["h", "s262", "s265", "s266"]);
  });

  it("ignores links of another PC and links leaving the group, and survives a loop", () => {
    const links = [...LINKS, { pc: "cde", from: "s265", to: "s266", kind: "job" as const, at: "2026-10-31T12:00:00Z" },
      { pc: PC, from: "s265", to: "elsewhere", kind: "job" as const, at: "2026-10-31T12:00:00Z" },
      { pc: PC, from: "s266", to: "s262", kind: "fork" as const, at: "2026-10-31T13:00:00Z" }];
    expect(chainOrder(GROUP, links, ROWS).map((each) => each.session).sort()).toEqual(["h", "s262", "s265", "s266"]);
  });

  it("keeps a member no list has (gone, or its PC offline)", () => {
    const rows = new Map(ROWS);
    rows.delete(chatKey(PC, "s266"));
    expect(chainOrder(GROUP, LINKS, rows).map((each) => each.session)).toEqual(["s262", "s265", "s266", "h"]);
  });
});

describe("trailTo", () => {
  it("is the path from the first chat to this one, not the other branch", () => {
    expect(trailTo(GROUP, LINKS, "s265")).toEqual(["s262", "s265"]);
    expect(trailTo(GROUP, LINKS, "s266")).toEqual(["s262", "s266"]);
    expect(trailTo(GROUP, LINKS, "h")).toEqual(["h"]);
  });
});

describe("dedupArtifacts", () => {
  it("shows the same PR made in two chats once, with both chats", () => {
    const pr: HostArtifact = { id: "a1", type: "pullRequest", label: "#58", isArtifact: true, link: "https://github.com/x/y/pull/58" };
    const spec: HostArtifact = { id: "a2", type: "file", label: "spec.md", isArtifact: true, uri: "file:///w/spec.md" };
    const found = dedupArtifacts(new Map([
      ["mac s265", [pr, spec]],
      ["mac s266", [{ ...pr, id: "other-id" }]],
    ]));
    expect(found.map((each) => each.artifact.label)).toEqual(["#58", "spec.md"]);
    expect(found[0]!.from).toEqual(["mac s265", "mac s266"]);
    expect(found[1]!.from).toEqual(["mac s265"]);
  });
});

describe("shortChatName", () => {
  it("says a ticket by its number, any other chat by its first words", () => {
    expect(shortChatName("ZAC-265 Ovis groups")).toBe("265");
    expect(shortChatName("Haiku pricing check for summaries")).toBe("Haiku pricing…");
    expect(shortChatName("")).toBe("…");
  });
});

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

describe("the groups feed", () => {
  it("reads on its first want, on each nudge and on a resume, and stops when nobody wants it", async () => {
    let calls = 0;
    let nudge: () => void = () => {};
    let resume: () => void = () => {};
    const feed = createGroupsFeed({
      fetch: async () => { calls += 1; return { groups: [GROUP], links: LINKS, summaries: [], digests: [], digestDefaults: { model: "m", effort: "low" } }; },
      onNudge: (listener) => { nudge = listener; return () => { nudge = () => {}; }; },
      onResume: (listener) => { resume = listener; return () => { resume = () => {}; }; },
    });
    const stop = feed.want();
    await flush();
    expect(calls).toBe(1);
    expect(feed.read().answer?.groups[0]?.name).toBe("Ovis keep-warm");
    nudge();
    await flush();
    expect(calls).toBe(2);
    resume();
    await flush();
    expect(calls).toBe(3);
    stop();
    nudge();
    expect(calls).toBe(3);
  });
});
