import { afterEach, describe, expect, it } from "bun:test";

import type { HandoffJob, HandoffState } from "../../shared/host-chats.ts";
import { fetchHandoff, followHandoff, handOffAndContinue, startHandoff } from "./hostChats.ts";

const t = (key: string, vars?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
const job = (state: HandoffState, over: Partial<HandoffJob> = {}): HandoffJob => ({
  session: "old", state, startedAt: 1, endedAt: null, topic: null, newSession: null, error: null, ...over,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** answers each request with the next of `answers` (the last one repeats), noting each method and URL */
const answer = (...answers: Array<[number, unknown]>) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}${init?.body ? ` ${String(init.body)}` : ""}`);
    const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
};
const conflict = (code: string): [number, unknown] => [409, { error: { code, message: code } }];
const NOT_FOUND: [number, unknown] = [404, { error: { code: "job_not_found", message: "none" } }];

describe("the hand-off job's routes", () => {
  it("starts the job on the chat's own PC and reads it back", async () => {
    const calls = answer([200, { job: job("sending") }], [200, { job: job("waiting") }]);
    expect((await startHandoff("desk", "old")).state).toBe("sending");
    expect((await fetchHandoff("local", "old"))?.state).toBe("waiting");
    expect(calls).toEqual([
      'POST /api/machines/desk/host-chats/chat/handoff {"session":"old"}',
      "GET /api/host-chats/chat/handoff?session=old",
    ]);
  });

  it("reads a job the bridge no longer has as null", async () => {
    answer(NOT_FOUND);
    expect(await fetchHandoff("desk", "old")).toBeNull();
  });
});

describe("followHandoff", () => {
  it("polls every 2 s until the job ends, telling each state", async () => {
    answer([200, { job: job("waiting") }], [200, { job: job("starting") }], [200, { job: job("done", { newSession: "new" }) }]);
    const waits: number[] = [];
    const seen: HandoffState[] = [];
    const end = await followHandoff("desk", "old", { poll: async (ms) => { waits.push(ms); }, onState: (each) => seen.push(each.state) });
    expect(end?.newSession).toBe("new");
    expect(seen).toEqual(["waiting", "starting", "done"]);
    expect(waits).toEqual([2000, 2000, 2000]);
  });

  it("stops at every end state", async () => {
    for (const state of ["no_resume", "timeout", "failed"] as const) {
      answer([200, { job: job(state) }], [200, { job: job("waiting") }]);
      expect((await followHandoff("desk", "old", { poll: async () => {}, onState: () => {} }))?.state).toBe(state);
    }
  });

  it("loses the job on a 404 (the bridge restarted), and keeps going through a blip", async () => {
    answer([200, { job: job("waiting") }], [503, { error: { code: "down", message: "down" } }], NOT_FOUND);
    expect(await followHandoff("desk", "old", { poll: async () => {}, onState: () => {} })).toBeNull();
  });

  it("gives up after 25 min", async () => {
    const calls = answer([200, { job: job("waiting") }]);
    expect(await followHandoff("desk", "old", { poll: async () => {}, onState: () => {} })).toBeNull();
    expect(calls).toHaveLength(25 * 30);
  });
});

describe("handOffAndContinue", () => {
  const run = (pc = "Desk") => {
    const opened: string[] = [];
    const states: HandoffState[] = [];
    const done = handOffAndContinue("desk", "old", { pc, t, poll: async () => {}, onState: (each) => states.push(each.state), onOpen: (session) => opened.push(session) });
    return { opened, states, done };
  };

  it("opens the new chat when the job is done, with nothing to say", async () => {
    answer([200, { job: job("sending") }], [200, { job: job("done", { newSession: "new" }) }]);
    const { opened, done } = run();
    expect(await done).toBeNull();
    expect(opened).toEqual(["new"]);
  });

  it("opens the new chat whose /resume did not go", async () => {
    answer([200, { job: job("sending") }], [200, { job: job("failed", { error: "resume_not_sent", newSession: "new" }) }]);
    const { opened, done } = run();
    await done;
    expect(opened).toEqual(["new"]);
  });

  it("says why it did not hand off, in the banner's words", async () => {
    const cases: Array<[[number, unknown][], string]> = [
      [[conflict("busy")], "It's working: try again when it's done"],
      [[conflict("no_handoff")], "This chat can't hand off from here"],
      [[conflict("no_folder")], "This chat can't hand off from here"],
      [[conflict("recent_handoff")], "A hand-off was just written: open the chat"],
      [[[404, { error: { code: "not_found", message: "unknown endpoint" } }]], "Update the bridge on Desk to hand off from here"],
      [[[200, { job: job("sending") }], [200, { job: job("no_resume") }]], "Hand-off note written, but no /resume line: open the chat"],
      [[[200, { job: job("sending") }], [200, { job: job("timeout") }]], "Hand-off didn't finish: open the chat"],
      [[[200, { job: job("sending") }], NOT_FOUND], "Lost track of the hand-off: open the chat"],
    ];
    for (const [answers, words] of cases) {
      answer(...answers);
      const { opened, done } = run();
      expect(await done).toBe(words);
      expect(opened).toEqual([]);
    }
  });

  it("follows nothing when the POST answers a job that already ended", async () => {
    const calls = answer([200, { job: job("done", { newSession: "new" }) }]);
    const { opened, done } = run();
    await done;
    expect(opened).toEqual(["new"]);
    expect(calls).toHaveLength(1);
  });
});
