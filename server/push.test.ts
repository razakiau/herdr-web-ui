import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneAlertsMuted, type AlertPrefs } from "../shared/notify-policy.ts";
import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";
import { coldAlertBody, coldFromEnv, createPushService, handlePushRequest, parseSubscription, windowAlertBody, type ColdPrices, type PushService } from "./push.ts";
import type { KeepWarmKey } from "../shared/keep-warm.ts";
import type { HostChatCost, HostChatRow } from "../shared/host-chats.ts";
import type { HandoffAct } from "./keep-warm-actions.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { privateStateFs } from "./private-state.ts";

/**
 * The server half of web push, end to end against a fake push service that decrypts
 * and verifies like a real device would. No herdr needed: panes are handed in the way
 * the collector hands them (seed) and status changes the way it reports them.
 */

function pane(paneId: string, status: AgentStatus, title: string): HerdrPane {
  return {
    pane_id: paneId,
    agent_status: status,
    terminal_title: title,
    focused: false,
    revision: 0,
    tab_id: "t1",
    terminal_id: "term_1",
    workspace_id: "w1",
  };
}

let stateDir: string;
let fake: FakePushService;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-push-"));
  fake = await startFakePushService();
});

afterEach(() => {
  fake.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Alerts go out at once, and each status change is awaited until its alert went out. */
function subscribed(options: Partial<Parameters<typeof createPushService>[0]> = {}): PushService {
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, ...options });
  // the cold-cache alert is opt-in (ZAC-260): a device here wants it, so its tests can hear it
  push.subscribe(fake.subscription, options.cold ? { input: true, done: "long", cold: true } : undefined);
  const onStatus = push.onStatus;
  push.onStatus = async (...args) => {
    await onStatus(...args);
    await push.settled();
  };
  return push;
}

describe("weekly digest (ZAC-262)", () => {
  it("goes to a device with cold alerts on, its tap naming the week; none to a device without", async () => {
    const push = subscribed({ cold: { thresholdUsd: 1, lifetimeMs: 3_600_000, leadMs: 600_000 } });
    await push.digest("2026-10-26", "📊 $184 this week", "4 hand-offs");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload).toMatchObject({ pane_id: null, digest: "2026-10-26", title: "📊 $184 this week", body: "4 hand-offs", tag: "digest:2026-10-26" });
    const quiet = createPushService({ loopbackHttp: true, stateDir: mkdtempSync(join(tmpdir(), "ovis-push-quiet-")) });
    quiet.subscribe(fake.subscription);
    await quiet.digest("2026-10-26", "t", "b");
    expect(fake.received).toHaveLength(1);
  });
});

describe("parseSubscription", () => {
  it("accepts what a browser's PushSubscription.toJSON() produces", () => {
    const browserJson = { ...fake.subscription, expirationTime: null };
    // the fake's endpoint is loopback http, which only a service made for it accepts
    expect(parseSubscription(browserJson, { loopbackHttp: true })).toEqual(fake.subscription);
  });

  it("rejects endpoints and keys a push service could never have issued", () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: "ftp://push.example/x", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", keys })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: "AAAA" } })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription("subscription")).toBeNull();
    // a plain-http endpoint is never a browser subscription, and it is the shape that
    // would turn the sender into a POST from inside the user's network
    expect(parseSubscription({ endpoint: "http://169.254.169.254/latest/meta-data/", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys })).toBeNull();
  });

  it("refuses http on loopback too, unless the push service was made for the tests' fake", () => {
    const { keys } = fake.subscription;
    for (const endpoint of ["http://127.0.0.1:9000/push/1", "http://[::1]:9000/push/1", "http://localhost:9000/push/1"]) {
      expect(parseSubscription({ endpoint, keys })).toBeNull();
      expect(parseSubscription({ endpoint, keys }, { loopbackHttp: true })).not.toBeNull();
    }
    expect(parseSubscription({ endpoint: "https://127.0.0.1:9000/push/1", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "https://push.example/x", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys }, { loopbackHttp: true })).toBeNull();
  });
});

describe("push state", () => {
  it("keeps one owner-only VAPID key pair across restarts", () => {
    const key = createPushService({ loopbackHttp: true, stateDir }).publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed key file instead of rotating the key under every device", () => {
    writeFileSync(join(stateDir, "vapid.json"), "{}\n");
    expect(() => createPushService({ loopbackHttp: true, stateDir }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("keeps subscriptions across restarts", async () => {
    subscribed();
    expect(statSync(join(stateDir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    expect(await restarted.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
  });

  it("does not publish an unpersisted VAPID key", () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.publicKey()).toThrow("EIO");
      // no second call may hand out the key that never reached disk
      expect(() => push.publicKey()).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(readdirSync(stateDir)).toEqual([]);
    const key = push.publicKey();
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
  });

  it("keeps the subscriptions in use unchanged when their write fails", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
    try {
      expect(() => push.subscribe(fake.subscription, undefined, "0123456789abcdef")).toThrow("EXDEV");
    } finally { rename.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
    expect(existsSync(join(stateDir, "push-subscriptions.json"))).toBe(false);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    push.subscribe(fake.subscription, undefined, "0123456789abcdef");
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.revokeDevice("0123456789abcdef")).toThrow("EIO");
      expect(() => push.unsubscribe(fake.subscription.endpoint)).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("push delivery", () => {
  it("delivers the real finish after a late unknown snapshot arrives during a new Codex turn", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    const atRest = { panes: [{ ...pane(id, "unknown", "Codex regression"), agent: "codex" }], agents: [] } as unknown as SessionSnapshot;
    push.seed(atRest.panes);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = completions.readSnapshot(() => pending);
    await push.onStatus(id, completions.observe(id, "working", "codex"));
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(completions.seen(id)).toBe(false);
    expect(fake.received).toHaveLength(0);

    expect(completions.observe(id, "unknown", "codex")).toBe("done");
    await push.onStatus(id, "done");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload.body).toBe("work finished");
    expect(fake.received[0]!.vapidValid).toBe(true);
  });

  it("delivers one done alert per Codex finish while an agent handoff keeps working", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    push.seed([pane(id, "unknown", "Codex regression")]);
    const report = async (status: AgentStatus, agent: string) => {
      const presented = completions.observe(id, status, agent);
      await push.onStatus(id, presented);
      return presented;
    };

    for (let turn = 0; turn < 2; turn++) {
      expect(await report("working", "codex")).toBe("working");
      expect(await report("unknown", "codex")).toBe("done");
      // Repeated raw unknown events must not repeat the completion alert.
      expect(await report("unknown", "codex")).toBe("done");
      expect(fake.received).toHaveLength(turn + 1);
    }
    expect(fake.received.every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

    await report("working", "pi");
    expect(await report("unknown", "claude")).toBe("working");
    expect(fake.received).toHaveLength(2);
    expect(await report("idle", "claude")).toBe("done");
    expect(fake.received).toHaveLength(3);
  });

  it("sends a status alert the device can decrypt, signed with the server's key", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");

    expect(fake.received).toHaveLength(1);
    const [received] = fake.received;
    expect(received!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "claude: fix the build",
      body: "waiting for your input",
      tag: "herdr-pane-w1:p1",
    });
    expect(received!.urgency).toBe("high");
    expect(received!.ttl).toBe(12 * 60 * 60);
    expect(received!.vapidValid).toBe(true);
    expect(received!.vapidKey).toBe(push.publicKey());
    expect(received!.vapidClaims.aud).toBe(new URL(fake.subscription.endpoint).origin);
    expect(received!.vapidClaims.sub).toBe("https://github.com/devswha/ovis");
  });

  it("keeps equal pane IDs, titles, status baselines and push links separated by PC", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "alpha")], "pc-a", "Work PC");
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC");
    await push.onStatus("w1:p1", "blocked", "pc-a");
    await push.onStatus("w1:p1", "done", "pc-b");
    expect(fake.received.map((r) => r.payload.machine_id)).toEqual(["pc-a", "pc-b"]);
    expect(fake.received.map((r) => r.payload.title)).toEqual(["Work PC · alpha", "Home PC · beta"]);
    expect(fake.received[0]!.payload.tag).not.toBe(fake.received[1]!.payload.tag);
    expect(fake.received.every((r) => r.vapidValid)).toBe(true);
  });

  it("measures the first change after a restart against the seeded baseline", async () => {
    const push = subscribed();
    // never seeded: the first report is a first sighting, not news (same rule as the tab)
    await push.onStatus("w1:p9", "blocked");
    expect(fake.received).toHaveLength(0);
    // seeded from the collector's snapshot: the very first event is already a transition
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.pane_id)).toEqual(["w1:p1"]);
    expect(fake.received[0]!.urgency).toBe("normal");
  });

  it("does not let a later snapshot overwrite a status an event already reported", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // a reconcile that raced the event still says working; blocked -> blocked is not news
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
  });

  it("names the pane by its current title, falling back to the seeded one", async () => {
    let fresh: string | Error = "claude: new task";
    const push = subscribed({
      lookupTitle: async () => {
        if (fresh instanceof Error) throw fresh;
        return fresh;
      },
    });
    push.seed([pane("w1:p1", "working", "claude: old task")]);
    await push.onStatus("w1:p1", "blocked");
    fresh = new Error("herdr busy");
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["claude: new task", "claude: old task"]);
  });

  it("tells the device a pane's terminal ended, under its last known title", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "vim notes.md")]);
    await push.onEnded("w1:p1");
    // the pane is gone from herdr by now: the workspace it was seen in is named, for the tap to open
    expect(fake.received[0]!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "vim notes.md",
      body: "terminal ended",
      tag: "herdr-pane-w1:p1",
    });
  });

  it("forgets a device its push service reports gone", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
  });

  it.each([404, 410])("answers subscription_gone on the first test when the push service returns %i", async (status) => {
    const push = subscribed();
    fake.answerWith(status);

    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);

    expect(response?.status).toBe(410);
    expect((await response?.json()).error.code).toBe("subscription_gone");
  });

  // regression (fails on main): the browser can keep handing over the endpoint its push service retired (#1038)
  it("refuses a re-registration of an endpoint its push service retired, so the device subscribes anew", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, push, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    const tested = (await post("/api/push/test", { endpoint: fake.subscription.endpoint }))!;
    expect(tested.status).toBe(410);
    expect(((await tested.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    // control: an endpoint this server never knew is still just not found
    const unknown = (await post("/api/push/test", { endpoint: "https://push.example/never-known" }))!;
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("subscription_not_found");
  });

  // regression (fails on the merged #1060): a restart between the retirement and "Turn alerts on again" re-registered the dead endpoint
  it("still refuses a retired endpoint after a server restart", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const path = join(stateDir, "push-retired.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(fake.subscription.endpoint);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, restarted, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    // control: an endpoint this server never retired registers after a restart as before
    const other = { ...fake.subscription, endpoint: `${fake.subscription.endpoint}-other` };
    expect((await post("/api/push/subscribe", { subscription: other }))?.status).toBe(204);
  });

  it("forgets a retired endpoint after its time to live and ignores a malformed file", async () => {
    let clock = 1_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    push.subscribe(fake.subscription);
    fake.answerWith(410);
    await push.sendTest(fake.subscription.endpoint);
    expect(push.retired(fake.subscription.endpoint)).toBe(true);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).retired(fake.subscription.endpoint)).toBe(false);
    // control: inside the time to live it is still remembered
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => 1_000_000 + 1000 }).retired(fake.subscription.endpoint)).toBe(true);
    // a malformed file is ignored, never fatal
    writeFileSync(join(stateDir, "push-retired.json"), "not json");
    expect(createPushService({ loopbackHttp: true, stateDir }).retired(fake.subscription.endpoint)).toBe(false);
  });

  it("keeps a device through a failure that is not a goodbye", async () => {
    const push = subscribed();
    fake.answerWith(500);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 500, gone: false });
    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);
    expect(response?.status).toBe(502);
    expect((await response?.json()).error.code).toBe("push_failed");
    fake.answerWith(201);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("alert timing and each device's choice", () => {
  const SHORT = 40;
  const LONG = 80;
  /** real timers, short enough for a test; the clock that measures turns is ours to move */
  function timed(alerts?: AlertPrefs) {
    let clock = 0;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: SHORT, long: LONG, longTurn: 1_000 }, now: () => clock });
    push.subscribe(fake.subscription, alerts);
    push.seed([pane("w1:p1", "idle", "claude")]);
    return { push, advance: (ms: number) => { clock += ms; } };
  }

  it("calls off a derived Codex finish when it is seen or a new turn begins", async () => {
    const { push } = timed({ input: true, done: "always" });
    const completions = new CompletionTracker();
    const report = (status: AgentStatus) => push.onStatus("w1:p1", completions.observe("w1:p1", status, "codex"));
    await report("working");
    await report("unknown");
    expect(completions.seen("w1:p1")).toBe(true);
    // This is the same onFocus status the server passes to PushService.
    await push.onStatus("w1:p1", "idle");
    await push.settled();
    expect(fake.received).toHaveLength(0);

    await report("working");
    await report("unknown");
    await report("working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await report("unknown");
    await push.settled();
    expect(fake.received.map((message) => message.payload.body)).toEqual(["work finished"]);
  });

  /**
   * Holds the alert timers (the delays `timed()` sets) until the test fires them, so whether a
   * status change lands before or after an alert never depends on how loaded the machine is.
   * Every other timer runs for real.
   */
  function holdAlertTimers() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const held = new Map<object, () => void>();
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== SHORT && ms !== LONG) return realSet(callback, ms, ...args);
      const handle = {};
      held.set(handle, () => callback(...args));
      return handle;
    }) as never);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      if (!held.delete(handle as object)) realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as never);
    return {
      pending: () => held.size,
      fire() {
        const due = [...held.values()];
        held.clear();
        for (const run of due) run();
      },
      restore() { set.mockRestore(); clear.mockRestore(); },
    };
  }

  it("calls off a question answered before it goes out, and sends one left waiting", async () => {
    const timers = holdAlertTimers();
    try {
      const { push } = timed();
      await push.onStatus("w1:p1", "working");
      await push.onStatus("w1:p1", "blocked");
      expect(timers.pending()).toBe(1);
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "blocked");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
    } finally { timers.restore(); }
  });

  it("tells a finish only after a turn that worked a while, and not one followed by the next prompt", async () => {
    const timers = holdAlertTimers();
    try {
      const { push, advance } = timed();
      await push.onStatus("w1:p1", "working");
      advance(500);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "working");
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(1);
      // the next prompt went in before the alert: the user is there
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    } finally { timers.restore(); }
  });

  it("follows what the device chose: no questions, every finish, or no finish at all", async () => {
    const quiet = timed({ input: false, done: "always" });
    await quiet.push.onStatus("w1:p1", "blocked");
    await quiet.push.onStatus("w1:p1", "done");
    await quiet.push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    fake.received.length = 0;
    const none = timed({ input: true, done: "off" });
    await none.push.onStatus("w1:p1", "working");
    none.advance(5_000);
    await none.push.onStatus("w1:p1", "done");
    await none.push.onEnded("w1:p1");
    await none.push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("keeps a device's choice through a re-registration without one, and a restart", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, { input: false, done: "off" });
    push.subscribe(fake.subscription);
    const stored = JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8")) as Array<{ alerts?: AlertPrefs }>;
    expect(stored[0]!.alerts).toEqual({ input: false, done: "off" });
    const restarted = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 } });
    restarted.seed([pane("w1:p1", "working", "claude")]);
    await restarted.onStatus("w1:p1", "blocked");
    await restarted.settled();
    expect(fake.received).toHaveLength(0);
  });
});

it("cancels the remaining delay group after an earlier device already received its finish", async () => {
  const slower = await startFakePushService();
  try {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 10_000, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await fake.waitFor((message) => message.payload.body === "work finished", "early finish", 2000);
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});

it("settles only after a delivery already under way, when a later group is called off", async () => {
  let release!: () => void;
  let asked!: () => void;
  const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
  const push = createPushService({
    loopbackHttp: true,
    stateDir, timing: { short: 0, long: 10_000, longTurn: 0 },
    lookupTitle: () => { asked(); return new Promise((resolve) => { release = () => resolve("claude"); }); },
  });
  const slower = await startFakePushService();
  try {
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await titleAsked;
    await push.onStatus("w1:p1", "working");
    // what had arrived when settled() resolved: the delivery held at its title lookup must be in it
    const settling = push.settled().then(() => fake.received.length);
    release();
    expect(await settling).toBe(1);
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});


it("persists device ownership and refuses revoked and legacy subscriptions after restart", async () => {
  const active = new Set(["device-a"]);
  const canDeliver = (id: string | null | undefined) => id === null || typeof id === "string" && active.has(id);
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  push.subscribe(fake.subscription, undefined, "device-a");
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0].device_id).toBe("device-a");
  active.clear();
  const restarted = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await restarted.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  restarted.revokeDevice("device-a");
  expect(await restarted.sendTest(fake.subscription.endpoint)).toBeNull();
  // Legacy records cannot identify a revoked device; re-registration supplies an owner.
  push.subscribe(fake.subscription);
  const migrated = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  migrated.subscribe(fake.subscription, undefined, null);
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
});

it("keeps a pending alert across re-registration but drops it after device revocation", async () => {
  const active = new Set(["device-a"]);
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 20 }, canDeliver: (id) => typeof id === "string" && active.has(id) });
  push.subscribe(fake.subscription, undefined, "device-a");
  push.seed([pane("w1:p1", "working", "claude")]);
  await push.onStatus("w1:p1", "blocked");
  push.subscribe(fake.subscription, undefined, "device-a");
  await push.settled();
  expect(fake.received).toHaveLength(1);
  await push.onStatus("w1:p1", "working");
  await push.onStatus("w1:p1", "blocked");
  active.clear();
  // The registry still blocks delivery if push-file cleanup cannot run.
  await push.settled();
  expect(fake.received).toHaveLength(1);
});

it("keeps a subscription made through the open LAN only while the LAN stays open", async () => {
  let gated = false;
  // the server's rule (index.ts): owners null always, undefined only while ungated
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver: (id) => id === null || (id === undefined ? !gated : false) });
  const request = new Request("http://192.168.1.20:8787/api/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
  });
  expect((await handlePushRequest(request, "/api/push/subscribe", push, undefined))?.status).toBe(204);
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).not.toHaveProperty("device_id");
  await push.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
  // pairing a device closes the open LAN: its earlier subscriber hears nothing more
  gated = true;
  await push.onEnded("w1:p2");
  expect(fake.received).toHaveLength(1);
});

it("never follows a redirect: an https endpoint cannot send the alert on to a local service", async () => {
  // a push service never redirects; one that does is an endpoint pointing the POST elsewhere
  const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: fake.subscription.endpoint } }) });
  try {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const endpoint = `http://127.0.0.1:${redirector.port}/push/1`;
    push.subscribe({ ...fake.subscription, endpoint });
    const delivery = await push.sendTest(endpoint);
    expect(delivery?.ok).toBe(false);
    expect(fake.received).toHaveLength(0);
  } finally { redirector.stop(true); }
});

describe("a window of the app in use (#751)", () => {
  it("sends no device an alert while some window is in use, and sends again once none is", async () => {
    let inUse = true;
    const push = subscribed({ inUse: () => inUse });
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    expect(fake.received).toHaveLength(0);
    // the confirmation a device asked for is not an alert: it still goes out
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received.map((r) => r.payload.tag)).toEqual(["herdr-test"]);
    inUse = false;
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received.map((r) => r.payload.body)).toEqual(["Alerts are on for this device", "waiting for your input"]);
  });

  it("asks when the alert would go out, not when the status changed", async () => {
    let inUse = false;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, inUse: () => inUse });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the window came forward while the alert waited for its timer
    inUse = true;
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("holds an alert when a window comes into use while its title is looked up", async () => {
    let inUse = false;
    const push = subscribed({ inUse: () => inUse, lookupTitle: async () => { inUse = true; return "claude"; } });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
  });
});

describe("push resync after lost status events", () => {
  it("calls off the waiting alert of a pane that closed while events were lost", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "gone"), pane("w1:p2", "working", "kept"), pane("w1:p3", "working", "new")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p3", "blocked");
    // p1 is gone; p3 is missing from the snapshot too, but was heard of since it was asked for
    push.resync([pane("w1:p2", "working", "kept")], new Set(["w1:p3"]));
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["new"]);
  });

  it("takes a clean pane's snapshot status as its baseline and announces nothing", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    // it finished and started over while events were lost
    push.resync([pane("w1:p1", "blocked", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // measured against the resynced baseline: blocked -> blocked is no change
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((r) => r.payload.body)).toHaveLength(1);
  });

  it("calls off an alert still waiting for a pane that is at rest by the snapshot", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    push.resync([pane("w1:p1", "idle", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("leaves a pane with a newer event, and done versus idle, as they are", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "a"), pane("w1:p2", "working", "b")]);
    await push.onStatus("w1:p2", "done");
    const sent = fake.received.length;
    push.resync([pane("w1:p1", "idle", "a"), pane("w1:p2", "idle", "b")], new Set(["w1:p1"]));
    // p1 was not clean: still working, so its finish is news
    await push.onStatus("w1:p1", "done");
    expect(fake.received.length).toBe(sent + 1);
    // p2 stayed done (at rest either way): a new turn and its finish are still heard
    await push.onStatus("w1:p2", "working");
    await push.onStatus("w1:p2", "done");
    expect(fake.received.length).toBe(sent + 2);
  });
});

describe("the shared pane mute (shared/preferences.ts muted_panes)", () => {
  /** the persisted list as the server composition hands it over: read each time, as the store's document is */
  function mutable(timing = { short: 0, long: 0, longTurn: 0 }) {
    const list: string[] = [];
    const push = createPushService({ loopbackHttp: true, stateDir, timing, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    return { push, list };
  }

  it("mute cancels delayed push", async () => {
    const { push, list } = mutable({ short: 10_000, long: 10_000, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the list changed while the alert waited: the server composition tells push, and the alert is called off
    list.push(paneStorageId("local", "w1:p1"));
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // an unmute resurrects nothing: the question is still unanswered, and still untold
    list.length = 0;
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // only a transition after the unmute is told
    const prompt = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    prompt.seed([pane("w1:p1", "blocked", "claude")]);
    await prompt.onStatus("w1:p1", "working");
    await prompt.onStatus("w1:p1", "blocked");
    await prompt.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
  });

  it("a persisted mute and unmute while the title is looked up sends nothing", async () => {
    // wired as the server composition wires it (server/core/status.ts): the store's list, and its changes told to push
    const store = new PreferenceStore(stateDir);
    let release!: () => void;
    let asked!: () => void;
    const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
    const push = createPushService({
      loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      muted: (machineId, paneId) => paneAlertsMuted(store.get().muted_panes, machineId, paneId),
      lookupTitle: () => { asked(); return new Promise((resolve) => { release = () => resolve("claude"); }); },
    });
    const stop = store.subscribe(() => push.mutesChanged());
    const put = (keys: string[]) => handlePreferencesRequest(new Request("http://test/api/preferences", { method: "PUT", body: JSON.stringify({ settings: {}, muted_panes: keys }) }), store);
    try {
      push.subscribe(fake.subscription, { input: true, done: "always" });
      push.seed([pane("w1:p1", "working", "claude")]);
      await push.onStatus("w1:p1", "done");
      // its timer fired: the finish waits for its title, past every check made before the lookup
      await titleAsked;
      expect((await put([paneStorageId("local", "w1:p1")])).status).toBe(200);
      expect((await put([])).status).toBe(200);
      expect(store.get().revision).toBe(2);
      release();
      await push.settled();
      // the mute called it off for good: the unmute after it resurrects nothing
      expect(fake.received).toHaveLength(0);
    } finally {
      stop();
      release?.();
    }
  });

  it("holds back the phone app's native push as the browser's", async () => {
    // the app subscribes through its OvisPush plugin and posts the relay endpoint it got (push-relay
    // POST /v1/push/<id>) to the same route, so it is one more subscription on the same list
    const { push, list } = mutable();
    const app = { ...fake.subscription, endpoint: fake.subscription.endpoint.replace(/\/push\/[^/]+$/, `/v1/push/${crypto.randomUUID()}`) };
    push.subscribe(app, { input: true, done: "always" });
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // the pane next to it still reaches the browser and the app
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["other", "other"]);
  });

  it("asks the list again right before a waiting alert goes out", async () => {
    const { push, list } = mutable({ short: 20, long: 20, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the list changed while the alert waited, and nobody told push: the alert still reads it before it goes out
    list.push(paneStorageId("local", "w1:p1"));
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("all four paths suppress only the keyed pane", async () => {
    const { push, list } = mutable();
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    push.seed([pane("w1:p1", "working", "theirs")], "pc-2", "Laptop");
    // the muted pane: its status is tracked (an unmute tells only what changes after it), its alerts are not told
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p1", "done");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // the same pane id on another PC, and another pane here, are told as before
    await push.onStatus("w1:p1", "blocked", "pc-2");
    await push.settled();
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    await push.onEnded("w1:p1", "pc-2");
    await push.settled();
    expect(fake.received.map((r) => [r.payload.title, r.payload.body])).toEqual([
      ["Laptop · theirs", "waiting for your input"], ["other", "waiting for your input"], ["Laptop · theirs", "terminal ended"],
    ]);
    // tracked while muted (it was last seen done): unmuted, done -> done is no change, and the next change is told
    list.length = 0;
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(fake.received).toHaveLength(3);
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(fake.received.at(-1)?.payload.title).toBe("mine");
  });
});

it("tells a device about a host chat, with what its tap needs to open it", async () => {
  const push = subscribed();
  const row = (status: "working" | "asks") => ({ session: "ahp:/s1", title: "fix the build", status, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived: false });
  push.onHostChats([row("working")], "mac", "Mac");
  push.onHostChats([row("asks")], "mac", "Mac");
  await push.settled();
  expect(fake.received.map((received) => [received.payload, received.urgency])).toEqual([[{
    pane_id: null, host_session: "ahp:/s1", machine_id: "mac", title: "Mac · fix the build", body: "waiting for your input", tag: "herdr-chat-mac-ahp%3A%2Fs1",
  }, "high"]]);
});

it("says nothing of host chats while Settings hides them, and picks up from their state when shown again", async () => {
  let shown = false;
  const push = subscribed({ hostChatsShown: () => shown });
  const row = (status: "working" | "asks") => ({ session: "ahp:/s1", title: "fix the build", status, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived: false });
  push.onHostChats([row("working")], "mac", "Mac");
  push.onHostChats([row("asks")], "mac", "Mac");
  await push.settled();
  expect(fake.received).toEqual([]);
  shown = true;
  // still asking: no change, so no alert for a question asked while hidden
  push.onHostChats([row("asks")], "mac", "Mac");
  push.onHostChats([row("working")], "mac", "Mac");
  push.onHostChats([row("asks")], "mac", "Mac");
  await push.settled();
  expect(fake.received.length).toBe(1);
});

describe("the cold-cache alert (ZAC-260)", () => {
  // Opus at $5 in / $25 out / $0.50 cached: a 268K context costs $2.68 to write again
  const PRICES: ColdPrices = { prices: null, fallback: { "claude-opus-4.8": { input: 5, output: 25, cached: 0.5 } } };
  const RULE = { thresholdUsd: 1, lifetimeMs: 200, leadMs: 100 };
  const chatRow = (status: HostChatRow["status"] = "idle", archived = false): HostChatRow => ({ session: "ahp:/s1", title: "fix the build", status, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived });
  const log = (lastCallAt: string, context = 268_000): HostChatCost => ({
    session: "ahp:/s1", models: [{ model: "claude-opus-4.8", input: 900_000, cacheRead: 800_000, cacheWrite: 100_000, output: 4_000, calls: 4 }],
    lastCallAt, context, peak: context, rewrites: 0, days: {}, partial: false,
  });
  const at = (ago = 0) => new Date(Date.now() - ago).toISOString();
  const bodies = () => fake.received.map((received) => received.payload.body);
  const arrived = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (fake.received.length < count) { if (Date.now() > deadline) throw new Error("the alert did not arrive"); await Bun.sleep(5); }
  };

  it("reads its rule from the deployment, $1 and an hour by default", () => {
    expect(coldFromEnv({})).toEqual({ thresholdUsd: 1, lifetimeMs: 3_600_000, leadMs: 600_000 });
    expect(coldFromEnv({ OVIS_COLD_ALERT_USD: "2.5", OVIS_CACHE_LIFETIME_MIN: "5" })).toEqual({ thresholdUsd: 2.5, lifetimeMs: 300_000, leadMs: 600_000 });
    expect(coldFromEnv({ OVIS_COLD_ALERT_USD: "-1" }).thresholdUsd).toBe(1);
  });

  it("says what is at stake: the hand-off now against the cold restart", () => {
    expect(coldAlertBody(268_000, 10, 0.477, 2.68)).toBe("268K goes cold in 10 min: hand off now ~$0.48, or the next call costs ~$2.68");
    expect(coldAlertBody(1_200_000, 10, null, 12)).toBe("1.2M goes cold in 10 min: the next call costs ~$12.00");
  });

  it("warns once, ahead of the expiry, about a big chat left idle", async () => {
    const push = subscribed({ cold: RULE });
    push.onHostChats([chatRow()], "mac", "Mac");
    const last = at();
    push.onHostChatCosts([log(last)], PRICES, "mac", "Mac");
    await Bun.sleep(40); // fixed wait: proving the alert waits for lifetime - lead
    expect(fake.received).toEqual([]);
    await arrived(1);
    await push.settled();
    expect(fake.received.map((received) => received.payload)).toEqual([{
      pane_id: null, host_session: "ahp:/s1", machine_id: "mac", title: "Mac · fix the build",
      body: "268K goes cold in 1 min: hand off now ~$0.81, or the next call costs ~$2.68", tag: "herdr-chat-mac-ahp%3A%2Fs1",
    }]);
    // the same last call read again on the next poll: once per idle period
    push.onHostChatCosts([log(last)], PRICES, "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving the same last call is not told twice
    await push.settled();
    expect(fake.received).toHaveLength(1);
  });

  it("re-arms after a new call, and only the new one is told", async () => {
    const push = subscribed({ cold: RULE });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await Bun.sleep(60); // fixed wait: the first call ages before the next one
    push.onHostChatCosts([log(at(), 300_000)], PRICES, "mac", "Mac");
    await Bun.sleep(80); // fixed wait: proving the first call's alert was called off
    expect(fake.received).toEqual([]);
    await arrived(1);
    await push.settled();
    // the fresh hand-off is the new chat's first reply (70K + an 8K digest at $10/M, 1K out): the same whatever the old chat's size (ZAC-266)
    expect(bodies()).toEqual(["300K goes cold in 1 min: hand off now ~$0.81, or the next call costs ~$3.00"]);
  });

  it("warns about a chat waiting on the owner: it calls nothing while it asks, so its cache drains", async () => {
    const push = subscribed({ cold: RULE });
    push.onHostChats([chatRow("working")], "mac", "Mac");
    push.onHostChats([chatRow("asks")], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await arrived(2);
    await push.settled();
    // the question's own alert, then the cold one
    expect(bodies()).toEqual(["waiting for your input", "268K goes cold in 1 min: hand off now ~$0.81, or the next call costs ~$2.68"]);
  });

  it("carries \"Hand off now\", good for 2 h after it went (ZAC-262)", async () => {
    const push = subscribed({ cold: RULE, handoffAction: (act) => `/h/${encodeURIComponent(JSON.stringify(act))}` });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await arrived(1);
    const sent = Date.now();
    await push.settled();
    const actions = fake.received[0]?.payload.actions ?? [];
    expect(actions.map(({ action, title }) => ({ action, title }))).toEqual([{ action: "handoff", title: "Hand off now" }]);
    const act = JSON.parse(decodeURIComponent(actions[0]!.path.slice(3))) as HandoffAct;
    expect({ ...act, expires: 0 }).toEqual({ how: "handoff", machineId: "mac", session: "ahp:/s1", title: "fix the build", expires: 0, mode: "fresh" });
    expect(Math.abs(act.expires - (sent + 2 * 3_600_000))).toBeLessThan(1_000);
  });

  it("stays quiet for a chat OmniRoute keeps warm, asked as the alert is due (phase 2)", async () => {
    let kept = true;
    const asked: string[] = [];
    const push = subscribed({ cold: RULE, keptWarm: async (chat, machineId) => { asked.push(`${machineId} ${chat.session}`); return kept; } });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await Bun.sleep(250); // fixed wait: past the lifetime, proving the kept chat is not told
    await push.settled();
    expect(fake.received).toEqual([]);
    expect(asked).toEqual(["mac ahp:/s1"]);
    // keep-warm let it go (off, past its window, the day's cap): the next idle period is told
    kept = false;
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await arrived(1);
    await push.settled();
    expect(fake.received).toHaveLength(1);
  });

  it("weighs the last call's model, not the one that read the most (phase 1b)", async () => {
    const push = subscribed({ cold: RULE });
    // most reads on an unpriced model, the last call on a priced one: the cache going cold is the priced one's
    const switched: HostChatCost = { ...log(at()), lastModel: "claude-opus-4.8", models: [
      { model: "mystery-1", input: 9_000_000, cacheRead: 8_000_000, cacheWrite: 0, output: 4_000, calls: 40 },
      { model: "claude-opus-4.8", input: 268_000, cacheRead: 260_000, cacheWrite: 8_000, output: 400, calls: 1, lastCallAt: at() },
    ] };
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([switched], PRICES, "mac", "Mac");
    await arrived(1);
    await push.settled();
    expect(bodies()[0]).toContain("268K goes cold");
  });

  it("stays quiet for a small, unpriced, working, archived or already cold chat", async () => {
    const push = subscribed({ cold: RULE });
    const cases: [HostChatRow, HostChatCost, ColdPrices][] = [
      [chatRow(), log(at(), 50_000), PRICES], // a $0.50 restart, under $1
      [chatRow(), log(at()), { prices: null, fallback: null }],
      [chatRow("working"), log(at()), PRICES],
      [chatRow("idle", true), log(at()), PRICES],
      [chatRow(), log(at(500)), PRICES], // expired before the log was read
    ];
    for (const [row, cost, prices] of cases) {
      push.onHostChats([row], "mac", "Mac");
      push.onHostChatCosts([cost], prices, "mac", "Mac");
      await Bun.sleep(150); // fixed wait: proving nothing arrives
      push.onHostChats([], "mac", "Mac");
    }
    await push.settled();
    expect(fake.received).toEqual([]);
  });

  it("is called off by a new turn, by the chat leaving the list, and by its log leaving the answer", async () => {
    const push = subscribed({ cold: RULE });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    push.onHostChats([chatRow("working")], "mac", "Mac");
    push.onHostChats([chatRow("idle")], "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving nothing arrives
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    push.onHostChats([], "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving nothing arrives
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    push.onHostChatCosts([], PRICES, "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving nothing arrives
    await push.settled();
    // only the turn's own finish alert, never a cold one
    expect(bodies().filter((body) => body.includes("cold"))).toEqual([]);
  });

  it("is opt-in: a device that never turned it on hears nothing and starts no scan; a window in use holds it", async () => {
    const off = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, cold: RULE });
    off.subscribe(fake.subscription);
    expect(off.wantsCold()).toBe(false);
    off.onHostChats([chatRow()], "mac", "Mac");
    off.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    let used = true;
    const busyDir = mkdtempSync(join(tmpdir(), "ovis-push-"));
    const busy = subscribed({ cold: RULE, inUse: () => used, stateDir: busyDir });
    expect(busy.wantsCold()).toBe(true);
    busy.onHostChats([chatRow()], "mac", "Mac");
    busy.onHostChatCosts([log(at())], PRICES, "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving nothing arrives
    await Promise.all([off.settled(), busy.settled()]);
    used = false;
    rmSync(busyDir, { recursive: true, force: true });
    expect(fake.received).toEqual([]);
  });
});

describe("the keep-warm window-end alert (ZAC-260, pick X)", () => {
  const PRICES: ColdPrices = { prices: null, fallback: { "claude-opus-4.8": { input: 5, output: 25, cached: 0.5 } } };
  const RULE = { thresholdUsd: 1, lifetimeMs: 3_600_000, leadMs: 600_000 };
  const chatRow = (status: HostChatRow["status"] = "idle"): HostChatRow => ({ session: "ahp:/s1", title: "fix the build", status, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived: false });
  const log = (lastCallAt: string): HostChatCost => ({
    session: "ahp:/s1", models: [{ model: "claude-opus-4.8", input: 900_000, cacheRead: 800_000, cacheWrite: 100_000, output: 4_000, calls: 4 }],
    lastCallAt, context: 268_000, peak: 268_000, rewrites: 0, days: {}, partial: false,
  });
  const keyFor = (lastRealAt: number, until: number, over: Partial<KeepWarmKey> = {}): KeepWarmKey => ({ key: "k1", model: "claude-opus-4.8", apiKey: "copilot", tokens: 268_000, prompt: 268_000,
    lastRealAt, lastPingAt: null, nextPingAt: null, until, pings: 12, usd: 0.47, restartUsd: 2.14, missed: false, disabled: false, kept: true, ...over });
  const arrived = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (fake.received.length < count) { if (Date.now() > deadline) throw new Error("the alert did not arrive"); await Bun.sleep(5); }
  };

  it("says what keeping it cost and what letting it go costs", () => {
    expect(windowAlertBody(268_000, 8, 0.47, 2.14, 0.65)).toBe("268K · kept warm 8 h for $0.47. If it goes cold, your next message costs $2.14. When you're back, a handoff (~$0.65) makes every later turn cheaper too.");
    expect(windowAlertBody(268_000, 16, null, 2.14, null)).toBe("268K · kept warm 16 h. If it goes cold, your next message costs $2.14.");
  });

  it("goes ahead of the window's end, with the two buttons, and asks the plugin again first", async () => {
    const last = Date.now();
    let keys = [keyFor(last, last + 200)];
    const refreshed: boolean[] = [];
    const push = subscribed({ cold: RULE, keepWarmLeadMs: 100, keepWarmKeys: async (refresh) => { refreshed.push(refresh); return keys; }, keepWarmAction: (act) => `/act/${act.how}/${act.key}/${act.from}/${act.announced}`,
      handoffAction: (act) => `/act/${act.how}/${act.machineId}/${act.title}/${act.mode}`, keptWarm: () => true });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await Bun.sleep(40); // fixed wait: proving it waits for until - lead
    expect(fake.received).toEqual([]);
    await arrived(1);
    await push.settled();
    const [payload] = fake.received.map((received) => received.payload);
    expect(payload?.title).toBe("Mac · \"fix the build\" stops being kept warm in 1 min");
    expect(payload?.body).toStartWith("268K · kept warm 0 h for $0.47. If it goes cold, your next message costs $2.14.");
    expect(payload?.actions).toEqual([
      { action: "extend", title: "Keep 8 h more", path: `/act/extend/k1/${last}/${last + 200}` },
      { action: "cool", title: "Let it cool", path: `/act/cool/k1/${last}/${last + 200}` },
      { action: "handoff", title: "Hand off now", path: "/act/handoff/mac/fix the build/note" },
    ]);
    expect(refreshed).toEqual([false, true]);
    // read again with the same window: told once
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await Bun.sleep(150); // fixed wait: proving the same window is not told twice
    await push.settled();
    expect(fake.received).toHaveLength(1);
    keys = [];
  });

  it("says nothing of a window changed or let go before it is due, nor of a chat at work", async () => {
    const last = Date.now();
    let keys = [keyFor(last, last + 200)];
    const push = subscribed({ cold: RULE, keepWarmLeadMs: 100, keepWarmKeys: async () => keys, keptWarm: () => true });
    push.onHostChats([chatRow()], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    // extended from another device: the armed alert's window is not this one
    keys = [keyFor(last, last + 8 * 3_600_000)];
    await Bun.sleep(200); // fixed wait: past the first window's alert
    await push.settled();
    expect(fake.received).toEqual([]);
    // not kept (the plugin let it go): nothing armed
    keys = [keyFor(last, last + 200, { kept: false })];
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    push.onHostChats([chatRow("working")], "mac", "Mac");
    keys = [keyFor(last, last + 200)];
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await Bun.sleep(250); // fixed wait: proving nothing arrives
    await push.settled();
    expect(fake.received.filter((received) => received.payload.title.includes("kept warm"))).toEqual([]);
  });
});

describe("archiving a chat lets it cool (ZAC-262)", () => {
  const PRICES: ColdPrices = { prices: null, fallback: { "claude-opus-4.8": { input: 5, output: 25, cached: 0.5 } } };
  const chatRow = (archived: boolean): HostChatRow => ({ session: "ahp:/s1", title: "fix the build", status: "idle", modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived });
  const log = (lastCallAt: string): HostChatCost => ({
    session: "ahp:/s1", models: [{ model: "claude-opus-4.8", input: 900_000, cacheRead: 800_000, cacheWrite: 100_000, output: 4_000, calls: 4 }],
    lastCallAt, context: 268_000, peak: 268_000, rewrites: 0, days: {}, partial: false,
  });
  const keyFor = (lastRealAt: number, over: Partial<KeepWarmKey> = {}): KeepWarmKey => ({ key: "k1", model: "claude-opus-4.8", apiKey: "copilot", tokens: 268_000, prompt: 268_000,
    lastRealAt, lastPingAt: null, nextPingAt: null, until: lastRealAt + 8 * 3_600_000, pings: 0, usd: 0, restartUsd: 2.14, missed: false, disabled: false, kept: true, ...over });

  it("cools the kept chat once as it is archived, and again only after a new real call", async () => {
    const last = Date.now() - 60_000;
    let keys = [keyFor(last)];
    const cooled: KeepWarmKey[] = [];
    const push = subscribed({ keepWarmKeys: async () => keys, coolKeepWarm: async (key) => { cooled.push(key); return true; } });
    push.onHostChats([chatRow(false)], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled).toEqual([]);
    push.onHostChats([chatRow(true)], "mac", "Mac");
    await push.settled();
    expect(cooled.map((key) => [key.key, key.lastRealAt])).toEqual([["k1", last]]);
    // still archived, listed and read again: not saved twice
    push.onHostChats([chatRow(true)], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled).toHaveLength(1);
    // a new real call on the archived chat (the plugin started a new window): cooled again
    const next = Date.now();
    keys = [keyFor(next)];
    push.onHostChatCosts([log(new Date(next).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled.map((key) => key.lastRealAt)).toEqual([last, next]);
  });

  it("cools a chat first seen archived once its cost row arrives", async () => {
    const last = Date.now() - 60_000;
    const cooled: KeepWarmKey[] = [];
    const push = subscribed({ keepWarmKeys: async () => [keyFor(last)], coolKeepWarm: async (key) => { cooled.push(key); return true; } });
    push.onHostChats([chatRow(true)], "mac", "Mac");
    await push.settled();
    expect(cooled).toEqual([]);
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled).toHaveLength(1);
  });

  it("looks again at the next poll while the plugin's cached answer lags the chat's new call", async () => {
    const before = Date.now() - 3_600_000;
    const last = Date.now() - 60_000;
    // the cached read still has the chat's previous call: no key matches the new one yet
    let keys = [keyFor(before)];
    const cooled: KeepWarmKey[] = [];
    const push = subscribed({ keepWarmKeys: async () => keys, coolKeepWarm: async (key) => { cooled.push(key); return true; } });
    push.onHostChats([chatRow(false)], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    push.onHostChats([chatRow(true)], "mac", "Mac");
    await push.settled();
    expect(cooled).toEqual([]);
    keys = [keyFor(last)];
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled.map((key) => key.lastRealAt)).toEqual([last]);
  });

  it("looks again when the fresh read finds the plugin past the call it matched", async () => {
    const last = Date.now() - 60_000;
    const answers = [false, true];
    const cooled: KeepWarmKey[] = [];
    const push = subscribed({ keepWarmKeys: async () => [keyFor(last)], coolKeepWarm: async (key) => { cooled.push(key); return answers.shift() ?? true; } });
    push.onHostChats([chatRow(false)], "mac", "Mac");
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    push.onHostChats([chatRow(true)], "mac", "Mac");
    await push.settled();
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    push.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    await push.settled();
    expect(cooled).toHaveLength(2);
  });

  it("logs a failed save once per real call", async () => {
    const last = Date.now() - 60_000;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = subscribed({ keepWarmKeys: async () => [keyFor(last)], coolKeepWarm: async () => { throw new Error("Keep-warm is unavailable"); } });
      failing.onHostChats([chatRow(false)], "mac", "Mac");
      failing.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
      failing.onHostChats([chatRow(true)], "mac", "Mac");
      await failing.settled();
      failing.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
      failing.onHostChats([chatRow(true)], "mac", "Mac");
      await failing.settled();
      expect(errors.mock.calls.filter((call) => String(call[0]).startsWith("keep-warm cool:"))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("leaves alone a key not kept, a chat with no cost row, and logs a failed save", async () => {
    const last = Date.now() - 60_000;
    const cooled: KeepWarmKey[] = [];
    const notKept = subscribed({ keepWarmKeys: async () => [keyFor(last, { kept: false })], coolKeepWarm: async (key) => { cooled.push(key); return true; } });
    notKept.onHostChats([chatRow(false)], "mac", "Mac");
    notKept.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
    notKept.onHostChats([chatRow(true)], "mac", "Mac");
    await notKept.settled();
    const noCost = subscribed({ keepWarmKeys: async () => [keyFor(last)], coolKeepWarm: async (key) => { cooled.push(key); return true; } });
    noCost.onHostChats([chatRow(false)], "mac", "Mac");
    noCost.onHostChats([chatRow(true)], "mac", "Mac");
    await noCost.settled();
    expect(cooled).toEqual([]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = subscribed({ keepWarmKeys: async () => [keyFor(last)], coolKeepWarm: async () => { throw new Error("Keep-warm is unavailable"); } });
      failing.onHostChats([chatRow(false)], "mac", "Mac");
      failing.onHostChatCosts([log(new Date(last).toISOString())], PRICES, "mac", "Mac");
      failing.onHostChats([chatRow(true)], "mac", "Mac");
      await failing.settled();
      expect(errors.mock.calls.map((call) => String(call[0]))).toContain("keep-warm cool: Keep-warm is unavailable");
    } finally {
      errors.mockRestore();
    }
  });
});
