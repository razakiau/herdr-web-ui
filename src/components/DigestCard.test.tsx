import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { GroupDigest, GroupMember } from "../../shared/groups.ts";
import { digestFacts, digestUsd, estimateParts, perChatWeeks, staleCount } from "../lib/digest.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DigestCard, digestModelName, type DigestCardProps } from "./DigestCard.tsx";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const pr = (n: number) => ({ id: `pr${n}`, type: "pullRequest" as const, label: `herdr-web-ui#${n}`, isArtifact: true, link: `https://github.com/razakiau/herdr-web-ui/pull/${n}` });
const issue = (n: number) => ({ id: `is${n}`, type: "issue" as const, label: `ZAC-${n}`, isArtifact: false, link: `https://github.com/razakiau/zhomelab/issues/${n}` });
const DIGEST: GroupDigest = {
  groupId: 1,
  direction: "FICTIONAL: the groups ship; the digest is next.",
  open: [{ text: "FICTIONAL picker", artifact: pr(30) }, { text: "FICTIONAL cost note", artifact: issue(274) }, { text: "FICTIONAL unfinished thread" }],
  done: [{ text: "FICTIONAL groups", artifact: pr(23) }],
  perChat: [{ pc: "local", session: "a", line: "FICTIONAL first" }, { pc: "local", session: "b", line: "FICTIONAL second" }],
  model: "opencode-go-claude-haiku-5-5", effort: "low", costUsd: 0.004, writtenAt: new Date(NOW - 2 * 3_600_000).toISOString(),
  chatsSeen: ["local a", "local b"],
};
const member = (session: string): GroupMember => ({ pc: "local", session, joined: "link", addedAt: "2026-10-30T09:00:00Z" });

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  } });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const classed = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
  root.findAll((each) => typeof each.type === "string" && typeof each.props["className"] === "string" && (each.props["className"] as string).split(" ").includes(name));

async function card(over: Partial<DigestCardProps> = {}): Promise<{ root: ReactTestInstance; opened: unknown[]; refreshed: number[] }> {
  const opened: unknown[] = [];
  const refreshed: number[] = [];
  const props: DigestCardProps = {
    digest: DIGEST, stale: 0, chats: 2, since: Date.parse("2026-10-30T09:00:00Z"), now: NOW, states: {},
    perChat: DIGEST.perChat.map((line, index) => ({ ...line, name: index === 0 ? "265" : "268", at: NOW - index })),
    onRefresh: () => refreshed.push(1), onOpenChat: (target) => opened.push(target), onOpenArtifact: (artifact) => opened.push(artifact), ...over,
  };
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(DigestCard, props) })); });
  return { root: renderer!.root, opened, refreshed };
}

describe("the digest's sums", () => {
  it("counts a chat with a newer call, one that joined after, and one that left", () => {
    const calls = new Map([["local a", new Date(NOW).toISOString()], ["local b", new Date(NOW - 5 * 3_600_000).toISOString()]]);
    expect(staleCount(DIGEST, [member("a"), member("b")], calls)).toBe(1);
    expect(staleCount(DIGEST, [member("a"), member("b"), member("c")], new Map())).toBe(1);
    expect(staleCount(DIGEST, [member("a")], new Map())).toBe(1);
    expect(staleCount(DIGEST, [member("a"), member("b")], new Map())).toBe(0);
  });

  it("counts open issues and PRs in review from the items' own artifacts, a merged PR no longer", () => {
    expect(digestFacts(DIGEST, {})).toEqual({ issues: 1, prs: 1 });
    expect(digestFacts(DIGEST, { [pr(30).link]: "merged" })).toEqual({ issues: 1, prs: 0 });
  });

  it("folds Per chat into weeks only past twenty chats", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ pc: "local", session: `s${i}`, line: "l", at: NOW - i * 86_400_000 }));
    expect(perChatWeeks(lines(20))).toBeNull();
    const weeks = perChatWeeks(lines(21))!;
    expect(weeks.reduce((sum, week) => sum + week.lines.length, 0)).toBe(21);
    expect(weeks[0]!.lines[0]!.at).toBe(NOW);
  });

  it("says a digest's cost to a tenth of a cent, and the estimate's tokens", () => {
    expect(digestUsd(0.004)).toBe("$0.004");
    expect(digestUsd(0.25)).toBe("$0.25");
    expect(estimateParts({ chats: 2, groupPasses: 1, tokensIn: 38_000, usd: 0.003 })).toEqual({ usd: "≈ $0.003", tokens: "~38K" });
  });

  it("names a router's route to a vendor's model by the model", () => {
    expect(digestModelName("opencode-go-claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(digestModelName("omniroute/auto-cheap")).toBe("omniroute/auto-cheap");
  });
});

describe("the digest card", () => {
  it("collapsed: names its model, effort, cost and age, its Direction and facts, and nothing more", async () => {
    const { root } = await card();
    const text = textOf(root);
    expect(text).toContain("Haiku 5.5 low");
    expect(text).toContain("$0.004");
    expect(text).toContain("2 h ago");
    expect(text).toContain("FICTIONAL: the groups ship");
    expect(text).toContain("1 issue open");
    expect(text).toContain("1 PR in review");
    expect(text).not.toContain("Still open");
    expect(text).not.toContain("moved on");
  });

  it("expanded: Still open, Done and Per chat; a tap on a chat opens it", async () => {
    const { root, opened } = await card();
    await act(async () => { classed(root, "digest-body")[0]!.props["onClick"](); });
    const text = textOf(root);
    expect(text).toContain("Still open");
    expect(text).toContain("Done");
    expect(text).toContain("Per chat");
    await act(async () => { classed(root, "digest-chat")[0]!.props["onClick"](); });
    expect(opened).toEqual([{ pc: "local", session: "a" }]);
  });

  it("an item without an artifact draws no link: words only, nothing to tap", async () => {
    const { root, opened } = await card({ expanded: true });
    const rows = classed(root, "digest-item-row");
    const thread = rows.find((row) => textOf(row).includes("FICTIONAL unfinished thread"))!;
    expect(thread.type).toBe("div");
    expect(thread.props["onClick"]).toBeUndefined();
    expect(thread.findAll((each) => each.type === "a" || each.type === "button")).toHaveLength(0);
    // one with an artifact opens that artifact, and only that
    const linked = rows.find((row) => textOf(row).includes("FICTIONAL picker"))!;
    expect(linked.type).toBe("button");
    await act(async () => { linked.props["onClick"](); });
    expect(opened).toEqual([pr(30)]);
  });

  it("stale: says how many chats moved on, with one Refresh", async () => {
    const { root, refreshed } = await card({ stale: 2 });
    expect(textOf(classed(root, "digest-stale")[0]!)).toContain("2 chats moved on since this digest");
    const refresh = classed(root, "digest-link");
    expect(refresh).toHaveLength(1);
    await act(async () => { refresh[0]!.props["onClick"](); });
    expect(refreshed).toHaveLength(1);
  });

  it("empty: no digest yet, its chats and first day, and the write with its cost", async () => {
    const { root } = await card({ digest: null, chats: 11, estimate: { chats: 11, groupPasses: 1, tokensIn: 200_000, usd: 0.004 } });
    const text = textOf(root);
    expect(text).toContain("No digest yet. 11 chats since");
    expect(text).toContain("Write digest (≈ $0.004)");
  });

  it("error: the old digest stays, the error under its header, and Try again", async () => {
    const { root } = await card({ failure: { source: "OmniRoute", message: "502 Bad Gateway", at: new Date(NOW).toISOString() } });
    const text = textOf(root);
    expect(textOf(classed(root, "digest-error")[0]!)).toContain("OmniRoute: 502 Bad Gateway · kept the digest from 2 h ago");
    expect(text).toContain("FICTIONAL: the groups ship");
    expect(text).toContain("Try again");
  });

  it("writing: its step, the old digest kept but not tappable", async () => {
    const { root } = await card({ progress: { stage: "summaries", done: 2, total: 11 } });
    expect(textOf(root)).toContain("Summarising 3 of 11 chats…");
    expect(classed(root, "digest-card")[0]!.props["className"]).toContain("is-writing");
    expect(classed(root, "digest-link")).toHaveLength(0);
  });
});
