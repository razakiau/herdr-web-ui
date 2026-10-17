import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { VscodeChatRow } from "../../shared/vscode.ts";
import { agentsListRows, choose, chosenFor, fetchVscodeChats, fetchVscodeState, hostLine, isVscodeOff, sendVscode } from "./vscodeChats.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const row = (session: string, status: VscodeChatRow["status"], ageMs: number): VscodeChatRow => ({
  session, title: session, status, modified_at: new Date(NOW - ageMs).toISOString(), cwd: "/home/user/project",
});

describe("VS Code chats in the Agents list", () => {
  it("agentsListRows live keeps working, asks and pinned only", () => {
    const rows = [row("a", "idle", 1000), row("b", "working", 5000), row("c", "asks", 2 * DAY), row("d", "error", 1000), row("e", "idle", 30 * DAY)];
    const pinned = (session: string) => session === "e";
    expect(agentsListRows(rows, "live", pinned, NOW).map((r) => r.session)).toEqual(["b", "c", "e"]);
    expect(agentsListRows(rows, "live", () => false, NOW).map((r) => r.session)).toEqual(["b", "c"]);
  });

  it("recent adds the last 7 days, at most 20, newest first", () => {
    const old = row("old", "idle", 8 * DAY);
    const recent = Array.from({ length: 25 }, (_, i) => row(`r${i}`, "idle", (i + 1) * 60_000));
    const rows = [old, ...[...recent].reverse(), row("w", "working", 3 * DAY)];
    const listed = agentsListRows(rows, "recent", () => false, NOW).map((r) => r.session);
    // the live ones are never cut: 20 of the rest, and the working one
    expect(listed).toHaveLength(21);
    expect(listed.filter((session) => session.startsWith("r"))).toHaveLength(20);
    expect(listed.slice(0, 3)).toEqual(["r0", "r1", "r2"]);
    expect(listed).toContain("w");
    expect(listed).not.toContain("old");
    // a pinned chat stays however old it is, past the cap too
    const withPin = agentsListRows(rows, "recent", (session) => session === "old", NOW).map((r) => r.session);
    expect(withPin).toContain("old");
    expect(withPin).toContain("w");
  });
});

describe("VS Code chats per PC", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (status: number, body: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return urls;
  };

  it("asks the PC's own bridge for its list and its host", async () => {
    const urls = answer(200, { chats: [row("a", "idle", 0)], host: { state: "starting" } });
    expect((await fetchVscodeChats("local")).map((r) => r.session)).toEqual(["a"]);
    expect(await fetchVscodeState("desk")).toEqual({ state: "starting" });
    expect(urls).toEqual(["/api/vscode/chats", "/api/machines/desk/vscode/state"]);
  });

  it("tells a PC without the feature from a down host", async () => {
    answer(404, { error: { code: "vscode_off", message: "off" } });
    const off = await fetchVscodeChats("desk").catch((error: unknown) => error);
    expect(isVscodeOff(off)).toBe(true);
    answer(503, { error: { code: "vscode_host", message: "down" }, host: { state: "no_server" } });
    const down = await fetchVscodeChats("desk").catch((error: unknown) => error);
    expect(isVscodeOff(down)).toBe(false);
  });

  it("says what a host that is not ready needs, and nothing for a signed-in one", () => {
    const t = (key: string, vars?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
    expect(hostLine({ state: "connected", signed_in: true, protocol: "1.0.0" }, t)).toBeNull();
    expect(hostLine({ state: "off" }, t)).toBeNull();
    expect(hostLine({ state: "connected", signed_in: false, protocol: "1.0.0" }, t)).toBe("Open VS Code on this PC once to sign the agent host in");
    expect(hostLine({ state: "refused", server_version: "2.0.0" }, t)).toBe("VS Code's agent host speaks a protocol this bridge doesn't (server 2.0.0)");
    expect(hostLine({ state: "no_server" }, t)).toBe("No VS Code server on this PC");
    expect(hostLine({ state: "unsupported" }, t)).toBe("VS Code chats are not supported on Windows yet");
    expect(hostLine({ state: "starting" }, t)).toBe("Starting VS Code's agent host…");
    // a PC that leaves the start to something else waits for the host to come up
    expect(hostLine({ state: "waiting" }, t)).toBe("Starting VS Code's agent host…");
  });
});

describe("the phone's model and agent choice", () => {
  const realFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let session: Map<string, string>;
  beforeEach(() => {
    session = new Map();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => { session.set(key, value); },
        removeItem: (key: string) => { session.delete(key); },
      } },
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const record = (status: number, body: unknown) => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
  };

  it("a choice is kept per chat and cleared after the send that carries it", async () => {
    expect(chosenFor("desk", "s1")).toEqual({});
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" } });
    choose("desk", "s1", { agent: "file:///tmp/fictional/agents/Report.agent.md" });
    expect(chosenFor("desk", "s1")).toEqual({ model: { id: "fictional/model-b", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md" });
    // another chat, or the same session on another PC, has no choice of its own
    expect(chosenFor("desk", "s2")).toEqual({});
    expect(chosenFor("laptop", "s1")).toEqual({});
    expect(session.has("herdr-web-ui:vscode-choice:desk:s1")).toBe(true);
    // a send that fails keeps it for the user's next tap
    record(502, { error: { code: "vscode_failed", message: "down" } });
    await expect(sendVscode("desk", { session: "s1", text: "FICTIONAL hello" })).rejects.toThrow();
    expect(chosenFor("desk", "s1").model?.id).toBe("fictional/model-b");
    record(200, { queued: false });
    expect(await sendVscode("desk", { session: "s1", text: "FICTIONAL hello" })).toEqual({ queued: false });
    expect(chosenFor("desk", "s1")).toEqual({});
    expect(session.has("herdr-web-ui:vscode-choice:desk:s1")).toBe(false);
  });

  it("sendVscode carries the pending model and agent, and agent null is sent as null", async () => {
    choose("desk", "s1", { model: { id: "fictional/model-a" }, agent: null });
    const calls = record(200, { queued: true });
    expect(await sendVscode("desk", { session: "s1", text: "FICTIONAL next" })).toEqual({ queued: true });
    expect(calls).toEqual([{ url: "/api/machines/desk/vscode/chat/send", body: { session: "s1", text: "FICTIONAL next", model: { id: "fictional/model-a" }, agent: null } }]);
    // nothing pending: the send carries neither, and the chat keeps what it used last
    calls.length = 0;
    await sendVscode("desk", { session: "s1", text: "FICTIONAL again" });
    expect(calls[0]?.body).toEqual({ session: "s1", text: "FICTIONAL again" });
  });
});
