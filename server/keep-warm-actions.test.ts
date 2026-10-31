import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KeepWarmAnswer, type KeepWarmKey, type KeepWarmSettings, keepWarmSettingsFrom, withWindow } from "../shared/keep-warm.ts";
import { requiresAuth } from "./auth.ts";
import type { HandoffJob } from "../shared/host-chats.ts";
import { bridgeHandoff, coolArchivedChat, createHandoffFollower, type HandoffAct, HANDOFF_ACT_TTL_MS, handleKeepWarmAct, KeepWarmActions } from "./keep-warm-actions.ts";

const H = 3_600_000;
const FROM = Date.parse("2026-10-30T08:00:00Z");
const UNTIL = FROM + 8 * H;

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "ovis-keepwarm-act-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

const key = (over: Partial<KeepWarmKey> = {}): KeepWarmKey => ({ key: "k1", model: "claude-opus-4.8", apiKey: "copilot", tokens: 268_000, prompt: 268_000, lastRealAt: FROM,
  lastPingAt: null, nextPingAt: null, until: UNTIL, pings: 0, usd: 0, restartUsd: 2.14, missed: false, disabled: false, kept: true, ...over });

/** a fake OmniRoute link that keeps what was saved */
function link(keys: KeepWarmKey[], settings: KeepWarmSettings = {}) {
  const saved: KeepWarmSettings[] = [];
  let current = settings;
  const answer = (): KeepWarmAnswer => ({ ok: true, state: { v: 1, at: 0, enabled: true, windowHours: 8, fusePerDay: 50, today: { day: "", pings: 0, usd: 0, avoided: 0, avoidedUsd: 0, fuseHit: false }, keys } as never, settings: current, writable: true, problem: null });
  return {
    saved,
    keepWarm: async () => answer(),
    saveKeepWarm: async (value: unknown) => { current = keepWarmSettingsFrom(value); saved.push(current); return answer(); },
  };
}

describe("withWindow (the plugin's per-chat window, ZAC-260)", () => {
  it("keeps 8 h past the announced end, at most 48 h after the real call; cool ends it now", () => {
    expect(withWindow({}, "k1", FROM, UNTIL, "extend", UNTIL - 15 * 60_000).extend).toEqual({ k1: { from: FROM, until: UNTIL + 8 * H } });
    // a second tap on the same alert adds nothing
    const once = withWindow({}, "k1", FROM, UNTIL, "extend", UNTIL - 60_000);
    expect(withWindow(once, "k1", FROM, UNTIL, "extend", UNTIL - 30_000).extend?.["k1"]?.until).toBe(UNTIL + 8 * H);
    expect(withWindow({}, "k1", FROM, FROM + 45 * H, "extend", FROM + 45 * H).extend?.["k1"]?.until).toBe(FROM + 48 * H);
    expect(withWindow({}, "k1", FROM, UNTIL, "cool", UNTIL - 60_000).extend).toEqual({ k1: { from: FROM, until: UNTIL - 60_000 } });
  });

  it("keeps the other settings, and drops windows over for an hour", () => {
    const settings: KeepWarmSettings = { enabled: true, disabled: ["k9"], extend: { old: { from: 0, until: UNTIL - 2 * H }, live: { from: 1, until: UNTIL + H } } };
    const next = withWindow(settings, "k1", FROM, UNTIL, "extend", UNTIL);
    expect(next.enabled).toBe(true);
    expect(next.disabled).toEqual(["k9"]);
    expect(Object.keys(next.extend ?? {}).sort()).toEqual(["k1", "live"]);
  });

  it("reads windows back from the plugin's config, dropping malformed ones", () => {
    expect(keepWarmSettingsFrom({ extend: { k1: { from: 1, until: 2 }, k2: { from: "x", until: 2 }, k3: null } }).extend).toEqual({ k1: { from: 1, until: 2 } });
    expect(keepWarmSettingsFrom({ extend: [] }).extend).toBeUndefined();
  });
});

describe("the window-end alert's buttons", () => {
  it("are signed with a key of this server's own, kept private", () => {
    const actions = new KeepWarmActions(stateDir, () => UNTIL);
    const path = actions.path({ key: "k1", from: FROM, announced: UNTIL, how: "extend" });
    expect(actions.read(path)).toEqual({ key: "k1", from: FROM, announced: UNTIL, how: "extend" });
    expect(statSync(join(stateDir, "keepwarm-actions.json")).mode & 0o777).toBe(0o600);
    // the same key after a restart: an alert sent before it still works
    expect(new KeepWarmActions(stateDir, () => UNTIL).read(path)).not.toBeNull();
  });

  it("refuse an altered button, another server's, and one past its hour of grace", () => {
    const actions = new KeepWarmActions(stateDir, () => UNTIL);
    const path = actions.path({ key: "k1", from: FROM, announced: UNTIL, how: "cool" });
    const [, payload, signature] = /act\/([^.]+)\.(.+)$/.exec(path)!;
    const forged = Buffer.from(JSON.stringify(["k1", FROM, UNTIL, "extend"])).toString("base64url");
    expect(actions.read(`/api/keepwarm/act/${forged}.${signature}`)).toBeNull();
    const other = mkdtempSync(join(tmpdir(), "ovis-keepwarm-other-"));
    try { expect(new KeepWarmActions(other, () => UNTIL).read(path)).toBeNull(); } finally { rmSync(other, { recursive: true, force: true }); }
    expect(new KeepWarmActions(stateDir, () => UNTIL + H + 1).read(path)).toBeNull();
    expect(actions.read(`/api/keepwarm/act/${payload}`)).toBeNull();
  });

  it("need no sign-in: the ntfy app runs them with no cookie", () => {
    const path = new KeepWarmActions(stateDir).path({ key: "k1", from: FROM, announced: UNTIL, how: "extend" });
    expect(requiresAuth(path)).toBe(false);
    expect(requiresAuth("/api/keepwarm/act/x")).toBe(true);
    expect(requiresAuth("/api/usage/omniroute/keepwarm")).toBe(true);
  });

  it("set the chat's window for the call the alert was about", async () => {
    const actions = new KeepWarmActions(stateDir, () => UNTIL);
    const fake = link([key()], { enabled: true });
    const path = actions.path({ key: "k1", from: FROM, announced: UNTIL, how: "extend" });
    const response = await handleKeepWarmAct(new Request(`http://x${path}`, { method: "POST" }), path, actions, fake, () => UNTIL - 10 * 60_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, until: UNTIL + 8 * H });
    expect(fake.saved).toEqual([{ enabled: true, extend: { k1: { from: FROM, until: UNTIL + 8 * H } } }]);
  });

  it("change nothing once the chat moved on, for a forged one, or on a GET", async () => {
    const actions = new KeepWarmActions(stateDir, () => UNTIL);
    const path = actions.path({ key: "k1", from: FROM, announced: UNTIL, how: "extend" });
    const moved = link([key({ lastRealAt: FROM + H })]);
    expect((await handleKeepWarmAct(new Request(`http://x${path}`, { method: "POST" }), path, actions, moved)).status).toBe(409);
    const gone = link([]);
    expect((await handleKeepWarmAct(new Request(`http://x${path}`, { method: "POST" }), path, actions, gone)).status).toBe(409);
    const fake = link([key()]);
    const forged = path.replace(/.$/, (last) => last === "A" ? "B" : "A");
    expect((await handleKeepWarmAct(new Request(`http://x${forged}`, { method: "POST" }), forged, actions, fake)).status).toBe(404);
    expect((await handleKeepWarmAct(new Request(`http://x${path}`), path, actions, fake)).status).toBe(405);
    expect([...moved.saved, ...gone.saved, ...fake.saved]).toEqual([]);
  });
});

describe("an archived chat's cool (ZAC-262)", () => {
  const NOW = FROM + H;
  it("saves \"Let it cool\" for the call push matched, keeping the owner's settings", async () => {
    const fake = link([key()], { enabled: true });
    expect(await coolArchivedChat(key(), fake, () => NOW)).toBe(true);
    expect(fake.saved).toEqual([{ ...withWindow({ enabled: true }, "k1", FROM, NOW, "cool", NOW) }]);
  });

  it("saves nothing for a key let go, and answers false when the plugin moved past the call or lost it", async () => {
    const letGo = link([key({ kept: false })]);
    expect(await coolArchivedChat(key(), letGo, () => NOW)).toBe(true);
    const moved = link([key({ lastRealAt: FROM + H })]);
    expect(await coolArchivedChat(key(), moved, () => NOW)).toBe(false);
    const gone = link([]);
    expect(await coolArchivedChat(key(), gone, () => NOW)).toBe(false);
    expect([...letGo.saved, ...moved.saved, ...gone.saved]).toEqual([]);
  });
});

describe("the alerts' \"Hand off now\" (ZAC-262)", () => {
  const SENT = FROM + H;
  const SESSION = "copilotcli:/0f9a3c1e-7b2d-4c8e-9a51-3e6f2b7d8c40";
  const handoff = (over: Partial<HandoffAct> = {}): HandoffAct => ({ how: "handoff", machineId: "5b0c7f3e-2d4a-4e1b-9c6f-8a7d3e2b1c0f", session: SESSION, title: "fix the build", expires: SENT + HANDOFF_ACT_TTL_MS, mode: "note", ...over });

  it("is signed like the window's buttons, and works until 2 h after the alert went", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    const path = actions.path(handoff());
    expect(actions.read(path)).toEqual(handoff());
    expect(requiresAuth(path)).toBe(false);
    expect(new KeepWarmActions(stateDir, () => SENT + HANDOFF_ACT_TTL_MS).read(path)).not.toBeNull();
    expect(new KeepWarmActions(stateDir, () => SENT + HANDOFF_ACT_TTL_MS + 1).read(path)).toBeNull();
  });

  it("is signed in its own domain: neither shape reads under the other's signature", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    actions.path(handoff()); // makes the key
    const secret = Buffer.from((JSON.parse(readFileSync(join(stateDir, "keepwarm-actions.json"), "utf8")) as { secret: string }).secret, "base64url");
    const signed = (domain: string, fields: unknown[]) => {
      const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
      return `/api/keepwarm/act/${payload}.${createHmac("sha256", secret).update(`${domain}:${payload}`).digest("base64url")}`;
    };
    const h = ["h", "mac", SESSION, "T", SENT + HANDOFF_ACT_TTL_MS];
    const act = ["k1", FROM, UNTIL, "extend"];
    expect(actions.read(signed("keepwarm-handoff", h))).not.toBeNull();
    expect(actions.read(signed("keepwarm-act", act))).not.toBeNull();
    expect(actions.read(signed("keepwarm-act", h))).toBeNull();
    expect(actions.read(signed("keepwarm-handoff", act))).toBeNull();
  });

  it("a fresh link round-trips its mode", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    expect(actions.read(actions.path(handoff({ mode: "fresh" })))).toEqual(handoff({ mode: "fresh" }));
    expect(actions.read(actions.path(handoff({ mode: "note" })))).toEqual(handoff({ mode: "note" }));
  });

  it("a 5-field link signed before the deploy reads as note", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    actions.path(handoff()); // makes the key
    const secret = Buffer.from((JSON.parse(readFileSync(join(stateDir, "keepwarm-actions.json"), "utf8")) as { secret: string }).secret, "base64url");
    const signed = (fields: unknown[]) => {
      const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
      return `/api/keepwarm/act/${payload}.${createHmac("sha256", secret).update(`keepwarm-handoff:${payload}`).digest("base64url")}`;
    };
    const old = ["h", handoff().machineId, SESSION, "fix the build", SENT + HANDOFF_ACT_TTL_MS];
    expect(actions.read(signed(old))).toEqual(handoff({ mode: "note" }));
    // a sixth field that is not a mode, or a seventh, is not one of ours
    expect(actions.read(signed([...old, "loud"]))).toBeNull();
    expect(actions.read(signed([...old, "fresh", 1]))).toBeNull();
  });

  it("refuses an altered one", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    const path = actions.path(handoff());
    const [, , signature] = /act\/([^.]+)\.(.+)$/.exec(path)!;
    const forged = Buffer.from(JSON.stringify(["h", "other-pc", SESSION, "fix the build", SENT + HANDOFF_ACT_TTL_MS])).toString("base64url");
    expect(actions.read(`/api/keepwarm/act/${forged}.${signature}`)).toBeNull();
  });

  it("cuts the title to 80 characters, and fits a long session with a long non-ASCII title", () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    const title = "🔥".repeat(200);
    const session = `copilotcli:/${"x".repeat(200)}`;
    expect(actions.read(actions.path(handoff({ title, session })))).toEqual(handoff({ title: "🔥".repeat(80), session }));
  });

  it("is handed to the hand-off starter, with no keep-warm read", async () => {
    const actions = new KeepWarmActions(stateDir, () => SENT);
    const path = actions.path(handoff());
    const fake = link([]);
    const started: string[][] = [];
    const response = await handleKeepWarmAct(new Request(`http://x${path}`, { method: "POST" }), path, actions, fake, () => SENT, {
      startHandoff: async (machineId, session, title, mode) => { started.push([machineId, session, title, mode]); return new Response(null, { status: 202 }); },
    });
    expect(response.status).toBe(202);
    expect(started).toEqual([[handoff().machineId, SESSION, "fix the build", "note"]]);
    const fresh = actions.path(handoff({ mode: "fresh" }));
    await handleKeepWarmAct(new Request(`http://x${fresh}`, { method: "POST" }), fresh, actions, fake, () => SENT, {
      startHandoff: async (machineId, session, title, mode) => { started.push([machineId, session, title, mode]); return new Response(null, { status: 202 }); },
    });
    expect(started[1]).toEqual([handoff().machineId, SESSION, "fix the build", "fresh"]);
    expect(fake.saved).toEqual([]);
  });
});

describe("following a hand-off from an alert (ZAC-262)", () => {
  const job = (state: HandoffJob["state"], over: Partial<HandoffJob> = {}): HandoffJob => ({ session: "s1", mode: "note", state, startedAt: 0, endedAt: null, topic: null, newSession: null, error: null, ...over });
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  /** a bridge that answers the POST with `post`, then each GET with the next of `gets` */
  function follower(post: Response | null, gets: (Response | null)[] = []) {
    const told: { title: string; body: string; machineId: string; session: string }[] = [];
    const calls: string[] = [];
    const handoffs = createHandoffFollower({
      bridge: async (machineId, method, _session, mode) => { calls.push(`${method} ${machineId} ${mode}`); return method === "POST" ? post : gets.shift() ?? null; },
      tell: async (alert) => { told.push(alert); },
      pcName: (machineId) => machineId === "mac" ? "Mac" : "this PC",
      pollMs: 1,
    });
    return { handoffs, told, calls };
  }

  it("tells the new chat once the job is done, and its tap opens it", async () => {
    const { handoffs, told } = follower(json({ job: job("sending") }), [json({ job: job("waiting") }), json({ job: job("done", { newSession: "s2" }) })]);
    expect((await handoffs.start("mac", "s1", "T", "note")).status).toBe(202);
    await handoffs.settled();
    expect(told).toEqual([{ title: "Handed off \"T\" → new chat", body: "T", machineId: "mac", session: "s2" }]);
  });

  it("says why it could not start: at work, no /handoff, no folder, just written, PC offline, an older bridge", async () => {
    const cases: [Response | null, string][] = [
      [json({ error: { code: "busy" } }, 409), "Couldn't hand off \"T\": it's working. Tap again when it's done."],
      [json({ error: { code: "no_handoff" } }, 409), "Couldn't hand off \"T\": this chat has no /handoff"],
      [json({ error: { code: "no_folder" } }, 409), "Couldn't hand off \"T\": this chat has no /handoff"],
      [json({ error: { code: "recent_handoff" } }, 409), "A hand-off of \"T\" was just written: open the chat"],
      [null, "Couldn't hand off \"T\": its PC is offline"],
      [json({ error: { code: "agent_host_down" } }, 503), "Couldn't hand off \"T\": its PC is offline"],
      [json({ error: { code: "not_found" } }, 404), "Update the bridge on Mac to hand off from here"],
    ];
    for (const [post, title] of cases) {
      const { handoffs, told } = follower(post);
      await handoffs.start("mac", "s1", "T", "note");
      await handoffs.settled();
      expect(told).toEqual([{ title, body: "T", machineId: "mac", session: "s1" }]);
    }
  });

  it("tells a job that ended short of a new chat, opening the new one when there is one", async () => {
    const cases: [HandoffJob, string, string][] = [
      [job("no_resume"), "Hand-off note written for \"T\", but no /resume line: open the chat", "s1"],
      [job("timeout"), "Hand-off of \"T\" didn't finish: open the chat", "s1"],
      [job("failed", { newSession: "s2", error: "resume_not_sent" }), "Hand-off of \"T\" didn't finish: open the chat", "s2"],
    ];
    for (const [ended, title, session] of cases) {
      const { handoffs, told } = follower(json({ job: job("sending") }), [json({ job: ended })]);
      await handoffs.start("mac", "s1", "T", "note");
      await handoffs.settled();
      expect(told).toEqual([{ title, body: "T", machineId: "mac", session }]);
    }
  });

  it("loses track when the bridge forgets the job or the PC drops, and gives up after its limit", async () => {
    for (const gets of [[json({ error: { code: "job_not_found" } }, 404)], [null]]) {
      const { handoffs, told } = follower(json({ job: job("sending") }), gets);
      await handoffs.start("mac", "s1", "T", "note");
      await handoffs.settled();
      expect(told.map((each) => each.title)).toEqual(["Lost track of the hand-off of \"T\": open the chat"]);
    }
    let at = 0;
    const told: string[] = [];
    const slow = createHandoffFollower({ bridge: async () => { at += 10 * 60_000; return json({ job: job("waiting") }); }, tell: async (alert) => { told.push(alert.title); }, pcName: () => "Mac", pollMs: 1, now: () => at });
    await slow.start("mac", "s1", "T", "note");
    await slow.settled();
    expect(told).toEqual(["Lost track of the hand-off of \"T\": open the chat"]);
  });

  it("a fresh tap POSTs chat/continue", async () => {
    const { handoffs, told, calls } = follower(json({ job: job("starting", { mode: "fresh" }) }), [json({ job: job("done", { mode: "fresh", newSession: "s2" }) })]);
    expect((await handoffs.start("mac", "s1", "T", "fresh")).status).toBe(202);
    await handoffs.settled();
    expect(calls).toEqual(["POST mac fresh", "GET mac fresh"]);
    expect(told).toEqual([{ title: "Handed off \"T\" → new chat", body: "Cold: the new chat reads the old one's record (no note written). Old chat kept.", machineId: "mac", session: "s2" }]);
  });

  it("an old bridge's 404 on continue says update the bridge", async () => {
    const { handoffs, told, calls } = follower(json({ error: { code: "not_found" } }, 404));
    await handoffs.start("mac", "s1", "T", "fresh");
    await handoffs.settled();
    expect(calls).toEqual(["POST mac fresh"]);
    expect(told.map((each) => each.title)).toEqual(["Update the bridge on Mac to hand off from here"]);
  });

  it("says why a fresh one could not start: no record, no /resume, no folder, the chat gone, at work", async () => {
    const cases: [Response, string][] = [
      [json({ error: { code: "no_record" } }, 409), "Couldn't hand off \"T\": its record isn't on its PC"],
      [json({ error: { code: "no_resume" } }, 409), "Couldn't hand off \"T\": this chat has no /resume"],
      [json({ error: { code: "no_folder" } }, 409), "Couldn't hand off \"T\": its folder isn't on its PC"],
      [json({ error: { code: "host_chat_missing" } }, 404), "Lost track of the hand-off of \"T\": open the chat"],
      [json({ error: { code: "busy" } }, 409), "Couldn't hand off \"T\": it's working. Tap again when it's done."],
    ];
    for (const [post, title] of cases) {
      const { handoffs, told } = follower(post);
      await handoffs.start("mac", "s1", "T", "fresh");
      await handoffs.settled();
      expect(told).toEqual([{ title, body: "T", machineId: "mac", session: "s1" }]);
    }
  });

  it("follows one job per chat: a second tap while it runs starts nothing more", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const told: string[] = [];
    const handoffs = createHandoffFollower({
      bridge: async (_machineId, method) => { calls.push(method); if (method === "GET") await held; return json({ job: job(method === "POST" ? "sending" : "done", { newSession: "s2" }) }); },
      tell: async (alert) => { told.push(alert.title); }, pcName: () => "Mac", pollMs: 1,
    });
    expect((await handoffs.start("mac", "s1", "T", "note")).status).toBe(202);
    await Bun.sleep(10); // fixed wait: the first follow reaches its GET
    expect((await handoffs.start("mac", "s1", "T", "note")).status).toBe(202);
    release();
    await handoffs.settled();
    expect(calls).toEqual(["POST", "GET"]);
    expect(told).toEqual(["Handed off \"T\" → new chat"]);
  });
});

describe("asking a PC's bridge for a hand-off (ZAC-262)", () => {
  it("calls a remote bridge with its token, never following a redirect", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const bridge = bridgeHandoff({
      endpoint: (id) => id === "mac" ? { url: "https://mac.example:8443", token: "t0k" } : undefined,
      local: null,
      fetch: async (url, init) => { seen.push({ url: String(url), init: init! }); return Response.json({ job: null }); },
    });
    await bridge("mac", "GET", "copilotcli:/a b", "note");
    await bridge("mac", "POST", "copilotcli:/a b", "note");
    await bridge("mac", "POST", "copilotcli:/a b", "fresh");
    await bridge("mac", "GET", "copilotcli:/a b", "fresh");
    expect(seen.map((each) => each.url)).toEqual([
      "https://mac.example:8443/api/host-chats/chat/handoff?session=copilotcli%3A%2Fa%20b",
      "https://mac.example:8443/api/host-chats/chat/handoff",
      "https://mac.example:8443/api/host-chats/chat/continue",
      "https://mac.example:8443/api/host-chats/chat/handoff?session=copilotcli%3A%2Fa%20b",
    ]);
    for (const { init } of seen) {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer t0k");
      expect(init.redirect).toBe("error");
    }
    expect(seen[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({ session: "copilotcli:/a b" });
  });

  it("answers null for a PC not connected, or this PC without an agent host; calls this one's in process", async () => {
    const none = bridgeHandoff({ endpoint: () => undefined, local: null, fetch: async () => { throw new Error("no fetch"); } });
    expect(await none("mac", "POST", "s1", "note")).toBeNull();
    expect(await none("local", "POST", "s1", "note")).toBeNull();
    const asked: string[] = [];
    const here = bridgeHandoff({ endpoint: () => undefined, local: async (request, pathname) => { asked.push(`${request.method} ${pathname} ${new URL(request.url).search}`); return Response.json({ job: null }); }, fetch: async () => { throw new Error("no fetch"); } });
    expect((await here("local", "GET", "s 1", "fresh"))?.status).toBe(200);
    expect((await here("local", "POST", "s 1", "fresh"))?.status).toBe(200);
    expect(asked).toEqual(["GET /api/host-chats/chat/handoff ?session=s%201", "POST /api/host-chats/chat/continue "]);
  });
});
