import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { VscodeChatRow } from "../../shared/vscode.ts";
import { readFileSync } from "node:fs";
import { agentsListRows, choose, chosenFor, coalesced, createVscodeChat, fetchVscodeChats, fetchVscodeState, folderChoices, groupModels, hostLine, isVscodeOff, keepVscodeDraft, readVscodeDraft, sendVscode, onVscodeMessage, sessionForFolder, settleChoice, takeVscodeEvent, type VscodeLast } from "./vscodeChats.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NONE: VscodeLast = { model: null, agent: null };
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

  it("a choice is kept per chat, through a failed send and a sent one, until a read shows the chat uses it", async () => {
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
    await expect(sendVscode("desk", { session: "s1", text: "FICTIONAL hello" }, NONE)).rejects.toThrow();
    expect(chosenFor("desk", "s1").model?.id).toBe("fictional/model-b");
    record(200, { queued: false });
    expect(await sendVscode("desk", { session: "s1", text: "FICTIONAL hello" }, NONE)).toEqual({ queued: false });
    // a read a moment behind (the chat's last is still the old one) keeps it
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-a", effort: null }, agent: null }).model?.id).toBe("fictional/model-b");
    // a read naming only the model as used keeps the whole pick
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: null }).agent).toBe("file:///tmp/fictional/agents/Report.agent.md");
    expect(settleChoice("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: "file:///tmp/fictional/agents/Report.agent.md" })).toEqual({});
    expect(session.has("herdr-web-ui:vscode-choice:desk:s1")).toBe(false);
  });

  it("createVscodeChat posts once and answers the session; the text and choice wait in the chat when the first message did not go", async () => {
    const body = { cwd: "/tmp/fictional-repo", text: "FICTIONAL first", model: { id: "fictional/model-b", effort: "high" }, agent: null };
    let calls = record(200, { session: "s-new" });
    expect(await createVscodeChat("desk", body)).toBe("s-new");
    expect(calls).toEqual([{ url: "/api/machines/desk/vscode/chat/new", body }]);
    expect(readVscodeDraft("desk", "s-new")).toBe("");
    expect(chosenFor("desk", "s-new")).toEqual({});
    // created, but its first message did not go: the chat opens with the words in its box, never re-sent
    calls = record(200, { session: "s-kept", sent: false });
    expect(await createVscodeChat("desk", body)).toBe("s-kept");
    expect(calls).toHaveLength(1);
    expect(readVscodeDraft("desk", "s-kept")).toBe("FICTIONAL first");
    expect(chosenFor("desk", "s-kept")).toEqual({ model: { id: "fictional/model-b", effort: "high" }, agent: null });
    // refused before anything was made: it throws, and nothing is kept anywhere
    calls = record(503, { error: { code: "vscode_host", message: "FICTIONAL host down" } });
    await expect(createVscodeChat("desk", { cwd: "/tmp/fictional-repo", text: "FICTIONAL other" })).rejects.toThrow("FICTIONAL host down");
    expect(calls).toHaveLength(1);
  });

  it("every send carries what the pills show: a pick, then the same pick again on the next message", async () => {
    const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT });
    const calls = record(200, { queued: false });
    const before: VscodeLast = { model: { id: "fictional/model-a", effort: null }, agent: null };
    await sendVscode("desk", { session: "s1", text: "FICTIONAL one" }, before);
    // the read after the send: the chat's last is now the pick, which is let go
    const after: VscodeLast = { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT };
    expect(settleChoice("desk", "s1", after)).toEqual({});
    await sendVscode("desk", { session: "s1", text: "FICTIONAL two" }, after);
    const carried = { model: { id: "fictional/model-b", effort: "high" }, agent: REPORT };
    expect(calls.map((each) => each.body)).toEqual([{ session: "s1", text: "FICTIONAL one", ...carried }, { session: "s1", text: "FICTIONAL two", ...carried }]);
  });

  it("with no pick, every send carries the chat's last model and agent; Agent and no model go as absent", async () => {
    const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
    const calls = record(200, { queued: true });
    expect(await sendVscode("desk", { session: "s1", text: "FICTIONAL next" }, { model: { id: "fictional/model-a", effort: "low" }, agent: REPORT })).toEqual({ queued: true });
    await sendVscode("desk", { session: "s1", text: "FICTIONAL again" }, { model: { id: "fictional/model-a", effort: null }, agent: null });
    await sendVscode("desk", { session: "s1", text: "FICTIONAL bare" }, NONE);
    expect(calls.map((each) => each.body)).toEqual([
      { session: "s1", text: "FICTIONAL next", model: { id: "fictional/model-a", effort: "low" }, agent: REPORT },
      { session: "s1", text: "FICTIONAL again", model: { id: "fictional/model-a" } },
      { session: "s1", text: "FICTIONAL bare" },
    ]);
    // a pick of "Agent" over a chat that used Report: no agent goes
    choose("desk", "s1", { agent: null });
    await sendVscode("desk", { session: "s1", text: "FICTIONAL plain" }, { model: null, agent: REPORT });
    expect(calls.at(-1)?.body).toEqual({ session: "s1", text: "FICTIONAL plain" });
  });
  // a POST held open until the test lets it answer
  const held = () => {
    const calls: unknown[] = [];
    let answer: (response: Response) => void = () => undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { answer = resolve; });
    }) as typeof fetch;
    return { calls, resolve: () => answer(new Response(JSON.stringify({ queued: false }), { status: 200, headers: { "content-type": "application/json" } })) };
  };

  it("a pick made while a send is on its way is kept for the next one", async () => {
    choose("desk", "s1", { model: { id: "fictional/model-a" } });
    const post = held();
    const sent = sendVscode("desk", { session: "s1", text: "FICTIONAL hello" }, NONE);
    choose("desk", "s1", { model: { id: "fictional/model-b", effort: "high" } });
    post.resolve();
    await sent;
    expect(post.calls).toEqual([{ session: "s1", text: "FICTIONAL hello", model: { id: "fictional/model-a" } }]);
    expect(chosenFor("desk", "s1")).toEqual({ model: { id: "fictional/model-b", effort: "high" } });
  });

  it("the composer's draft is kept per chat and let go by the send that carried it, screen or not", async () => {
    expect(readVscodeDraft("desk", "s1")).toBe("");
    keepVscodeDraft("desk", "s1", "FICTIONAL draft");
    expect(readVscodeDraft("desk", "s1")).toBe("FICTIONAL draft");
    expect(readVscodeDraft("desk", "s2")).toBe("");
    // a failed send keeps it
    record(503, { error: { code: "vscode_host", message: "down" } });
    await expect(sendVscode("desk", { session: "s1", text: "FICTIONAL draft" }, NONE)).rejects.toThrow();
    expect(readVscodeDraft("desk", "s1")).toBe("FICTIONAL draft");
    // the chat left while the send is on its way (no screen clears anything): the sent words do not come back
    const post = held();
    const sent = sendVscode("desk", { session: "s1", text: "FICTIONAL draft" }, NONE);
    post.resolve();
    await sent;
    expect(readVscodeDraft("desk", "s1")).toBe("");
    expect(session.has("herdr-web-ui:vscode-draft:desk:s1")).toBe(false);
  });

  it("words typed while a send is on its way stay in the draft", async () => {
    keepVscodeDraft("desk", "s1", "FICTIONAL first");
    const post = held();
    const sent = sendVscode("desk", { session: "s1", text: "FICTIONAL first" }, NONE);
    keepVscodeDraft("desk", "s1", "FICTIONAL first and more");
    post.resolve();
    await sent;
    expect(readVscodeDraft("desk", "s1")).toBe("FICTIONAL first and more");
  });
});

describe("the new chat's folders", () => {
  it("folderChoices dedupes, orders by newest chat, caps at 8, drops null", () => {
    const at = (session: string, cwd: string | null, ageMs: number): VscodeChatRow => ({ ...row(session, "idle", ageMs), cwd });
    const rows = [
      at("a", "/tmp/fictional/old", 9 * DAY),
      at("b", "/tmp/fictional/new", 1000),
      at("c", null, 0),
      at("d", "/tmp/fictional/old", 2000),
      at("e", "/tmp/fictional/new", 5 * DAY),
      ...Array.from({ length: 9 }, (_, i) => at(`f${i}`, `/tmp/fictional/f${i}`, (i + 1) * DAY)),
    ];
    expect(folderChoices(rows)).toEqual(["/tmp/fictional/new", "/tmp/fictional/old", "/tmp/fictional/f0", "/tmp/fictional/f1", "/tmp/fictional/f2", "/tmp/fictional/f3", "/tmp/fictional/f4", "/tmp/fictional/f5"]);
    expect(folderChoices([at("x", null, 0)])).toEqual([]);
  });

  it("sessionForFolder: the newest chat in the folder, else the PC's newest, else none", () => {
    const at = (session: string, cwd: string | null, ageMs: number): VscodeChatRow => ({ ...row(session, "idle", ageMs), cwd });
    const rows = [at("old-in", "/tmp/fictional/a", 3 * DAY), at("new-in", "/tmp/fictional/a", DAY), at("newest", "/tmp/fictional/b", 1000)];
    expect(sessionForFolder(rows, "/tmp/fictional/a")).toBe("new-in");
    expect(sessionForFolder(rows, "/tmp/fictional/elsewhere")).toBe("newest");
    expect(sessionForFolder([], "/tmp/fictional/a")).toBeNull();
  });
});

describe("the picker's model groups", () => {
  it("groups by the id's provider, the host's own models first as Copilot (provider null)", () => {
    const model = (id: string) => ({ id, name: id, efforts: null });
    const groups = groupModels([model("fictional/model-a"), model("own-1"), model("other/model-c"), model("fictional/model-b"), model("own-2")]);
    expect(groups.map((group) => [group.provider, group.models.map((each) => each.id)])).toEqual([
      [null, ["own-1", "own-2"]],
      ["fictional", ["fictional/model-a", "fictional/model-b"]],
      ["other", ["other/model-c"]],
    ]);
    expect(groupModels([model("fictional/model-a")]).map((group) => group.provider)).toEqual(["fictional"]);
  });
});

describe("the pushes", () => {
  it("a VS Code event is taken before the pane bookkeeping and goes to the listeners of a known PC only", () => {
    const heard: string[] = [];
    const stop = onVscodeMessage((machineId, message) => { heard.push(`${machineId} ${message.type}`); });
    try {
      const known = (id: string) => id === "desk";
      const changed = { type: "machine-message", machine_id: "desk", message: { type: "vscode-chat-changed", session: "s1" } } as const;
      expect(takeVscodeEvent(changed, known)).toBe(true);
      expect(takeVscodeEvent({ ...changed, machine_id: "gone" }, known)).toBe(true);
      expect(takeVscodeEvent({ type: "machine-message", machine_id: "desk", message: { type: "vscode-host", host: { state: "starting" } } }, known)).toBe(true);
      expect(heard).toEqual(["desk vscode-chat-changed", "desk vscode-host"]);
      // anything else is the stream's own
      expect(takeVscodeEvent({ type: "machine-message", machine_id: "desk", message: { type: "session-changed" } as never }, known)).toBe(false);
      expect(takeVscodeEvent({ type: "machines", machines: [] }, known)).toBe(false);
    } finally { stop(); }
  });

  it("App.tsx's event stream hands VS Code events over before it invalidates the pane snapshots", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const handler = app.slice(app.indexOf('new EventSource("/api/machines/events")'));
    const taken = handler.indexOf("if (takeVscodeEvent(");
    const invalidated = handler.indexOf("snapshotRequests.current.invalidate()");
    expect(taken).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(taken);
    expect(handler.slice(taken, handler.indexOf("\n", taken))).toContain(") return;");
  });

  it("coalesced runs one at a time, and calls during a run make exactly one more", async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const run = coalesced(() => { runs += 1; return new Promise<void>((resolve) => { release = resolve; }); });
    const first = run();
    for (let i = 0; i < 10; i += 1) void run();
    expect(runs).toBe(1);
    release();
    await until(() => runs === 2);
    release();
    await first;
    expect(runs).toBe(2);
    // idle again: the next call runs at once
    const next = run();
    expect(runs).toBe(3);
    release();
    await next;
    // a failed run does not stop the one after it
    let failures = 0;
    const flaky = coalesced(async () => { failures += 1; if (failures === 1) throw new Error("FICTIONAL"); });
    await flaky();
    expect(failures).toBe(1);
    await flaky();
    expect(failures).toBe(2);
  });
});

async function until(ready: () => boolean, ms = 2_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out");
}
