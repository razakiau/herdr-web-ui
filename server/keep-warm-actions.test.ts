import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KeepWarmAnswer, type KeepWarmKey, type KeepWarmSettings, keepWarmSettingsFrom, withWindow } from "../shared/keep-warm.ts";
import { requiresAuth } from "./auth.ts";
import { coolArchivedChat, handleKeepWarmAct, KeepWarmActions } from "./keep-warm-actions.ts";

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
