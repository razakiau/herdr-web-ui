import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostChatCost, HostChatRow } from "../../shared/host-chats.ts";
import type { ModelPrices } from "../../shared/usage.ts";
import { DeviceStore } from "../devices.ts";
import { createServer } from "../index.ts";
import { goalMessageId, goalPcOver, handleGoalsRequest, type GoalRoutesDeps } from "./routes.ts";
import type { GoalPc } from "./runner.ts";
import { GoalStore } from "./store.ts";

const MACHINE = "pc-fictional";
const SESSION = "session-fictional";
const T1 = "2026-11-13T18:00:00.000Z";
// work-x: 100k input tokens = $1
const PRICES: ModelPrices = { fictional: { "claude-work-x": { input: 10, output: 10 } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class FakePc implements GoalPc {
  chat = true;
  offline = false;
  input = 100_000;
  lastModel: string | null = "fictional/claude-work-x";
  async row(session: string): Promise<HostChatRow | null | "offline"> {
    if (this.offline) return "offline";
    return this.chat && session === SESSION ? { session, title: "FICTIONAL", status: "idle", modified_at: T1, cwd: null, unread: false, archived: false } : null;
  }
  async cost(session: string): Promise<HostChatCost | null | "offline"> {
    return { session, models: [{ model: "fictional/claude-work-x", input: this.input, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1 }], lastCallAt: T1, lastModel: this.lastModel, context: null } as HostChatCost;
  }
  async digest(): Promise<string | null | "offline"> { return "USER: FICTIONAL"; }
  async send(): Promise<boolean> { return true; }
}

const START = { machine: MACHINE, session: SESSION, objective: "FICTIONAL: make the tests pass", doneWhen: "FICTIONAL: bun test exits 0", capUsd: 10 };

describe("/api/goals", () => {
  let stateDir: string;
  let store: GoalStore;
  let pc: FakePc;
  let models: string[];
  let kicks: number;
  const deps = (): GoalRoutesDeps => ({
    store, pcs: (id) => id === MACHINE ? pc : null,
    prices: async () => ({ prices: PRICES, fallback: null }), models: async () => models, kick: () => { kicks += 1; },
  });
  const call = async (path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const request = new Request(`http://localhost${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await handleGoalsRequest(request, path, deps());
    return { status: response.status, json: await response.json() };
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-goal-routes-"));
    store = new GoalStore(stateDir);
    pc = new FakePc();
    models = ["cc/claude-opus-5-5", "fictional/gpt-judge-x"];
    kicks = 0;
  });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it("start → the list shows it active, nothing spent, the chat's cost so far as its baseline, a judge of another family", async () => {
    const started = await call("/api/goals/start", START);
    expect(started.status).toBe(200);
    expect(started.json.goal).toMatchObject({ machineId: MACHINE, session: SESSION, status: "active", capUsd: 10, judge: { model: "fictional/gpt-judge-x", warning: null } });
    expect(started.json.goal.baselineUsd).toBeCloseTo(1, 10);
    expect(kicks).toBe(1);
    const listed = await call("/api/goals");
    expect(listed.status).toBe(200);
    expect(listed.json.goals).toHaveLength(1);
    expect(listed.json.goals[0]).toMatchObject({ status: "active", spentUsd: 0, tone: "ok", raises: null, objective: START.objective, doneWhen: START.doneWhen });
  });

  it("a picked judge is taken as given, and one of the chat's family warns same_family", async () => {
    const started = await call("/api/goals/start", { ...START, judgeModel: "cc/claude-haiku-5-5" });
    expect(started.json.goal.judge).toEqual({ model: "cc/claude-haiku-5-5", warning: "same_family", checks: [] });
    // not checked against OmniRoute's list
    await call("/api/goals/stop", { machine: MACHINE, session: SESSION });
    expect((await call("/api/goals/start", { ...START, judgeModel: "no-such/model" })).json.goal.judge).toMatchObject({ model: "no-such/model", warning: null });
  });

  it("no model to judge with is 400 no_judge", async () => {
    models = [];
    pc.lastModel = null;
    expect(await call("/api/goals/start", START)).toMatchObject({ status: 400, json: { error: { code: "no_judge" } } });
    expect(store.list()).toEqual([]);
  });

  it("a chat whose last model has no price is 400 unpriced_model, unless the body allows it", async () => {
    // a cap counts that model's spend as $0: it would never stop the goal
    for (const model of ["fictional/claude-unpriced-x", "cc/claude-work-x"]) {
      pc.lastModel = model;
      expect(await call("/api/goals/start", START)).toMatchObject({ status: 400, json: { error: { code: "unpriced_model" } } });
      expect(store.list()).toEqual([]);
    }
    expect(await call("/api/goals/start", { ...START, allowUnpriced: "yes" })).toMatchObject({ status: 400, json: { error: { code: "unpriced_model" } } });
    const started = await call("/api/goals/start", { ...START, allowUnpriced: true });
    expect(started).toMatchObject({ status: 200, json: { goal: { status: "active" } } });
  });

  it("start twice → 409 goal_running", async () => {
    expect((await call("/api/goals/start", START)).status).toBe(200);
    expect(await call("/api/goals/start", START)).toMatchObject({ status: 409, json: { error: { code: "goal_running" } } });
  });

  it("refuses a cap of 0, an empty or too long text, an unknown PC and an unknown chat", async () => {
    for (const body of [{ ...START, capUsd: 0 }, { ...START, capUsd: -1 }, { ...START, capUsd: "10" }, { ...START, objective: " " }, { ...START, doneWhen: "x".repeat(4_001) }, { ...START, session: "" }]) {
      expect(await call("/api/goals/start", body)).toMatchObject({ status: 400, json: { error: { code: "invalid_body" } } });
    }
    expect(await call("/api/goals/start", { ...START, machine: "pc-unknown" })).toMatchObject({ status: 404, json: { error: { code: "no_machine" } } });
    pc.chat = false;
    expect(await call("/api/goals/start", START)).toMatchObject({ status: 404, json: { error: { code: "no_chat" } } });
    pc.offline = true;
    expect((await call("/api/goals/start", START)).status).toBe(503);
    expect(store.list()).toEqual([]);
  });

  it("raise: below what is spent → 409 below_spent, above → the new cap; a budget_limited goal continues and lists its raises first", async () => {
    await call("/api/goals/start", START);
    store.update(MACHINE, SESSION, (goal) => {
      goal.chatUsd = 9.5; goal.judgeUsd = 0.5; goal.status = "budget_limited"; goal.pauseReason = "cap";
      goal.judge.checks = [1, 2].map((n) => ({ at: T1, callAt: `${T1}${n}`, verdict: "not_met" as const, reason: "FICTIONAL", usd: 0.25, sent: true }));
    });
    const listed = (await call("/api/goals")).json.goals[0];
    // $10 over 2 checks = $5 a check: +2 → $20, +4 → $30
    expect(listed).toMatchObject({ status: "budget_limited", spentUsd: 10, tone: "over", raises: [20, 30] });
    expect(await call("/api/goals/raise", { machine: MACHINE, session: SESSION, capUsd: 10 })).toMatchObject({ status: 409, json: { error: { code: "below_spent" } } });
    expect((await call("/api/goals/raise", { machine: MACHINE, session: SESSION, capUsd: 0 })).status).toBe(400);
    const raised = await call("/api/goals/raise", { machine: MACHINE, session: SESSION, capUsd: 20 });
    expect(raised).toMatchObject({ status: 200, json: { goal: { status: "active", capUsd: 20, pauseReason: null, spentUsd: 10, raises: null } } });
    expect(await call("/api/goals/raise", { machine: MACHINE, session: "session-unknown", capUsd: 30 })).toMatchObject({ status: 404, json: { error: { code: "not_found" } } });
  });

  it("stop: the goal is stopped, raise then is goal_ended, and a new goal may start on the chat", async () => {
    await call("/api/goals/start", START);
    expect(await call("/api/goals/stop", { machine: MACHINE, session: SESSION })).toMatchObject({ status: 200, json: { goal: { status: "stopped" } } });
    expect(await call("/api/goals/raise", { machine: MACHINE, session: SESSION, capUsd: 50 })).toMatchObject({ status: 409, json: { error: { code: "goal_ended" } } });
    expect(await call("/api/goals/stop", { machine: MACHINE, session: "session-unknown" })).toMatchObject({ status: 404 });
    expect((await call("/api/goals/start", START)).json.goal.status).toBe("active");
  });

  it("stop leaves a met goal met", async () => {
    await call("/api/goals/start", START);
    store.update(MACHINE, SESSION, (goal) => { goal.status = "met"; });
    expect((await call("/api/goals/stop", { machine: MACHINE, session: SESSION })).json.goal.status).toBe("met");
  });

  it("resume: a paused goal is active again with no reason and no judged call, so the next tick judges the chat as it is now", async () => {
    await call("/api/goals/start", START);
    expect(await call("/api/goals/resume", { machine: MACHINE, session: SESSION })).toMatchObject({ status: 409, json: { error: { code: "not_paused" } } });
    store.update(MACHINE, SESSION, (goal) => { goal.status = "paused"; goal.pauseReason = "send_failed"; goal.lastJudgedCallAt = T1; });
    const resumed = await call("/api/goals/resume", { machine: MACHINE, session: SESSION });
    expect(resumed).toMatchObject({ status: 200, json: { goal: { status: "active", pauseReason: null, lastJudgedCallAt: null } } });
    expect(store.get(MACHINE, SESSION)).toMatchObject({ status: "active", pauseReason: null, lastJudgedCallAt: null });
  });

  it("answers 405 to the wrong method and 404 to an unknown action", async () => {
    expect((await call("/api/goals", {})).status).toBe(405);
    expect((await call("/api/goals/start")).status).toBe(405);
    expect((await call("/api/goals/pause", { machine: MACHINE, session: SESSION })).status).toBe(404);
  });
});

describe("goalPcOver", () => {
  it("reads a PC's row, cost and digest, and queues the next turn under an id made from the judged call", async () => {
    const asked: { path: string; init?: RequestInit }[] = [];
    const pc = goalPcOver(MACHINE, async (path, init) => {
      asked.push({ path, ...(init ? { init } : {}) });
      if (path === "/api/host-chats/chats") return Response.json({ chats: [{ session: SESSION, status: "idle" }] });
      if (path.startsWith("/api/host-chats/costs?")) return Response.json({ chat: { session: SESSION, models: [], lastCallAt: T1, context: null }, calls: [] });
      if (path.startsWith("/api/host-chats/goal-digest?")) return Response.json({ error: { code: "no_log" } }, { status: 404 });
      if (path === "/api/host-chats/chat/send") return Response.json({ queued: true });
      return null;
    });
    expect(await pc.row(SESSION)).toMatchObject({ session: SESSION, status: "idle" });
    expect(await pc.row("session-unknown")).toBeNull();
    expect(await pc.cost(SESSION, null)).toMatchObject({ lastCallAt: T1 });
    expect(asked.at(-1)!.path).toBe(`/api/host-chats/costs?session=${SESSION}`);
    expect(await pc.cost(SESSION, "parent-fictional")).toMatchObject({ lastCallAt: T1 });
    expect(asked.at(-1)!.path).toBe(`/api/host-chats/costs?session=${SESSION}&parent=parent-fictional`);
    expect(await pc.digest(SESSION, "parent-fictional")).toBeNull();
    expect(asked.at(-1)!.path).toBe(`/api/host-chats/goal-digest?session=${SESSION}&parent=parent-fictional`);
    expect(await pc.send(SESSION, "FICTIONAL next turn", T1)).toBe(true);
    const sent = JSON.parse(String(asked.at(-1)!.init!.body));
    expect(sent).toEqual({ session: SESSION, text: "FICTIONAL next turn", mode: "queue", id: goalMessageId(MACHINE, SESSION, T1) });
    // the bridge takes a UUID only; the same call is the same id, another call another
    expect(sent.id).toMatch(UUID);
    expect(goalMessageId(MACHINE, SESSION, T1)).toBe(sent.id);
    expect(goalMessageId(MACHINE, SESSION, "2026-11-13T18:05:00.000Z")).not.toBe(sent.id);
  });

  it("a PC that does not answer is offline, and a send that fails is false", async () => {
    const pc = goalPcOver(MACHINE, async () => null);
    expect(await pc.row(SESSION)).toBe("offline");
    expect(await pc.cost(SESSION, null)).toBe("offline");
    expect(await pc.digest(SESSION, null)).toBe("offline");
    expect(await pc.send(SESSION, "FICTIONAL", T1)).toBe(false);
    const down = goalPcOver(MACHINE, async () => Response.json({ error: { code: "host_down" } }, { status: 503 }));
    expect(await down.row(SESSION)).toBe("offline");
    expect(await down.send(SESSION, "FICTIONAL", T1)).toBe(false);
  });
});

it("a watching device's POST to /api/goals is refused read_only; its GET is answered", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-goal-watch-"));
  const devices = new DeviceStore(root);
  const watch = devices.pair(devices.startPairing().code, "Watch", "watch")!;
  devices.match(watch.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-goal-watch", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "x-herdr-machine": "1", "content-type": "application/json", cookie: `ovis_device=${watch.token}` };
  try {
    expect((await fetch(`${base}/api/goals`, { headers })).status).toBe(200);
    for (const action of ["start", "raise", "stop", "resume"]) {
      const response = await fetch(`${base}/api/goals/${action}`, { method: "POST", headers, body: JSON.stringify({ ...START, capUsd: 20 }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("a request with no credentials to /api/goals is 401, GET and POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-goal-auth-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-goal-auth", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/goals`, { headers: { "x-herdr-machine": "1" } })).status).toBe(401);
    const response = await fetch(`${base}/api/goals/start`, { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify(START) });
    expect(response.status).toBe(401);
    expect(new GoalStore(root).list()).toEqual([]);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
