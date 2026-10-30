import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { ntfyFromEnv } from "./ntfy.ts";
import { createPushService } from "./push.ts";

/**
 * The ntfy channel: the same alerts web push sends (same delays, same call-offs, held while a
 * window is in use), posted to one ntfy topic the deployment names. Checked against a fake ntfy
 * that records what it was sent and with which token.
 */

interface Posted { auth: string | null; body: { topic?: string; title?: string; message?: string; priority?: number; click?: string; tags?: string[]; icon?: string } }

let stateDir: string;
let server: ReturnType<typeof Bun.serve>;
let posted: Posted[];
let answer = 200;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-ntfy-"));
  posted = [];
  answer = 200;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    posted.push({ auth: request.headers.get("authorization"), body: await request.json() as Posted["body"] });
    return new Response("{}", { status: answer });
  } });
});
afterEach(() => { server.stop(true); rmSync(stateDir, { recursive: true, force: true }); });

const pane = (paneId: string, status: AgentStatus, title: string): HerdrPane =>
  ({ pane_id: paneId, agent_status: status, terminal_title: title, focused: false, revision: 0, tab_id: "t1", terminal_id: "term_1", workspace_id: "w1" });

function service(env: Record<string, string>, more: Partial<Parameters<typeof createPushService>[0]> = {}) {
  const ntfy = ntfyFromEnv({ HERDR_WEB_NTFY_URL: `http://127.0.0.1:${server.port}`, HERDR_WEB_NTFY_TOPIC: "herdr-agents", HERDR_WEB_NTFY_TOKEN: "tk_fictional", ...env });
  return createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, ntfy: ntfy ?? undefined, ...more });
}

describe("ntfyFromEnv", () => {
  it("is off unless a URL and a topic are both set", () => {
    expect(ntfyFromEnv({})).toBeNull();
    expect(ntfyFromEnv({ HERDR_WEB_NTFY_URL: "https://ntfy.example" })).toBeNull();
    expect(ntfyFromEnv({ HERDR_WEB_NTFY_TOPIC: "t" })).toBeNull();
  });

  it("reads the token from a file, trimmed, when one is named", () => {
    const file = join(stateDir, "token");
    writeFileSync(file, "tk_from_file\n");
    expect(ntfyFromEnv({ HERDR_WEB_NTFY_URL: "https://ntfy.example/", HERDR_WEB_NTFY_TOPIC: "t", HERDR_WEB_NTFY_TOKEN_FILE: file })).toMatchObject({ url: "https://ntfy.example", token: "tk_from_file" });
  });

  it("takes which alerts it wants as a device does, the default being questions and long finishes", () => {
    const base = { HERDR_WEB_NTFY_URL: "https://ntfy.example", HERDR_WEB_NTFY_TOPIC: "t" };
    expect(ntfyFromEnv(base)?.alerts).toEqual({ input: true, done: "long" });
    expect(ntfyFromEnv({ ...base, HERDR_WEB_NTFY_INPUT: "off", HERDR_WEB_NTFY_DONE: "always" })?.alerts).toEqual({ input: false, done: "always" });
    expect(ntfyFromEnv({ ...base, HERDR_WEB_NTFY_DONE: "sometimes" })?.alerts.done).toBe("long");
    // the cold-cache alert (ZAC-260): opt-in, only with HERDR_WEB_NTFY_COLD=on
    expect(ntfyFromEnv({ ...base, HERDR_WEB_NTFY_COLD: "on" })?.alerts).toEqual({ input: true, done: "long", cold: true });
    expect(ntfyFromEnv(base)?.alerts.cold).toBeUndefined();
    expect(ntfyFromEnv({ ...base, HERDR_WEB_NTFY_COLD: "off" })?.alerts.cold).toBeUndefined();
  });

  it("refuses a URL that is not http(s)", () => {
    expect(() => ntfyFromEnv({ HERDR_WEB_NTFY_URL: "file:///etc/passwd", HERDR_WEB_NTFY_TOPIC: "t" })).toThrow();
  });

  it("takes an http(s) icon, and refuses any other", () => {
    const base = { HERDR_WEB_NTFY_URL: "https://ntfy.example", HERDR_WEB_NTFY_TOPIC: "t" };
    expect(ntfyFromEnv(base)?.icon).toBeNull();
    expect(ntfyFromEnv({ ...base, HERDR_WEB_NTFY_ICON: " https://ntfy.example/_static/herdr.png " })?.icon).toBe("https://ntfy.example/_static/herdr.png");
    expect(() => ntfyFromEnv({ ...base, HERDR_WEB_NTFY_ICON: "javascript:alert(1)" })).toThrow();
  });
});

describe("ntfy alerts", () => {
  it("posts a question to the topic with the token, high priority, and a link that opens the pane", async () => {
    const push = service({ HERDR_WEB_NTFY_CLICK_URL: "https://herdr.example/" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(posted).toEqual([{ auth: "Bearer tk_fictional", body: {
      topic: "herdr-agents", title: "claude", message: "waiting for your input", priority: 4, tags: ["question"],
      click: "https://herdr.example/?ws=w1&pane=w1%3Ap1&view=chat",
    } }]);
  });

  it("names a remote pane's PC in the link, and a finish goes at default priority", async () => {
    const push = service({ HERDR_WEB_NTFY_CLICK_URL: "https://herdr.example" });
    push.seed([pane("w2:p3", "working", "codex")], "mac", "Mac");
    await push.onStatus("w2:p3", "done", "mac");
    await push.settled();
    expect(posted.map((each) => each.body)).toEqual([{ topic: "herdr-agents", title: "Mac · codex", message: "work finished", priority: 3, tags: ["white_check_mark"],
      click: "https://herdr.example/?machine=mac&ws=w1&pane=w2%3Ap3&view=chat" }]);
  });

  it("shows the icon it was given beside each alert", async () => {
    const push = service({ HERDR_WEB_NTFY_ICON: "https://ntfy.example/_static/herdr.png" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(posted[0]!.body.icon).toBe("https://ntfy.example/_static/herdr.png");
  });

  it("has no link without a click URL, no icon without one, and no Authorization without a token", async () => {
    const push = service({ HERDR_WEB_NTFY_TOKEN: "" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(posted[0]!.auth).toBeNull();
    expect(posted[0]!.body.click).toBeUndefined();
    expect("icon" in posted[0]!.body).toBe(false);
  });

  it("follows its own alerts setting, not a device's", async () => {
    const push = service({ HERDR_WEB_NTFY_INPUT: "off", HERDR_WEB_NTFY_DONE: "off" });
    push.seed([pane("w1:p1", "working", "claude")]);
    // each settled before the next: a change that calls the alert off would hide a wrong one
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    await push.onStatus("w1:p1", "done");
    await push.settled();
    await push.onEnded("w1:p1");
    expect(posted).toEqual([]);
  });

  it("tells an ended terminal unless it wants no finishes", async () => {
    const push = service({});
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onEnded("w1:p1");
    expect(posted.map((each) => each.body.message)).toEqual(["terminal ended"]);
  });

  it("holds every alert while a window of the app is in use, as web push does", async () => {
    let inUse = true;
    const push = service({}, { inUse: () => inUse });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(posted).toEqual([]);
    inUse = false;
    push.seed([pane("w1:p2", "working", "claude")]);
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    expect(posted).toHaveLength(1);
  });

  it("holds an alert when a window comes into use while its title is looked up", async () => {
    let inUse = false;
    const push = service({}, { inUse: () => inUse, lookupTitle: async () => { inUse = true; return "claude"; } });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(posted).toEqual([]);
  });

  it("calls off a question answered before its delay, like a device's", async () => {
    const push = createPushService({ stateDir, timing: { short: 40, long: 40, longTurn: 0 },
      ntfy: ntfyFromEnv({ HERDR_WEB_NTFY_URL: `http://127.0.0.1:${server.port}`, HERDR_WEB_NTFY_TOPIC: "t" })! });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(posted).toEqual([]);
  });

  it("sends with no device subscribed at all", async () => {
    const push = service({});
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(posted).toHaveLength(1);
  });

  it("a refused post is logged, never thrown", async () => {
    answer = 403;
    const push = service({});
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(posted).toHaveLength(1);
  });
});

describe("host chat alerts", () => {
  const chat = (session: string, status: "working" | "asks" | "idle" | "error", title = "fix the build", archived = false) =>
    ({ session, title, status, modified_at: "2026-03-10T10:00:00Z", cwd: "/tmp/repo", unread: false, archived });

  it("a chat that starts asking is a question; its link opens the chat on its PC", async () => {
    const push = service({ HERDR_WEB_NTFY_CLICK_URL: "https://herdr.example" });
    push.onHostChats([chat("ahp:/s1", "working")], "mac", "Mac");
    push.onHostChats([chat("ahp:/s1", "asks")], "mac", "Mac");
    await push.settled();
    expect(posted.map((each) => each.body)).toEqual([{ topic: "herdr-agents", title: "Mac · fix the build", message: "waiting for your input", priority: 4, tags: ["question"],
      click: "https://herdr.example/?machine=mac&chat=ahp%3A%2Fs1" }]);
  });

  it("a chat seen for the first time is no news, whatever it is doing", async () => {
    const push = service({});
    push.onHostChats([chat("ahp:/s1", "asks"), chat("ahp:/s2", "idle")], "local");
    await push.settled();
    expect(posted).toEqual([]);
  });

  it("a finished turn is a finish, and one that failed says so", async () => {
    const push = service({});
    push.onHostChats([chat("ahp:/s1", "working"), chat("ahp:/s2", "working", "docs")], "local");
    push.onHostChats([chat("ahp:/s1", "idle"), chat("ahp:/s2", "error", "docs")], "local");
    await push.settled();
    expect(posted.map((each) => [each.body.title, each.body.message])).toEqual([["fix the build", "work finished"], ["docs", "stopped with an error"]]);
  });

  it("an answered question is called off, and a chat that left the list takes its alert with it", async () => {
    const push = createPushService({ stateDir, timing: { short: 40, long: 40, longTurn: 0 },
      ntfy: ntfyFromEnv({ HERDR_WEB_NTFY_URL: `http://127.0.0.1:${server.port}`, HERDR_WEB_NTFY_TOPIC: "t" })! });
    push.onHostChats([chat("ahp:/s1", "working"), chat("ahp:/s2", "working")], "local");
    push.onHostChats([chat("ahp:/s1", "asks"), chat("ahp:/s2", "asks")], "local");
    push.onHostChats([chat("ahp:/s1", "working")], "local");
    await push.settled();
    expect(posted).toEqual([]);
  });

  it("an archived chat says nothing", async () => {
    const push = service({});
    push.onHostChats([chat("ahp:/s1", "working", "x", true)], "local");
    push.onHostChats([chat("ahp:/s1", "asks", "x", true)], "local");
    await push.settled();
    expect(posted).toEqual([]);
  });

  it("chats on two PCs with the same id are two chats", async () => {
    const push = service({});
    // each settled: a later change on the same key would call a wrong alert off unseen
    push.onHostChats([chat("ahp:/s1", "working")], "mac");
    await push.settled();
    push.onHostChats([chat("ahp:/s1", "idle")], "pc");
    await push.settled();
    push.onHostChats([chat("ahp:/s1", "asks")], "mac");
    await push.settled();
    expect(posted.map((each) => each.body.message)).toEqual(["waiting for your input"]);
  });
});

describe("GET /api/push says where else alerts go", () => {
  it("names the ntfy topic and its alerts, never the server or the token", async () => {
    const { handlePushRequest } = await import("./push.ts");
    const push = service({ HERDR_WEB_NTFY_DONE: "always", HERDR_WEB_NTFY_ICON: "https://ntfy.example/_static/herdr.png" });
    const body = await (await handlePushRequest(new Request("http://localhost/api/push"), "/api/push", push, null))!.json();
    expect(body.ntfy).toEqual({ topic: "herdr-agents", alerts: { input: true, done: "always" } });
    expect(JSON.stringify(body)).not.toContain("tk_fictional");
    expect(JSON.stringify(body)).not.toContain(String(server.port));
  });

  it("says null when no topic is set", async () => {
    const { handlePushRequest } = await import("./push.ts");
    const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 } });
    expect((await (await handlePushRequest(new Request("http://localhost/api/push"), "/api/push", push, null))!.json()).ntfy).toBeNull();
  });
});

describe("the cold-cache alert on ntfy (ZAC-260)", () => {
  const RULE = { thresholdUsd: 1, lifetimeMs: 120, leadMs: 100 };
  const PRICES = { prices: null, fallback: { "claude-opus-4.8": { input: 5, output: 25, cached: 0.5 } } };
  const row = { session: "ahp:/s1", title: "fix the build", status: "idle" as const, modified_at: "2026-03-10T10:00:00Z", cwd: null, unread: false, archived: false };
  const log = { session: "ahp:/s1", models: [{ model: "claude-opus-4.8", input: 900_000, cacheRead: 800_000, cacheWrite: 100_000, output: 4_000, calls: 4 }],
    lastCallAt: new Date().toISOString(), context: 268_000, peak: 268_000, rewrites: 0, days: {}, partial: false };

  it("posts a snowflake that opens the chat when the deployment turned it on, and nothing by default", async () => {
    const on = service({ HERDR_WEB_NTFY_CLICK_URL: "https://herdr.example", HERDR_WEB_NTFY_COLD: "on" }, { cold: RULE });
    on.onHostChats([row], "mac", "Mac");
    on.onHostChatCosts([{ ...log, lastCallAt: new Date().toISOString() }], PRICES, "mac", "Mac");
    for (const deadline = Date.now() + 5_000; posted.length === 0;) { if (Date.now() > deadline) throw new Error("nothing posted"); await Bun.sleep(5); }
    await on.settled();
    expect(posted.map((each) => each.body)).toEqual([{ topic: "herdr-agents", title: "Mac · fix the build", message: "268K goes cold in 1 min: hand off now ~$0.48, or the next call costs ~$2.68",
      priority: 3, tags: ["snowflake"], click: "https://herdr.example/?machine=mac&chat=ahp%3A%2Fs1" }]);
    posted.length = 0;
    const off = service({}, { cold: RULE });
    expect(off.wantsCold()).toBe(false);
    off.onHostChats([row], "mac", "Mac");
    off.onHostChatCosts([{ ...log, lastCallAt: new Date().toISOString() }], PRICES, "mac", "Mac");
    await Bun.sleep(80); // fixed wait: proving nothing is posted
    await off.settled();
    expect(posted).toEqual([]);
  });
});
