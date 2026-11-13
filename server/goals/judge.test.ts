import { describe, expect, it } from "bun:test";
import type { OmniRouteCompletion } from "../omniroute.ts";
import { digestOf, judge, JUDGE_SYSTEM, parseVerdict } from "./judge.ts";

/** One of each event cop-goal reads, plus what it skips: an unknown type, a blank reply, a line that is not JSON. */
const FIXTURE = [
  { type: "session.start", data: {} },
  { type: "user.message", data: { content: "FICTIONAL: make the tests pass" } },
  { type: "assistant.message", data: { content: "   " } },
  { type: "assistant.message", data: { content: "FICTIONAL: running the tests" } },
  { type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "bun test" } } },
  { type: "tool.execution_complete", data: { success: false, result: { content: `1 fail\n${"x".repeat(4100)}` } } },
  { type: "tool.execution_start", data: { toolName: "view", arguments: { path: "/tmp/fictional/a.ts" } } },
  { type: "tool.execution_complete", data: { success: true, result: { detailedContent: "no content field" } } },
  { type: "tool.execution_start", data: { toolName: "report", arguments: { note: "y".repeat(1200) } } },
  { type: "tool.execution_complete", data: { result: "plain ok" } },
  { type: "assistant.message", data: { content: "FICTIONAL: done" } },
].map((event) => JSON.stringify(event)).join("\n") + "\nnot json\n\n";

// `node cop-goal digest <FIXTURE>` (zhomelab ansible/roles/coder/files/workspace-template/agents/bin/cop-goal),
// 2026-11-13, its trailing newline dropped; the long x and y runs written as repeats.
const COP_GOAL_DIGEST = `USER: FICTIONAL: make the tests pass
AGENT: FICTIONAL: running the tests
TOOL bash: bun test
RESULT (failed): 1 fail
${"x".repeat(1993)}
[… 107 chars cut …]
${"x".repeat(2000)}
TOOL view: /tmp/fictional/a.ts
RESULT: {"detailedContent":"no content field"}
TOOL report: {"note":"${"y".repeat(491)}
[… 211 chars cut …]
${"y".repeat(498)}"}
RESULT: plain ok
AGENT: FICTIONAL: done`;
// COP_GOAL_DIGEST_BYTES=300 node cop-goal digest <FIXTURE>
const COP_GOAL_DIGEST_300 = `[… earlier turns cut …]
${"y".repeat(258)}"}
RESULT: plain ok
AGENT: FICTIONAL: done`;

const USAGE = { input: 1200, cached: 0, output: 30 };

describe("digestOf", () => {
  it("gives exactly cop-goal's digest for the same events.jsonl", () => {
    expect(digestOf(FIXTURE)).toBe(COP_GOAL_DIGEST);
  });
  it("keeps the newest maxBytes, as cop-goal does", () => {
    expect(digestOf(FIXTURE, 300)).toBe(COP_GOAL_DIGEST_300);
  });
});

describe("parseVerdict", () => {
  it("takes the JSON object out of prose around it", () => {
    expect(parseVerdict('Sure. {"verdict": "not_met", "reason": "FICTIONAL: no test run shown"} Hope that helps.')).toEqual({ verdict: "not_met", reason: "FICTIONAL: no test run shown" });
  });
  it("refuses a verdict it does not know and an answer with no JSON", () => {
    expect(() => parseVerdict('{"verdict":"maybe"}')).toThrow('bad verdict "maybe"');
    expect(() => parseVerdict("FICTIONAL: it looks done")).toThrow("no JSON in evaluator answer");
  });
  it("keeps cop-goal's prompt", () => {
    expect(JUDGE_SYSTEM).toStartWith("You check whether a coding agent has achieved a goal.");
    expect(JUDGE_SYSTEM).toEndWith('Answer with one JSON object and nothing else: {"verdict": "met" | "not_met" | "impossible", "reason": "<one or two sentences>"}');
  });
});

describe("judge", () => {
  const input = { model: "cx/gpt-fictional", doneWhen: "FICTIONAL: bun test passes", digest: "USER: FICTIONAL" };

  it("asks the model at low effort with the condition and the transcript", async () => {
    const asked: Array<{ model: string; effort: string; system: string; user: string }> = [];
    await judge(async (request) => { asked.push(request); return { text: '{"verdict":"met","reason":"ok"}', usage: USAGE }; }, input);
    expect(asked).toEqual([{ model: "cx/gpt-fictional", effort: "low", system: JUDGE_SYSTEM, user: "CONDITION:\nFICTIONAL: bun test passes\n\nTRANSCRIPT (oldest first):\nUSER: FICTIONAL" }]);
  });
  it("answers an error, never throws, when the call fails", async () => {
    const answer = await judge(async () => { throw new Error("FICTIONAL: OmniRoute down"); }, input);
    expect(answer).toEqual({ error: "FICTIONAL: OmniRoute down", usage: null });
  });
  it("answers an error with the call's usage when the model's answer is not a verdict", async () => {
    const answer = await judge(async (): Promise<OmniRouteCompletion> => ({ text: "not json", usage: USAGE }), input);
    expect(answer).toEqual({ error: "no JSON in evaluator answer", usage: USAGE });
  });
  it("answers the verdict, its reason and the call's usage", async () => {
    const answer = await judge(async () => ({ text: '{"verdict":"met","reason":"ok"}', usage: USAGE }), input);
    expect(answer).toEqual({ verdict: "met", reason: "ok", usage: USAGE });
  });
});
