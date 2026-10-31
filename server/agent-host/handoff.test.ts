import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, SessionModelInfo, SessionState, SessionSummary, StateAction, Turn } from "@microsoft/agent-host-protocol";
import { AgentHostConnection } from "./connection.ts";
import { fakeAgentHost, type FakeAgentHost } from "./fake-host.ts";
import { HANDOFF_WAIT_MS, resumeTopic } from "./handoff.ts";
import { hostChatsRoute, type LeaseClock } from "./routes.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (ready()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionUri = (n: number) => `copilotcli:/${uuid(n)}`;
const chatUri = (n: number) => `ahp-chat://default/${Buffer.from(sessionUri(n)).toString("base64")}`;
const AT = "2026-01-01T00:00:00.000Z";
const FOLDER = "/tmp/fictional-handoff-repo";

const MODEL: SessionModelInfo = {
  id: "fictional/model-a", provider: "copilotcli", name: "Fictional Model A",
  configSchema: { type: "object", properties: { thinkingLevel: { type: "string", title: "Thinking Level", enum: ["low", "medium", "high"] } } },
};
const SELECTION = { id: "fictional/model-a", config: { thinkingLevel: "high" } };

const summary = (n: number): SessionSummary => ({
  resource: sessionUri(n), provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, createdAt: AT, modifiedAt: `2026-01-01T00:00:0${n}.000Z`,
  workingDirectories: [`file://${FOLDER}`], defaultChat: chatUri(n),
});

const HANDOFF_SKILL = { id: "handoff", type: "skill", name: "handoff", uri: "file:///tmp/fictional/skills/handoff", enabled: true, description: "FICTIONAL writes a hand-off note" };
/** A plugin's skill, named as the host lists it: `<plugin>:<skill>`. */
const pluginSkill = (name: string) => ({ ...HANDOFF_SKILL, id: name, name, uri: `file:///tmp/fictional/plugins/${name.replace(":", "/")}` });
const sessionState = (n: number, skills: unknown[] = [HANDOFF_SKILL]): SessionState => ({
  provider: "copilotcli", title: `FICTIONAL_chat_${n}`, status: 1, lifecycle: "ready", activeClients: [],
  chats: [{ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT }], defaultChat: chatUri(n),
  workingDirectories: [`file://${FOLDER}`], customizations: skills,
} as unknown as SessionState);

const user = (text: string, startedAt = AT): Turn => ({
  id: `turn-${text}`, startedAt, state: "complete", usage: undefined, message: { text, origin: { kind: "user" }, model: SELECTION },
  responseParts: [{ kind: "markdown", id: "m", content: "FICTIONAL ok" }],
} as unknown as Turn);
const chatState = (n: number, overrides: Record<string, unknown> = {}): ChatState =>
  ({ resource: chatUri(n), title: `FICTIONAL_chat_${n}`, status: 1, modifiedAt: AT, turns: [user("FICTIONAL earlier")], ...overrides } as unknown as ChatState);

function manualClock(): LeaseClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    setTimeout(run, ms) { next += 1; timers.set(next, { at: now + ms, run }); return next; },
    clearTimeout(handle) { timers.delete(handle as number); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
  };
}

interface Rig { fake: FakeAgentHost; conn: AgentHostConnection; clock: ReturnType<typeof manualClock> }

async function rig(chat: Record<string, unknown> = {}, skills?: unknown[]): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "herdr-handoff-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "cfg");
  const entries = join(config, "Code", "agent-host", "local-endpoint", "entries");
  mkdirSync(entries, { recursive: true });
  const fake = await fakeAgentHost({
    sessions: [summary(1)], states: { [sessionUri(1)]: sessionState(1, skills) }, chats: { [chatUri(1)]: chatState(1, chat) }, models: [MODEL], entryDir: entries,
  });
  cleanups.push(() => fake.stop());
  const conn = new AgentHostConnection({ home, env: { XDG_CONFIG_HOME: config }, platform: "linux", startHost: false, onChange: () => {}, clientId: "herdr-web-0000test", deps: { sleep: (ms) => Bun.sleep(Math.min(ms, 10)) } });
  cleanups.push(() => conn.stop());
  conn.start();
  await until("the connection", () => conn.state().state === "connected");
  return { fake, conn, clock: manualClock() };
}

async function call(r: Rig, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const request = body === undefined
    ? new Request(`http://127.0.0.1${path}`)
    : new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await hostChatsRoute(request, new URL(request.url).pathname, r.conn, r.clock)!;
  const text = await response.text();
  expect(text).not.toContain(r.fake.token);
  return { status: response.status, json: JSON.parse(text) };
}

const start = (r: Rig) => call(r, "/api/host-chats/chat/handoff", { session: sessionUri(1) });
const job = async (r: Rig) => (await call(r, `/api/host-chats/chat/handoff?session=${encodeURIComponent(sessionUri(1))}`)).json.job;
const sent = (fake: FakeAgentHost, type: string) => fake.dispatched.filter((each) => each.action.type === type);
/** What a refusal must not have done: no message, no archive (a watch's own session/activeClientSet is not one). */
const wrote = (fake: FakeAgentHost) => fake.dispatched.filter((each) => each.action.type !== "session/activeClientSet");

/** Any archive of the old chat, on its session or on a chat channel. */
const archived = (fake: FakeAgentHost) => fake.dispatched.filter((each) => each.action.type === "session/isArchivedChanged" || each.action.type === "chat/isArchivedChanged");

/** The `/handoff` turn the job started, once it is in the mirror. */
async function handoffTurn(r: Rig, text = "/handoff"): Promise<string> {
  await until(`the ${text} turn`, () => r.conn.chat(sessionUri(1))?.activeTurn?.message.text === text);
  return r.conn.chat(sessionUri(1))!.activeTurn!.id;
}

function reply(r: Rig, turnId: string, content: string): void {
  r.fake.push(chatUri(1), { type: "chat/responsePart", turnId, part: { kind: "markdown", id: "p1", content } } as unknown as StateAction);
  r.fake.push(chatUri(1), { type: "chat/turnComplete", turnId, duration: 1_000 } as unknown as StateAction);
}

describe("resumeTopic", () => {
  it("takes the last line", () => {
    expect(resumeTopic("Notes.\nStart the next chat with: /resume zac-1\nmore\nStart the next chat with: /resume zac-262")).toBe("zac-262");
    expect(resumeTopic("Start the next chat with: /resume  two words")).toBeNull();
    expect(resumeTopic("no line here")).toBeNull();
  });
  it("takes the line with the command written as code or in bold (seen live: `/resume handoff-feature-test`)", () => {
    expect(resumeTopic("Start the next chat with: `/resume handoff-feature-test`")).toBe("handoff-feature-test");
    expect(resumeTopic("`Start the next chat with: /resume zac-262`")).toBe("zac-262");
    expect(resumeTopic("**Start the next chat with: /resume zac-262**")).toBe("zac-262");
    expect(resumeTopic("Start the next chat with: `/resume two words`")).toBeNull();
    expect(resumeTopic("Start the next chat with: `/resume zac-262")).toBeNull();
  });
});

describe("chat/handoff", () => {
  it("refuses a busy chat without an open question with 409 busy, nothing dispatched", async () => {
    const r = await rig({ activeTurn: { id: "turn-live", startedAt: AT, message: { text: "FICTIONAL working", origin: { kind: "user" } }, usage: undefined, responseParts: [] } });
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("busy");
    expect(wrote(r.fake)).toEqual([]);
  });

  it("refuses without the command with 409 no_handoff", async () => {
    const r = await rig({}, []);
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("no_handoff");
    expect(wrote(r.fake)).toEqual([]);
  });

  it("refuses another plugin's handoff with 409 no_handoff", async () => {
    const r = await rig({}, [pluginSkill("mattpocock-skills:handoff"), pluginSkill("mattpocock-skills:resume")]);
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("no_handoff");
    expect(wrote(r.fake)).toEqual([]);
  });

  it("hands off where the skill is listed as harness:handoff: /harness:handoff, then /harness:resume <topic>", async () => {
    const r = await rig({}, [pluginSkill("mattpocock-skills:handoff"), pluginSkill("harness:handoff"), pluginSkill("harness:resume")]);
    const answer = await start(r);
    expect(answer.status).toBe(200);
    const turnId = await handoffTurn(r, "/harness:handoff");
    expect(sent(r.fake, "chat/turnStarted")[0]!.action).toMatchObject({ message: { text: "/harness:handoff", model: SELECTION } });
    reply(r, turnId, "FICTIONAL note written.\nStart the next chat with: /resume zac-262");
    for (let i = 0; i < 200 && (await job(r)).state !== "done"; i++) await Bun.sleep(10);
    expect(await job(r)).toMatchObject({ state: "done", topic: "zac-262", error: null });
    const resumed = sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1))!;
    expect(resumed.action).toMatchObject({ message: { text: "/harness:resume zac-262", model: SELECTION } });
  });

  it("recent_handoff: the newest user message is a /handoff 10 min old and no job runs", async () => {
    const r = await rig({ turns: [user("FICTIONAL earlier"), user("/handoff", new Date(Date.now() - 10 * 60_000).toISOString())] });
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("recent_handoff");
    expect(wrote(r.fake)).toEqual([]);
  });

  it("recent_handoff counts the plugin form /harness:handoff too", async () => {
    const r = await rig({ turns: [user("/harness:handoff", new Date(Date.now() - 10 * 60_000).toISOString())] });
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("recent_handoff");
  });

  it("an older /handoff (2 h) does not refuse", async () => {
    const r = await rig({ turns: [user("/handoff", new Date(Date.now() - 2 * 3_600_000).toISOString())] });
    expect((await start(r)).status).toBe(200);
  });

  it("a second start joins the job: one /handoff turn, the same startedAt", async () => {
    const r = await rig();
    const first = await start(r);
    expect(first.status).toBe(200);
    await handoffTurn(r);
    const second = await start(r);
    expect(second.status).toBe(200);
    expect(second.json.job.startedAt).toBe(first.json.job.startedAt);
    expect(sent(r.fake, "chat/turnStarted").length).toBe(1);
  });

  it("GET without a job is 404 job_not_found", async () => {
    const r = await rig();
    const answer = await call(r, `/api/host-chats/chat/handoff?session=${encodeURIComponent(sessionUri(1))}`);
    expect(answer.status).toBe(404);
    expect(answer.json.error.code).toBe("job_not_found");
  });

  it("happy path: /resume <topic> starts a new chat in the old folder on the old model; the note hand-off no longer archives", async () => {
    const r = await rig();
    const answer = await start(r);
    expect(answer.json.job).toMatchObject({ session: sessionUri(1), endedAt: null, newSession: null });
    const turnId = await handoffTurn(r);
    expect(sent(r.fake, "chat/turnStarted")[0]!.action).toMatchObject({ message: { text: "/handoff", model: SELECTION } });
    expect((await job(r)).state).toBe("waiting");
    reply(r, turnId, "FICTIONAL note written.\nStart the next chat with: /resume zac-262");
    for (let i = 0; i < 200 && (await job(r)).state !== "done"; i++) await Bun.sleep(10);
    const done = await job(r);
    expect(done).toMatchObject({ state: "done", mode: "note", topic: "zac-262", error: null });
    expect(typeof done.newSession).toBe("string");
    const create = r.fake.requests.findIndex((each) => each.method === "createSession");
    expect(r.fake.requests[create]!.params).toMatchObject({ channel: done.newSession, workingDirectories: [`file://${FOLDER}`] });
    const resumed = sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1))!;
    expect(resumed.action).toMatchObject({ message: { text: "/resume zac-262", model: SELECTION } });
    // the note hand-off no longer archives (ZAC-266): the old chat stays where it is
    expect(archived(r.fake)).toEqual([]);
  });

  it("no_resume archives nothing and creates nothing", async () => {
    const r = await rig();
    await start(r);
    const turnId = await handoffTurn(r);
    reply(r, turnId, "FICTIONAL note written, no line");
    await until("no_resume", () => r.conn.chat(sessionUri(1))?.activeTurn === undefined);
    for (let i = 0; i < 100 && (await job(r)).state === "waiting"; i++) await Bun.sleep(10);
    expect(await job(r)).toMatchObject({ state: "no_resume", topic: null, newSession: null });
    expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
    expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
  });

  it("an asks status keeps waiting; 20 min without an end is timeout, nothing archived", async () => {
    const r = await rig();
    await start(r);
    const turnId = await handoffTurn(r);
    r.fake.push(chatUri(1), { type: "chat/responsePart", turnId, part: { kind: "inputRequest", request: { id: "req-1", questions: [{ id: "q", kind: "text", title: "Q", message: "FICTIONAL which?", required: true }] } } } as unknown as StateAction);
    r.clock.advance(HANDOFF_WAIT_MS - 1);
    // fixed wait: proving the job does not end before its deadline (nothing arrives)
    await Bun.sleep(50);
    expect((await job(r)).state).toBe("waiting");
    r.clock.advance(1);
    for (let i = 0; i < 100 && (await job(r)).state === "waiting"; i++) await Bun.sleep(10);
    expect(await job(r)).toMatchObject({ state: "timeout", newSession: null });
    expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
    expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
  });

  it("a timeout cancels the still-running /handoff turn, and archives nothing", async () => {
    const r = await rig();
    await start(r);
    const turnId = await handoffTurn(r);
    r.clock.advance(HANDOFF_WAIT_MS);
    for (let i = 0; i < 100 && (await job(r)).state === "waiting"; i++) await Bun.sleep(10);
    expect((await job(r)).state).toBe("timeout");
    await until("the cancel", () => sent(r.fake, "chat/turnCancelled").length > 0);
    expect(sent(r.fake, "chat/turnCancelled")).toEqual([{ channel: chatUri(1), action: { type: "chat/turnCancelled", turnId, duration: 0 } as StateAction }]);
    expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
  });

  describe("a chat waiting on its own question", () => {
    const HARNESS = [pluginSkill("harness:handoff"), pluginSkill("harness:resume")];
    const QUESTION = { id: "q-next", kind: "single-select", title: "Next", message: "FICTIONAL what next?", required: true, allowFreeformInput: true, options: [{ id: "a", label: "FICTIONAL A" }, { id: "b", label: "FICTIONAL B" }] };
    const asking = (parts: unknown[] = [{ kind: "inputRequest", request: { id: "req-1", message: "FICTIONAL which way?", questions: [QUESTION] } }]) => ({
      status: 24, activeTurn: { id: "turn-live", startedAt: AT, message: { text: "FICTIONAL keep going", origin: { kind: "user" }, model: SELECTION }, usage: undefined, responseParts: parts },
    });
    const words = (name: string) => `Hand off now: run ${name}, then end your reply with its "Start the next chat with: /resume <topic>" line. Don't ask me anything else.`;
    const answered = (text: string) => ({
      type: "chat/inputCompleted", requestId: "req-1", response: "accept",
      answers: { "q-next": { state: "submitted", value: { kind: "selected", value: "", freeformValues: [text] } } },
    });
    const ended = async (r: Rig, state: string) => {
      let now = "";
      await until(`the job to be ${state}`, () => { void job(r).then((each) => { now = each.state; }); return now === state; });
    };

    it("answers the question with the hand-off words; the resume line in the final reply starts the next chat, archives nothing", async () => {
      const r = await rig(asking(), HARNESS);
      const answer = await start(r);
      expect(answer.status).toBe(200);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      expect(sent(r.fake, "chat/inputCompleted").map((each) => each.action)).toEqual([answered(words("/harness:handoff")) as unknown as StateAction]);
      // no new turn in the old chat: the answer is the message
      expect(sent(r.fake, "chat/turnStarted")).toEqual([]);
      expect((await job(r)).state).toBe("waiting");
      reply(r, "turn-live", "FICTIONAL note written.\nStart the next chat with: /resume t");
      await ended(r, "done");
      expect(await job(r)).toMatchObject({ state: "done", topic: "t", error: null });
      const resumed = sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1))!;
      expect(resumed.action).toMatchObject({ message: { text: "/harness:resume t", model: SELECTION } });
      // the turn ended by itself: nothing left to stop
      expect(sent(r.fake, "chat/turnCancelled")).toEqual([]);
      expect(archived(r.fake)).toEqual([]);
    });

    it("takes the resume line from the agent's next question without waiting for the turn to end: stops the turn, archives nothing", async () => {
      const r = await rig(asking(), HARNESS);
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      r.fake.push(chatUri(1), { type: "chat/responsePart", turnId: "turn-live", part: { kind: "markdown", id: "p2", content: "FICTIONAL note written." } } as unknown as StateAction);
      r.fake.push(chatUri(1), { type: "chat/responsePart", turnId: "turn-live", part: { kind: "inputRequest", request: { id: "req-2", message: "FICTIONAL done.\nStart the next chat with: /resume t", questions: [{ ...QUESTION, id: "q-again" }] } } } as unknown as StateAction);
      await ended(r, "done");
      expect(await job(r)).toMatchObject({ state: "done", topic: "t", error: null });
      const resumed = sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1))!;
      expect(resumed.action).toMatchObject({ message: { text: "/harness:resume t" } });
      expect(sent(r.fake, "chat/turnCancelled")).toEqual([{ channel: chatUri(1), action: { type: "chat/turnCancelled", turnId: "turn-live", duration: 0 } as StateAction }]);
      // made, then stopped; nothing archived
      const order: string[] = r.fake.dispatched.map((each) => each.action.type);
      expect(order.lastIndexOf("chat/turnStarted")).toBeLessThan(order.indexOf("chat/turnCancelled"));
      expect(archived(r.fake)).toEqual([]);
    });

    it("a resume line written before the answer does not count", async () => {
      const r = await rig(asking([
        { kind: "markdown", id: "p0", content: "FICTIONAL earlier\nStart the next chat with: /resume old" },
        { kind: "inputRequest", request: { id: "req-1", questions: [QUESTION] } },
      ]), HARNESS);
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      reply(r, "turn-live", "FICTIONAL no line");
      await ended(r, "no_resume");
      expect(await job(r)).toMatchObject({ state: "no_resume", topic: null, newSession: null });
      expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
    });

    it("a timeout cancels the turn whose question it answered, and archives nothing", async () => {
      const r = await rig(asking(), HARNESS);
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      expect((await job(r)).state).toBe("waiting");
      r.clock.advance(HANDOFF_WAIT_MS);
      await ended(r, "timeout");
      expect(await job(r)).toMatchObject({ state: "timeout", newSession: null });
      await until("the cancel", () => sent(r.fake, "chat/turnCancelled").length > 0);
      expect(sent(r.fake, "chat/turnCancelled")).toEqual([{ channel: chatUri(1), action: { type: "chat/turnCancelled", turnId: "turn-live", duration: 0 } as StateAction }]);
      expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
      expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
    });

    it("a form of several questions: the current one takes the hand-off words, an answered one stays, the rest go as skipped", async () => {
      const first = { ...QUESTION, id: "q-first" };
      const last = { ...QUESTION, id: "q-last", required: false };
      const kept = { state: "submitted", value: { kind: "selected", value: "a" } };
      const r = await rig(asking([{ kind: "inputRequest", request: { id: "req-1", message: "FICTIONAL which way?", questions: [first, QUESTION, last], answers: { "q-first": kept } } }]), HARNESS);
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      expect(sent(r.fake, "chat/inputCompleted").map((each) => each.action)).toEqual([{
        type: "chat/inputCompleted", requestId: "req-1", response: "accept",
        answers: {
          "q-first": kept,
          "q-next": { state: "submitted", value: { kind: "selected", value: "", freeformValues: [words("/harness:handoff")] } },
          "q-last": { state: "skipped" },
        },
      } as unknown as StateAction]);
    });

    it("the agent's next question without a resume line: no_resume at once, no cancel, nothing archived", async () => {
      const r = await rig(asking(), HARNESS);
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      r.fake.push(chatUri(1), { type: "chat/responsePart", turnId: "turn-live", part: { kind: "inputRequest", request: { id: "req-2", message: "FICTIONAL which file first?", questions: [{ ...QUESTION, id: "q-again" }] } } } as unknown as StateAction);
      await ended(r, "no_resume");
      expect(await job(r)).toMatchObject({ state: "no_resume", topic: null, newSession: null });
      expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
      expect(sent(r.fake, "chat/turnCancelled")).toEqual([]);
      expect(sent(r.fake, "session/isArchivedChanged")).toEqual([]);
    });

    it("says /handoff where the plain skill is listed", async () => {
      const r = await rig(asking());
      await start(r);
      await until("the answer", () => sent(r.fake, "chat/inputCompleted").length > 0);
      expect(sent(r.fake, "chat/inputCompleted")[0]!.action).toEqual(answered(words("/handoff")) as unknown as StateAction);
    });

    it("recent_handoff: the newest turn's question was answered with the hand-off words", async () => {
      const answeredPart = { kind: "inputRequest", request: { id: "req-0", questions: [QUESTION], answers: { "q-next": { state: "submitted", value: { kind: "selected", value: "", freeformValues: [words("/harness:handoff")] } } } }, response: "accept" };
      const r = await rig(asking([answeredPart, { kind: "inputRequest", request: { id: "req-1", questions: [QUESTION] } }]), HARNESS);
      const answer = await start(r);
      expect(answer.status).toBe(409);
      expect(answer.json.error.code).toBe("recent_handoff");
      expect(wrote(r.fake)).toEqual([]);
    });

    it("a pending tool approval is not a question: 409 busy", async () => {
      const r = await rig(asking([{ kind: "toolCall", toolCall: { toolCallId: "tc-1", toolName: "bash", displayName: "Bash", status: "pending-confirmation", invocationMessage: "FICTIONAL run", confirmationTitle: "FICTIONAL run?" } }]));
      const answer = await start(r);
      expect(answer.status).toBe(409);
      expect(answer.json.error.code).toBe("busy");
      expect(wrote(r.fake)).toEqual([]);
    });
  });
});

describe("chat/continue", () => {
  const RESUME = [pluginSkill("harness:resume")];
  const asking = () => ({
    status: 24, activeTurn: { id: "turn-live", startedAt: AT, message: { text: "FICTIONAL keep going", origin: { kind: "user" }, model: SELECTION }, usage: undefined,
      responseParts: [{ kind: "inputRequest", request: { id: "req-1", message: "FICTIONAL which way?", questions: [{ id: "q", kind: "text", title: "Q", message: "FICTIONAL which?", required: true }] } }] },
  });
  /** A temp COPILOT_HOME and HOME (VS Code's agentSessionData under it), restored after the test. */
  function home(): { copilot: string; agentDir: string; record(id: string): void; vscode(chat: string, sdk: string): void } {
    const root = mkdtempSync(join(tmpdir(), "herdr-continue-"));
    const was = { COPILOT_HOME: process.env["COPILOT_HOME"], HOME: process.env["HOME"] };
    process.env["COPILOT_HOME"] = join(root, "copilot");
    process.env["HOME"] = root;
    cleanups.push(() => {
      for (const [key, value] of Object.entries(was)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    });
    const copilot = join(root, "copilot");
    const agentDir = join(root, ".vscode-server", "data", "agentSessionData");
    return {
      copilot, agentDir,
      record(id) { mkdirSync(join(copilot, "session-state", id), { recursive: true }); writeFileSync(join(copilot, "session-state", id, "events.jsonl"), "{}\n"); },
      vscode(chat, sdk) {
        mkdirSync(join(agentDir, chat), { recursive: true });
        const db = new Database(join(agentDir, chat, "session.db"));
        db.run("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
        db.run("INSERT INTO session_metadata (key, value) VALUES ('defaultChatProviderData', ?)", [JSON.stringify({ sdkSessionId: sdk })]);
        db.close();
      },
    };
  }
  const go = (r: Rig) => call(r, "/api/host-chats/chat/continue", { session: sessionUri(1) });
  const settled = async (r: Rig) => {
    let now: any = null;
    await until("the continue job to end", () => { void job(r).then((each) => { now = each; }); return now?.endedAt != null; });
    return now;
  };
  const opened = (r: Rig) => sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1));

  it("continue on an idle chat opens \"/harness:resume <uuid>\" and archives nothing", async () => {
    home().record(uuid(1));
    const r = await rig({}, RESUME);
    const answer = await go(r);
    expect(answer.status).toBe(200);
    expect(answer.json.job).toMatchObject({ session: sessionUri(1), mode: "fresh" });
    const done = await settled(r);
    expect(done).toMatchObject({ state: "done", mode: "fresh", error: null, topic: null });
    expect(typeof done.newSession).toBe("string");
    const create = r.fake.requests.find((each) => each.method === "createSession")!;
    expect(create.params).toMatchObject({ channel: done.newSession, workingDirectories: [`file://${FOLDER}`] });
    expect(opened(r)!.action).toMatchObject({ message: { text: `/harness:resume ${uuid(1)}`, model: SELECTION } });
    expect(sent(r.fake, "chat/turnCancelled")).toEqual([]);
    expect(archived(r.fake)).toEqual([]);
  });

  it("continue on a chat asking a question cancels the turn and does not answer it", async () => {
    home().record(uuid(1));
    const r = await rig(asking(), RESUME);
    expect((await go(r)).status).toBe(200);
    expect(await settled(r)).toMatchObject({ state: "done", mode: "fresh" });
    expect(sent(r.fake, "chat/turnCancelled")).toEqual([{ channel: chatUri(1), action: { type: "chat/turnCancelled", turnId: "turn-live", duration: 0 } as StateAction }]);
    expect(sent(r.fake, "chat/inputCompleted")).toEqual([]);
    expect(opened(r)!.action).toMatchObject({ message: { text: `/harness:resume ${uuid(1)}` } });
    // stopped before the new chat was made
    const order: string[] = r.fake.dispatched.map((each) => each.action.type);
    expect(order.indexOf("chat/turnCancelled")).toBeLessThan(order.lastIndexOf("chat/turnStarted"));
    expect(archived(r.fake)).toEqual([]);
  });

  it("continue on a chat working without a question is refused busy", async () => {
    home().record(uuid(1));
    const r = await rig({ activeTurn: { id: "turn-live", startedAt: AT, message: { text: "FICTIONAL working", origin: { kind: "user" } }, usage: undefined, responseParts: [] } }, RESUME);
    const answer = await go(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("busy");
    expect(wrote(r.fake)).toEqual([]);
    expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
  });

  it("continue without a record is refused no_record before anything stops", async () => {
    home();
    const r = await rig(asking(), RESUME);
    const answer = await go(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("no_record");
    expect(wrote(r.fake)).toEqual([]);
    expect(r.fake.requests.some((each) => each.method === "createSession")).toBe(false);
  });

  it("continue without a resume skill is refused no_resume", async () => {
    home().record(uuid(1));
    const r = await rig({}, [pluginSkill("mattpocock-skills:resume")]);
    const answer = await go(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("no_resume");
    expect(wrote(r.fake)).toEqual([]);
  });

  it("continue takes the plain resume skill, and needs no handoff skill", async () => {
    home().record(uuid(1));
    const r = await rig({}, [{ ...HANDOFF_SKILL, id: "resume", name: "resume" }]);
    expect((await go(r)).status).toBe(200);
    await settled(r);
    expect(opened(r)!.action).toMatchObject({ message: { text: `/resume ${uuid(1)}` } });
  });

  it("continue resolves a VS Code chat to its sdkSessionId", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    home().vscode(uuid(1), other);
    const r = await rig({}, RESUME);
    expect((await go(r)).status).toBe(200);
    expect(await settled(r)).toMatchObject({ state: "done", mode: "fresh" });
    expect(opened(r)!.action).toMatchObject({ message: { text: `/harness:resume ${other}` } });
  });

  it("GET chat/handoff reads the continue job", async () => {
    home().record(uuid(1));
    const r = await rig({}, RESUME);
    await go(r);
    expect(await settled(r)).toMatchObject({ session: sessionUri(1), mode: "fresh" });
  });
});
