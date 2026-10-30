import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/** The `/handoff` turn the job started, once it is in the mirror. */
async function handoffTurn(r: Rig): Promise<string> {
  await until("the /handoff turn", () => r.conn.chat(sessionUri(1))?.activeTurn?.message.text === "/handoff");
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
});

describe("chat/handoff", () => {
  it("refuses a busy chat with 409 busy, nothing dispatched", async () => {
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

  it("recent_handoff: the newest user message is a /handoff 10 min old and no job runs", async () => {
    const r = await rig({ turns: [user("FICTIONAL earlier"), user("/handoff", new Date(Date.now() - 10 * 60_000).toISOString())] });
    const answer = await start(r);
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe("recent_handoff");
    expect(wrote(r.fake)).toEqual([]);
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

  it("happy path: /resume <topic> starts a new chat in the old folder on the old model, then the old one is archived", async () => {
    const r = await rig();
    const answer = await start(r);
    expect(answer.json.job).toMatchObject({ session: sessionUri(1), endedAt: null, newSession: null });
    const turnId = await handoffTurn(r);
    expect(sent(r.fake, "chat/turnStarted")[0]!.action).toMatchObject({ message: { text: "/handoff", model: SELECTION } });
    expect((await job(r)).state).toBe("waiting");
    reply(r, turnId, "FICTIONAL note written.\nStart the next chat with: /resume zac-262");
    await until("the archive", () => r.fake.dispatched.some((each) => each.action.type === "session/isArchivedChanged"));
    for (let i = 0; i < 100 && (await job(r)).state !== "done"; i++) await Bun.sleep(10);
    const done = await job(r);
    expect(done).toMatchObject({ state: "done", topic: "zac-262", error: null });
    expect(typeof done.newSession).toBe("string");
    const create = r.fake.requests.findIndex((each) => each.method === "createSession");
    expect(r.fake.requests[create]!.params).toMatchObject({ channel: done.newSession, workingDirectories: [`file://${FOLDER}`] });
    const resumed = sent(r.fake, "chat/turnStarted").find((each) => each.channel !== chatUri(1))!;
    expect(resumed.action).toMatchObject({ message: { text: "/resume zac-262", model: SELECTION } });
    // created (and its message sent) before the archive
    const order: string[] = r.fake.dispatched.map((each) => each.action.type);
    expect(order.lastIndexOf("chat/turnStarted")).toBeLessThan(order.indexOf("session/isArchivedChanged"));
    expect(sent(r.fake, "session/isArchivedChanged")).toEqual([{ channel: sessionUri(1), action: { type: "session/isArchivedChanged", isArchived: true } as StateAction }]);
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
});
