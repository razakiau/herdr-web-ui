import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostArtifact, HostChatRead } from "../shared/host-chats.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { digestModels, chatInput, DigestError, DigestJobs, ChatFactsCache, estimateDigest, isoWeek, refreshDigest, type Complete, type DigestDeps } from "./group-digest.ts";
import { DIGEST_EFFORT_KEY, DIGEST_MODEL_KEY } from "./groups-routes.ts";
import { GroupStore } from "./groups-store.ts";

const dirs: string[] = [];
const stores: GroupStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(): GroupStore {
  const dir = mkdtempSync(join(tmpdir(), "ovis-group-digest-"));
  dirs.push(dir);
  const store = new GroupStore(dir);
  stores.push(store);
  return store;
}

// FICTIONAL chats: a few turns each, a PR artifact on one
const PR: HostArtifact = { id: "pr-30", type: "pullRequest", label: "herdr-web-ui#30 digest picker", isArtifact: true, link: "https://github.com/example/herdr-web-ui/pull/30" };
const turn = (role: "user" | "assistant", parts: ConversationTurn["parts"]): ConversationTurn => ({ role, ts: null, parts });
function chat(session: string, artifacts: HostArtifact[] = []): HostChatRead {
  return {
    session, title: `Chat ${session}`, status: "idle", cursor: null, prompt: null, model: null, agent: null, busy: false, pending: [], commands: [],
    background: { subagents: 0, commands: 0 }, confirmations: 0, context: null, artifacts,
    turns: [turn("user", [{ kind: "text", text: `Do ${session}` }]), turn("assistant", [{ kind: "text", text: `Done ${session}`, phase: "final_answer" }])],
  } as unknown as HostChatRead;
}

/** A fake OmniRoute: answers each call by its system prompt, counts them, and can be told to fail the group pass. */
function fakeOmniRoute(options: { groupAnswer?: string; summaryChars?: number } = {}) {
  const calls: { kind: "summary" | "week" | "group"; user: string }[] = [];
  const complete: Complete = async (request) => {
    const kind = request.system.includes("one coding-agent chat") ? "summary" : request.system.includes("one week") ? "week" : "group";
    calls.push({ kind, user: request.user });
    const usage = { input: 1000, cached: 0, output: 100 };
    if (kind === "summary") return { text: JSON.stringify({ text: `${"S".repeat(options.summaryChars ?? 20)} ${request.user.split("\n")[0]}` }), usage };
    if (kind === "week") return { text: JSON.stringify({ text: "week digest" }), usage };
    return { text: options.groupAnswer ?? JSON.stringify({
      direction: "Where it goes.\nLine two.\nLine three.",
      open: [{ text: "Picker in review", artifactId: "A1" }, { text: "Invented link", artifactId: "pr-30" }, { text: "Move the cost note", kind: "thread" }],
      done: [{ text: "Groups shipped" }],
      perChat: [{ session: "local a", line: "a line" }, { session: "b", line: "b line" }, { session: "nobody", line: "x" }],
    }), usage };
  };
  return { calls, complete };
}

function setup(sessions: string[] = ["a", "b"]) {
  const store = open();
  const id = store.create("Group");
  for (const session of sessions) store.add(id, "local", session);
  const lastCalls = new Map<string, string | null>(sessions.map((session) => [`local ${session}`, "2026-10-31T10:00:00.000Z"]));
  const archived = new Set<string>();
  const reads: string[] = [];
  const omni = fakeOmniRoute();
  const deps = (over: Partial<DigestDeps> = {}): DigestDeps => ({
    store,
    readChat: async (_pc, session) => { reads.push(session); return chat(session, session === "a" ? [PR] : []); },
    lastCalls: async () => lastCalls, archived: async () => archived,
    complete: omni.complete,
    // OmniRoute's table keys it under its provider: the route `opencode-go/claude-haiku-5-5` prices directly
    prices: async () => ({ prices: { "opencode-go": { "claude-haiku-5-5": { input: 1, output: 5 } } }, fallback: null }),
    now: () => Date.parse("2026-11-01T12:00:00.000Z"),
    ...over,
  });
  return { store, id, lastCalls, archived, reads, omni, deps };
}
const CHOICE = { model: "opencode-go/claude-haiku-5-5", effort: "low" as const };

describe("refreshing a group's digest", () => {
  it("summarises each chat, then one group pass; prices the calls; saves the choice as the default", async () => {
    const { store, id, omni, deps } = setup();
    const digest = await refreshDigest(id, CHOICE, deps());
    expect(omni.calls.map((call) => call.kind)).toEqual(["summary", "summary", "group"]);
    // 3 calls × (1000 in × $1 + 100 out × $5) / 1M
    expect(digest.costUsd).toBeCloseTo(3 * 0.0015, 10);
    expect(store.spent(id)).toBeCloseTo(3 * 0.0015, 10);
    expect(digest.chatsSeen).toEqual(["local a", "local b"]);
    expect(store.getSetting(DIGEST_MODEL_KEY)).toBe(CHOICE.model);
    expect(store.getSetting(DIGEST_EFFORT_KEY)).toBe("low");
    expect(store.digest(id)?.direction).toBe("Where it goes.\nLine two.\nLine three.");
  });

  it("a model with no price: the spend is marked incomplete, not a silent $0", async () => {
    const { store, id, deps } = setup();
    expect(store.spendIncomplete(id)).toBe(false);
    await refreshDigest(id, { model: "unpriced/model", effort: "low" }, deps());
    expect(store.spent(id)).toBe(0);
    expect(store.spendIncomplete(id)).toBe(true);
  });

  it("second refresh makes no call", async () => {
    const { id, omni, deps } = setup();
    await refreshDigest(id, CHOICE, deps());
    omni.calls.length = 0;
    await refreshDigest(id, CHOICE, deps());
    expect(omni.calls).toEqual([]);
  });

  it("only changed chats: one summary call and one group call", async () => {
    const { id, omni, lastCalls, reads, deps } = setup();
    await refreshDigest(id, CHOICE, deps());
    omni.calls.length = 0;
    reads.length = 0;
    lastCalls.set("local b", "2026-11-01T09:00:00.000Z");
    await refreshDigest(id, CHOICE, deps());
    expect(omni.calls.map((call) => call.kind)).toEqual(["summary", "group"]);
    expect(reads).toEqual(["b"]);
  });

  it("a summary written after the digest (its group pass failed) is not skipped on the next refresh", async () => {
    const { id, lastCalls, deps } = setup();
    let clock = Date.parse("2026-11-01T12:00:00.000Z");
    const now = () => clock;
    await refreshDigest(id, CHOICE, deps({ now }));
    clock += 60_000;
    lastCalls.set("local a", "2026-11-01T11:00:00.000Z");
    const failing = fakeOmniRoute({ groupAnswer: "not json" });
    await refreshDigest(id, CHOICE, deps({ complete: failing.complete, now })).catch(() => undefined);
    expect(failing.calls.map((call) => call.kind)).toEqual(["summary", "group"]);
    clock += 60_000;
    const omni = fakeOmniRoute();
    const digest = await refreshDigest(id, CHOICE, deps({ complete: omni.complete, now }));
    expect(omni.calls.map((call) => call.kind)).toEqual(["group"]);
    expect(digest.writtenAt).toBe(new Date(clock).toISOString());
  });

  it("archived once: an archived member with a summary is never summarised again", async () => {
    const { id, omni, lastCalls, archived, deps } = setup();
    await refreshDigest(id, CHOICE, deps());
    archived.add("local a");
    lastCalls.set("local a", "2026-11-01T09:00:00.000Z");
    omni.calls.length = 0;
    await refreshDigest(id, { ...CHOICE, effort: "medium" }, deps());
    expect(omni.calls.map((call) => call.kind)).toEqual(["group"]);
  });

  it("bad answer keeps old digest, returns an error, and keeps this run's summaries", async () => {
    const { store, id, lastCalls, deps } = setup();
    const first = await refreshDigest(id, CHOICE, deps());
    lastCalls.set("local a", "2026-11-01T09:00:00.000Z");
    const bad = fakeOmniRoute({ groupAnswer: "Sure! Here is the digest you asked for." });
    const error = await refreshDigest(id, CHOICE, deps({ complete: bad.complete })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toBe("answered something that is not JSON");
    expect(store.digest(id)).toEqual(first);
    expect(store.summary("local", "a")?.lastCallSeen).toBe("2026-11-01T09:00:00.000Z");
    // the failed run's calls are paid for all the same
    expect(store.spent(id)).toBeCloseTo(5 * 0.0015, 10);
  });

  it("no invented links: an artifactId no member has is dropped from its item; threads keep no link", async () => {
    const { id, deps } = setup();
    const digest = await refreshDigest(id, CHOICE, deps());
    expect(digest.open).toEqual([{ text: "Picker in review", artifact: PR }, { text: "Invented link" }, { text: "Move the cost note" }]);
    expect(digest.perChat).toEqual([{ pc: "local", session: "a", line: "a line" }, { pc: "local", session: "b", line: "b line" }]);
  });

  it("two chats' artifacts with the same id (a1) both reach the model, each under its own digest index", async () => {
    const { id, deps } = setup();
    const mine: HostArtifact = { id: "a1", type: "pullRequest", label: "repo#1 from a", isArtifact: true, link: "https://github.com/example/repo/pull/1" };
    const theirs: HostArtifact = { id: "a1", type: "issue", label: "ZAC-2 from b", isArtifact: false, link: "https://github.com/example/repo/issues/2" };
    let listed = "";
    const complete: Complete = async (request) => {
      const usage = { input: 10, cached: 0, output: 10 };
      if (request.system.includes("one coding-agent chat")) return { text: JSON.stringify({ text: "summary" }), usage };
      listed = request.user.slice(request.user.indexOf("ARTIFACTS:"));
      const named = [...listed.matchAll(/\[(A\d+)\]/g)].map((match) => match[1]!);
      return { text: JSON.stringify({ direction: "D", open: named.map((each) => ({ text: `item ${each}`, artifactId: each })), done: [], perChat: [] }), usage };
    };
    const digest = await refreshDigest(id, CHOICE, deps({ complete, readChat: async (_pc, session) => chat(session, session === "a" ? [mine] : [theirs]) }));
    expect(listed).toContain("[A1]");
    expect(listed).toContain("[A2]");
    expect(listed).not.toContain("[a1]");
    expect(digest.open.map((item) => item.artifact)).toEqual([mine, theirs]);
  });

  it("weekly batches: 30 summaries over 60K tokens go week by week, then one final call", async () => {
    const sessions = Array.from({ length: 30 }, (_, index) => `c${index}`);
    const { id, lastCalls, deps } = setup(sessions);
    // three ISO weeks of chats
    sessions.forEach((session, index) => lastCalls.set(`local ${session}`, new Date(Date.parse("2026-10-12T10:00:00.000Z") + (index % 3) * 7 * 86_400_000).toISOString()));
    const omni = fakeOmniRoute({ summaryChars: 9_000 });
    await refreshDigest(id, CHOICE, deps({ complete: omni.complete }));
    expect(omni.calls.filter((call) => call.kind === "summary")).toHaveLength(30);
    expect(omni.calls.filter((call) => call.kind === "week")).toHaveLength(3);
    expect(omni.calls.at(-1)?.kind).toBe("group");
    expect(omni.calls.filter((call) => call.kind === "group")).toHaveLength(1);
  });

  it("a model's answer that is not JSON names the model by its short name", async () => {
    const { id, deps } = setup();
    const bad = fakeOmniRoute({ groupAnswer: "nope" });
    expect(await refreshDigest(id, CHOICE, deps({ complete: bad.complete })).catch((caught: unknown) => caught)).toEqual(new DigestError("claude-haiku-5-5", "answered something that is not JSON"));
  });

  it("reads a JSON answer wrapped in prose or a fenced block; truly non-JSON still fails", async () => {
    const GOOD = JSON.stringify({ direction: "Wrapped.", open: [], done: [], perChat: [] });
    const answers = [
      `Here is the digest:\n${GOOD}`,
      `${GOOD}\n\nLet me know if you want changes.`,
      `Sure, the digest:\n\`\`\`json\n${GOOD}\n\`\`\`\nHope this helps.`,
    ];
    for (const groupAnswer of answers) {
      const { id, deps } = setup();
      const wrapped = fakeOmniRoute({ groupAnswer });
      expect((await refreshDigest(id, CHOICE, deps({ complete: wrapped.complete }))).direction).toBe("Wrapped.");
    }
    for (const groupAnswer of ["I could not write a digest for these chats.", "{ direction: not json }", "[1, 2]"]) {
      const { id, deps } = setup();
      const bad = fakeOmniRoute({ groupAnswer });
      expect(await refreshDigest(id, CHOICE, deps({ complete: bad.complete })).catch((caught: unknown) => caught)).toEqual(new DigestError("claude-haiku-5-5", "answered something that is not JSON"));
    }
  });

  it("an OmniRoute failure names OmniRoute", async () => {
    const { id, deps } = setup();
    const error = await refreshDigest(id, CHOICE, deps({ complete: async () => { throw new Error("502 Bad Gateway"); } })).catch((caught: unknown) => caught);
    expect(error).toEqual(new DigestError("OmniRoute", "502 Bad Gateway"));
  });
});

describe("a chat's input", () => {
  it("drops tool calls and reasoning, keeps user messages and final replies", () => {
    const read = chat("x");
    read.turns = [
      turn("user", [{ kind: "text", text: "Please fix it" }]),
      turn("assistant", [{ kind: "thinking", text: "SECRET REASONING" }, { kind: "tool", name: "bash", summary: "ls", input: "TOOL INPUT", output: "TOOL OUTPUT" },
        { kind: "text", text: "Looking…", phase: "commentary" }, { kind: "text", text: "Fixed in PR 30.", phase: "final_answer" }]),
    ];
    const input = chatInput(read, [PR]);
    expect(input).toContain("USER: Please fix it");
    expect(input).toContain("ASSISTANT: Fixed in PR 30.");
    expect(input).toContain("[pr-30] pullRequest");
    for (const gone of ["SECRET REASONING", "TOOL INPUT", "TOOL OUTPUT", "Looking…"]) expect(input).not.toContain(gone);
  });

  it("over budget, cuts from the middle: the first 30% and the last 70% stay", () => {
    const read = chat("x");
    read.turns = Array.from({ length: 100 }, (_, index) => turn("user", [{ kind: "text", text: `message-${index} ${"x".repeat(200)}` }]));
    const input = chatInput(read, [], 1_000);
    expect(input.length).toBeLessThan(4_200);
    expect(input).toContain("message-0 ");
    expect(input).toContain("message-99 ");
    expect(input).not.toContain("message-50 ");
    expect(input).toContain("characters cut");
    const cut = input.indexOf("[…");
    expect(cut / input.length).toBeGreaterThan(0.25);
    expect(cut / input.length).toBeLessThan(0.35);
  });
});

describe("the estimate", () => {
  it("counts the chats due, one group pass, and prices the tokens", async () => {
    const { id, deps, lastCalls } = setup();
    const base = deps();
    const estimate = await estimateDigest(id, CHOICE, { ...base, contexts: async () => new Map([["local a", 8_000], ["local b", 500_000]]) });
    expect(estimate.chats).toBe(2);
    expect(estimate.groupPasses).toBe(1);
    expect(estimate.tokensIn).toBeGreaterThan(8_000 + 40_000);
    expect(estimate.usd).not.toBeNull();
    await refreshDigest(id, CHOICE, base);
    lastCalls.set("local a", "2026-11-01T09:00:00.000Z");
    expect((await estimateDigest(id, CHOICE, { ...base, contexts: async () => new Map() })).chats).toBe(1);
    expect((await estimateDigest(id, { model: "unpriced-model", effort: "low" }, { ...base, contexts: async () => new Map() })).usd).toBeNull();
  });

  it("weeks are ISO weeks", () => {
    expect(isoWeek(Date.parse("2026-11-01T12:00:00Z"))).toBe("2026-W44");
    expect(isoWeek(Date.parse("2026-10-26T00:00:00Z"))).toBe("2026-W44");
    expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("the jobs", () => {
  it("one per group at a time; tells each stage; keeps a failure until the next run", async () => {
    const { store, id, deps } = setup();
    let told = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = deps();
    const facts = new ChatFactsCache(async () => ({ lastCalls: new Map(await base.lastCalls()), contexts: new Map(), archived: new Set() }), 60_000, () => {});
    let fail = false;
    const jobs = new DigestJobs({
      store: () => store, readChat: async (pc, session) => { await gate; return base.readChat(pc, session); },
      complete: async (request) => { if (fail) throw new Error("502 Bad Gateway"); return base.complete(request); },
      prices: base.prices, facts, models: async () => ["m"], changed: () => { told += 1; },
    });
    const first = jobs.start(id, CHOICE);
    expect(first).not.toBeNull();
    expect(jobs.start(id, CHOICE)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(jobs.writing(id)).toEqual({ phase: "summaries", done: 0, total: 2 });
    release();
    await first!.done;
    expect(jobs.writing(id)).toBeNull();
    expect(told).toBeGreaterThanOrEqual(4);
    expect(store.digest(id)).not.toBeNull();
    fail = true;
    const second = jobs.start(id, { ...CHOICE, effort: "high" });
    await second!.done;
    expect(jobs.failure(id)).toMatchObject({ source: "OmniRoute", message: "502 Bad Gateway" });
  });
});

describe("the models the picker offers", () => {
  const LIVE = ["aihorde/llama-3", "claude/claude-opus-5-5", "claude/claude-opus-5-5-high", "anthropic/claude-sonnet-5", "opencode-go/claude-haiku-5-5",
    "opencode-go/glm-5.3-max", "github-copilot/gpt-5.6", "github-copilot/gpt-5.6-xhigh", "cc/claude-opus-5-5", "openrouter/x"];
  it("an allowlist (HERDR_WEB_DIGEST_MODELS) intersected with what OmniRoute lists, in the list's order", () => {
    expect(digestModels(LIVE, " opencode-go/claude-haiku-5-5, claude/claude-opus-5-5 ,gone/model,")).toEqual(["opencode-go/claude-haiku-5-5", "claude/claude-opus-5-5"]);
  });
  it("without one: no effort-suffixed ids, only claude/, anthropic/, opencode-go/ and github-copilot/", () => {
    for (const allow of [undefined, "", " , "]) {
      expect(digestModels(LIVE, allow)).toEqual(["anthropic/claude-sonnet-5", "claude/claude-opus-5-5", "github-copilot/gpt-5.6", "opencode-go/claude-haiku-5-5"]);
    }
  });
});
