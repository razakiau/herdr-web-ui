import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// One fictional host chat on a remote demo PC, at 390 px: a Copilot tab in the workspace whose pane
// works in its folder, a folder row for a chat no workspace holds, "All agents on Build PC…", the chat's rows,
// the question card, the model · effort and agent pills with their sheet, a send that queues, and
// "+ New Copilot chat" (made and sent, and made with its first message not sent).
// The roster's `remote` is the fixture's `local` cloned; this patched fetch answers that PC's
// /api/host-chats routes itself and records what the app posts. No live session or agent host is read.
// HOST_CHATS_SHOTS=<dir> also saves the chat, the open sheet and the new-chat sheet as screenshots.
// A second fixture (?pcs=6) has six PCs: five fold under "Other PCs (5)", and one with a question waiting stays open.
const SESSION = "fictional-session-1";
const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
const SUB = "ahp-chat://default/fictional-sub";
const app = mkdtempSync(join(tmpdir(), "herdr-agent-host-chats-"));
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const SESSION = ${JSON.stringify(SESSION)}, REPORT = ${JSON.stringify(REPORT)}, SUB = ${JSON.stringify(SUB)};
  const calls = window.hostCalls = { posts: [], models: [] };
  // a chat's actions (Task 7): titles given, chats marked unread, read, done and deleted
  const edits = window.hostEdits = { titles: {}, unread: {}, archived: {}, deleted: [], failRead: false };
  const state = window.hostState = { answered: false, busy: false, model: { id: "fictional/model-a", effort: null }, agent: null, sent: [], created: [], newSent: true, failNextSend: false, older: false, pushed: [], pending: [], stopped: 0, mode: "interactive", approvals: "default" };
  const sources = new Set();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const SIX = new URLSearchParams(location.search).get("pcs") === "6";
  const ids = SIX ? ["local", "remote", "pc-c", "pc-d", "pc-e", "pc-f"] : ["local", "remote"];
  const NAMES = { local: "Laptop", remote: "Build PC", "pc-c": "FICTIONAL PC C", "pc-d": "FICTIONAL PC D", "pc-e": "FICTIONAL PC E", "pc-f": "FICTIONAL PC F" };
  const roster = (original) => ids.map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = NAMES[id];
    machine.state = "connected";
    // the Build PC's first workspace works in the build chat's folder: that chat is one of its tabs
    if (id === "remote") { const pane = machine.snapshot.panes.find((item) => item.workspace_id === machine.snapshot.workspaces[0].workspace_id); pane.cwd = "/tmp/fictional-repo/"; pane.foreground_cwd = "/tmp/fictional-repo/"; }
    // the six-PC fixture: no pane asks anywhere, so only a host chat's question keeps a folded PC open
    if (SIX) for (const pane of machine.snapshot.panes) if (pane.agent_status === "blocked") pane.agent_status = "idle";
    return machine;
  });
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const read = (session, before) => {
    // a subagent's own chat, read by its chat URI as the session
    if (session === SUB) {
      calls.subagent = (calls.subagent ?? 0) + 1;
      return { session: SUB, title: "explore", status: "idle", turns: [
        { role: "user", ts: at(6), parts: [{ kind: "text", text: "FICTIONAL find the build config" }] },
        { role: "assistant", ts: at(6), end_ts: at(5), parts: [{ kind: "text", text: "FICTIONAL the config is release.toml" }] },
      ], cursor: null, prompt: null, model: null, agent: null, busy: false, message_ids: ["sub-1"], signature: "sub" };
    }
    const made = state.created.find((chat) => chat.session === session);
    if (made) {
      const turns = made.sent ? [{ role: "user", ts: at(0), parts: [{ kind: "text", text: made.text }] }, { role: "assistant", ts: at(0), parts: [] }] : [];
      return { session, title: edits.titles[session] ?? "FICTIONAL new chat", status: "idle", turns, cursor: null, prompt: null, model: null, agent: null, busy: false, message_ids: made.sent ? ["new-1"] : [], signature: JSON.stringify([made, edits.titles[session] ?? null]) };
    }
    // the host's window: a read with its cursor loads the turn before it, ahead of the rest
    if (before === "c-older") state.older = true;
    const older = state.older ? [
      { role: "user", ts: at(30), parts: [{ kind: "text", text: "FICTIONAL an earlier ask" }] },
      { role: "assistant", ts: at(30), parts: [{ kind: "text", text: "FICTIONAL an earlier answer" }] },
    ] : [];
    const turns = [
      ...older,
      { role: "user", ts: at(9), parts: [{ kind: "text", text: "FICTIONAL look at the build" }] },
      { role: "assistant", ts: at(9), end_ts: at(8), parts: [
        { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running FICTIONAL make test", input: "make test", output: "FICTIONAL ok", error: false, command: "make test", exit_code: 0 },
        { kind: "tool", name: "Read file", tool_id: "view", summary: "Reading", past: "Read", input: JSON.stringify({ path: "/tmp/fictional-repo/README.md" }), output: "", error: false },
        { kind: "tool", name: "Read file", tool_id: "view", summary: "Reading", past: "Read", input: JSON.stringify({ path: "/tmp/fictional-repo/README.md" }), output: "", error: false },
        { kind: "tool", name: "Edit file", tool_id: "edit", summary: "Editing", past: "Edited", input: JSON.stringify({ path: "/tmp/fictional-repo/src/build.ts" }), output: "", error: false, edits: [{ path: "/tmp/fictional-repo/src/build.ts", added: 28, removed: 3 }] },
        { kind: "tool", name: "View image", tool_id: "view", summary: "Viewing", past: "Viewed the screenshot", input: "{}", output: "", error: false, images: [{ media_type: "image/png", ref: "c-shot:0" }] },
        { kind: "text", text: "FICTIONAL the edit is in; now the tests." },
        { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running FICTIONAL bun test", input: "bun test", output: "FICTIONAL 3 pass", error: false, command: "bun test", exit_code: 0 },
        { kind: "tool", name: "Run in terminal", tool_id: "bash", summary: "Running FICTIONAL bun run lint", input: "bun run lint", output: "FICTIONAL clean", error: false, command: "bun run lint", exit_code: 0 },
        { kind: "text", text: "FICTIONAL the build passes.\\n\\n\`\`\`mermaid\\nflowchart LR\\n  A[FICTIONAL edit] --> B{FICTIONAL tests}\\n  B -->|pass| C[FICTIONAL ship]\\n  B -->|fail| A\\n\`\`\`" },
      ] },
      { role: "user", ts: at(6), parts: [{ kind: "text", text: "FICTIONAL find the config" }] },
      { role: "assistant", ts: at(6), end_ts: at(5), parts: [
        { kind: "subagent", id: "c-sub", agent: "explore", description: "FICTIONAL find the build config", model: "FICTIONAL Model B", started: at(6), ended: new Date(Date.parse(at(6)) + 343_000).toISOString(), status: "done", chat: SUB },
        { kind: "question", text: "FICTIONAL which config?", options: ["FICTIONAL debug", "FICTIONAL release"], chosen: ["FICTIONAL release"], custom: null, skipped: false },
        { kind: "text", text: "FICTIONAL release it is." },
      ] },
      { role: "user", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL what next" }] },
      { role: "assistant", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL which way should I go?" }] },
    ];
    for (const text of state.pushed) turns.push({ role: "user", ts: at(1), parts: [{ kind: "text", text: "FICTIONAL from the PC" }] }, { role: "assistant", ts: at(1), parts: [{ kind: "text", text }] });
    for (const text of state.sent) turns.push({ role: "user", ts: at(0), parts: [{ kind: "text", text }] }, { role: "assistant", ts: at(0), parts: [] });
    const ids = [...(state.older ? ["h0"] : []), "h1", "h1b", "h2", ...state.pushed.map((_, index) => "p" + index), ...state.sent.map((_, index) => "s" + index)];
    const prompt = state.answered ? null : {
      id: "req-1:q-1", agent: "copilot", kind: "question", title: "FICTIONAL direction", question: "FICTIONAL pick **one** direction",
      body: "FICTIONAL see the \`map\` first" + Array.from({ length: 40 }, (_, index) => "\\n\\n- FICTIONAL step " + (index + 1)).join(""), options: [{ label: "FICTIONAL north", description: null }, { label: "FICTIONAL south", description: null }, { label: "FICTIONAL east", description: "FICTIONAL **plain** here" }, { label: "Other…", description: null }],
      multi_select: false, custom_option_index: 3,
      host: { request_id: "req-1", question_id: "q-1", option_ids: ["opt-north", "opt-south", "opt-east", ""] },
    };
    return { session: SESSION, title: "FICTIONAL build chat", status: prompt ? "asks" : state.busy ? "working" : "idle", turns, cursor: state.older ? null : "c-older", prompt,
      model: state.model, agent: state.agent, busy: state.busy || prompt !== null, pending: state.pending,
      commands: [{ name: "fictional-skill", description: "FICTIONAL does a thing", kind: "skill" }], message_ids: ids,
      background: state.background ?? { subagents: 0, commands: 0 }, confirmations: 0,
      context: { currentTokens: 84000, tokenLimit: 200000, conversationTokens: 60000, systemTokens: 9000, toolDefinitionsTokens: 15000 },
      signature: JSON.stringify([state.answered, state.busy, state.sent, state.model, state.agent, state.older, state.pushed, state.pending, state.background ?? null]) };
  };
  const edited = (rows) => rows.filter((row) => !edits.deleted.includes(row.session)).map((row) => ({ ...row,
    ...(row.session in edits.titles ? { title: edits.titles[row.session] } : {}),
    ...(row.session in edits.unread ? { unread: edits.unread[row.session] } : {}),
    ...(row.session in edits.archived ? { archived: edits.archived[row.session] } : {}) }));
  const push = (message) => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote", message }) }));
  };
  // the six-PC fixture: FICTIONAL PC E's chat starts asking, and its push says so
  window.askOnPcE = () => {
    state.peAsks = true;
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "pc-e", message: { type: "host-chat-changed", session: null } }) }));
  };
  // the list's push, as the bridge sends one when the host adds a chat
  window.pushHostList = () => push({ type: "host-chat-changed", session: null });
  // the PC's agent host stops (VS Code closed) and comes back: its state and list say so
  window.setHostDown = (down) => { state.hostDown = down; push({ type: "host-chat-state", host: down ? { state: "no_server" } : { state: "connected", signed_in: true, protocol: "1.0.0" } }); };
  // a turn that ends takes its steering and queued messages with it, as a host does
  window.setHostBusy = (busy) => { state.busy = busy; if (!busy) state.pending = []; push({ type: "host-chat-changed", session: SESSION }); };
  // a turn made on the PC: only its push tells the phone
  window.pushHostTurn = (text) => { state.pushed.push(text); push({ type: "host-chat-changed", session: SESSION }); };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") message.machines = roster(message.machines);
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { sources.delete(this); this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); return json({ machines: roster(value.machines) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    // a pane request without a pane: what a host chat's ChatView must never make
    if (path.startsWith("/api/pane/") && url.searchParams.get("pane_id") === "") (calls.paneless ??= []).push(url.pathname + url.search);
    if (path.startsWith("/api/pane/") && url.searchParams.get("pane_id") === null && init?.body && String(init.body).includes('"pane_id":""')) (calls.paneless ??= []).push(url.pathname);
    // the six-PC fixture: FICTIONAL PC E's host chat waits on a question
    if (SIX && machine === "pc-e" && path === "/api/host-chats/state") return json({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
    if (SIX && machine === "pc-e" && path === "/api/host-chats/chats") return json({ chats: [{ session: "fictional-pc-e", title: "FICTIONAL waits on you", status: state.peAsks ? "asks" : "idle", modified_at: at(1), cwd: "/tmp/fictional-e", unread: false, archived: false }] });
    if (machine === "remote" && path.startsWith("/api/host-chats/")) {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (init?.method === "POST") calls.posts.push({ path: url.pathname, body });
      if (state.hostDown && (path === "/api/host-chats/state" || path === "/api/host-chats/chats")) return path.endsWith("/state") ? json({ host: { state: "no_server" } }) : json({ error: { code: "agent_host_down", message: "FICTIONAL the agent host is down" }, host: { state: "no_server" } }, 503);
      if (path === "/api/host-chats/state") return json({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
      if (path === "/api/host-chats/chats") return json({ chats: edited([
        { session: SESSION, title: "FICTIONAL build chat", status: SIX || state.answered ? (state.busy ? "working" : "idle") : "asks", modified_at: at(2), cwd: "/tmp/fictional-repo", unread: false, archived: false },
        { session: "fictional-session-0", title: "FICTIONAL docs chat", status: "idle", modified_at: at(60 * 30), cwd: "/tmp/fictional-docs", unread: false, archived: false },
        // 20 days old: only "All agents on Build PC…" lists it
        { session: "fictional-session-old", title: "FICTIONAL old release notes", status: "idle", modified_at: at(60 * 24 * 20), cwd: "/tmp/fictional-repo", unread: false, archived: false },
        { session: "fictional-session-done", title: "FICTIONAL archived chat", status: "idle", modified_at: at(60 * 24 * 2), cwd: "/tmp/fictional-repo", unread: false, archived: true },
        ...state.created.map((chat) => ({ session: chat.session, title: "FICTIONAL new chat", status: "idle", modified_at: at(0), cwd: chat.cwd, unread: false, archived: false })),
      ]) });
      // an attached file, stored in the chat's folder on its PC (a failure on request)
      if (path === "/api/host-chats/chat/upload") {
        if (state.failUpload) return json({ error: { code: "image_too_large", message: "FICTIONAL no room on the PC" } }, 413);
        return json({ path: "/tmp/fictional-repo/.herdr-web-ui/" + body.name });
      }
      if (path === "/api/host-chats/chat/stop") { state.stopped += 1; state.busy = false; return json({ ok: true }); }
      if (path === "/api/host-chats/chat/pending/remove") { state.pending = state.pending.filter((each) => each.id !== body.id); return json({ ok: true }); }
      // the row and tab menus' actions: the host has them, and says so on its next list
      const action = { "/api/host-chats/chat/rename": "rename", "/api/host-chats/chat/read": "read", "/api/host-chats/chat/archive": "archive", "/api/host-chats/chat/delete": "delete" }[path];
      if (action) {
        if (action === "read" && edits.failRead) return json({ error: { code: "agent_host_failed", message: "FICTIONAL the host said no" } }, 502);
        if (action === "rename") edits.titles[body.session] = body.title;
        if (action === "read") edits.unread[body.session] = !body.read;
        if (action === "archive") edits.archived[body.session] = body.archived;
        if (action === "delete") edits.deleted.push(body.session);
        setTimeout(() => { push({ type: "host-chat-changed", session: body.session }); push({ type: "host-chat-changed", session: null }); }, 50);
        return json({ ok: true });
      }
      // the docs chat's host is down: the bridge says why in its own words
      if (path === "/api/host-chats/chat" && url.searchParams.get("session") === "fictional-session-0") return json({ error: { code: "agent_host_down", message: "FICTIONAL the agent host is down" } }, 503);
      if (path === "/api/host-chats/chat") { if (url.searchParams.has("before")) calls.before = [...(calls.before ?? []), url.searchParams.get("before")]; return json(read(url.searchParams.get("session"), url.searchParams.get("before"))); }
      if (path === "/api/host-chats/chat/new") {
        const session = "fictional-new-" + (state.created.length + 1);
        state.created.push({ session, cwd: body.cwd, text: body.text, sent: state.newSent });
        return json(state.newSent ? { session } : { session, sent: false });
      }
      if (path === "/api/host-chats/models") calls.models.push(url.searchParams.get("session"));
      if (path === "/api/host-chats/models") return json({
        models: [
          { id: "fictional-own", name: "FICTIONAL Own", provider: "copilotcli", efforts: null, context: null, group: "copilot", multiplier: 27, warning: "FICTIONAL Own has a planned deprecation date." },
          { id: "fictional/model-a", name: "FICTIONAL Model A (Anthropic)", provider: "copilotcli", efforts: null, context: 200000 },
          { id: "fictional/model-b", name: "FICTIONAL Model B", provider: "copilotcli", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] }, context: 1000000 },
          { id: "fictional/glm-x", name: "FICTIONAL GLM-X (FICTIONAL Go)", provider: "fictional-router", efforts: null, context: null },
        ],
        agents: [{ uri: REPORT, name: "Report", description: "FICTIONAL writes a report" }],
      });
      if (path === "/api/host-chats/files") return json({ files: ["src/fictional-build.ts", "README.md"].filter((file) => file.includes(url.searchParams.get("q") ?? "")) });
      // the session's mode and permissions, as the live host shapes them
      if (path === "/api/host-chats/session/config" && init?.method === "POST") { if (body.mode) state.mode = body.mode; if (body.approvals) state.approvals = body.approvals; return json({ ok: true }); }
      if (path === "/api/host-chats/session/config") return json({ mode: state.mode, approvals: state.approvals, modes: ["interactive", "plan", "autopilot"], approvalModes: ["default", "assisted", "autoApprove"] });
      if (path === "/api/host-chats/chat/watch" || path === "/api/host-chats/chat/draft" || path === "/api/host-chats/chat/confirm") return json({ ok: true });
      if (path === "/api/host-chats/chat/answer") { if (state.holdAnswer) return json({ error: { code: "prompt_changed", message: "FICTIONAL changed" } }, 409); state.answered = true; return json({ ok: true }); }
      if (path === "/api/host-chats/chat/send") {
        // the proxy's 502 after the bridge got it: the message went, the answer did not
        const lost = state.failNextSend;
        state.failNextSend = false;
        // VS Code's send modes on a busy chat: a steer joins the one set, a queue waits, Stop and Send ends the turn first
        if (state.busy && body.mode !== "stop_and_send") {
          if (lost) { state.failNextSend = false; }
          if (body.model) state.model = { id: body.model.id, effort: body.model.effort ?? null };
          if ("agent" in body) state.agent = body.agent;
          const kind = body.mode === "steer" ? "steering" : "queued";
          const steering = kind === "steering" ? state.pending.find((each) => each.kind === "steering") : undefined;
          if (steering) steering.text = steering.text + "\\n\\n" + body.text;
          else if (!state.pending.some((each) => each.id === body.id)) state.pending.push({ id: body.id, kind, text: body.text });
          if (lost) return json({ error: { code: "bad_gateway", message: "FICTIONAL proxy" } }, 502);
          return json(steering ? { queued: true, joined: true } : { queued: true });
        }
        if (body.mode === "stop_and_send") { state.stopped += 1; state.busy = false; }
        const queued = state.busy;
        state.sent.push(body.text);
        if (body.model) state.model = { id: body.model.id, effort: body.model.effort ?? null };
        if ("agent" in body) state.agent = body.agent;
        if (lost) return json({ error: { code: "bad_gateway", message: "FICTIONAL proxy" } }, 502);
        return json({ queued });
      }
      return json({ error: { code: "not_found", message: path } }, 404);
    }
    // the Build PC's bridge: its agent host is up and signed in, and Copilot's command is installed too
    if (match && machine === "remote" && path === "/api/agents") return json({ agents: [
      { kind: "claude", label: "Claude Code", installed: true },
      { kind: "copilot", label: "Copilot (terminal)", installed: true },
      { kind: "copilot-host", label: "Copilot (host)", installed: true },
    ] });
    if (match && path === "/api/session") {
      const value = await (await fetchDemo("/api/machines")).json();
      return json({ snapshot: roster(value.machines).find((item) => item.id === machine).snapshot });
    }
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

const shots = process.env["HOST_CHATS_SHOTS"];
try {
  await buildDemoApp(app);
  writeFileSync(join(app, "host-chats.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./host-chats.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // a tool's picture (an <img>, so not through the page's fetch): a fictional 1×1 PNG
    if (path.endsWith("/host-chats/image")) return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png" } });
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "on" })));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error" && message.text().includes("render failed")) errors.push(message.text()); });
        type Post = { path: string; body: Record<string, unknown> };
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        // a send's or new chat's body without its id, once the id is checked to be a UUID
        const bare = (post: Post | undefined): Record<string, unknown> | undefined => {
          if (!post) return undefined;
          const { id, ...rest } = post.body;
          assert.match(String(id), UUID, `${post.path} carries a UUID id`);
          return rest;
        };
        const posts = async (path: string): Promise<Post[]> => (await page.evaluate(() => (window as unknown as { hostCalls: { posts: Post[] } }).hostCalls.posts)).filter((post) => post.path === path);
        const fits = async (what: string) => {
          const width = await page.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(width <= 390, `${what}: no horizontal overflow at 390 px (scrollWidth ${width})`);
        };
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.locator(".conn-live").waitFor({ state: "attached" });

        // 1. a host chat is a Copilot agent: no Copilot section, a tab in the workspace whose pane works
        // in its folder, a folder row for the one whose folder no workspace holds, nothing that says VS Code
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        const remoteGroup = page.getByRole("region", { name: "PC Build PC", exact: true });
        const folderRow = remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-docs"]');
        await folderRow.waitFor();
        assert.equal(await page.getByRole("heading", { name: "Copilot", exact: true }).count(), 0, "no Copilot heading");
        assert.equal(await page.locator(".host-chats").count(), 0, "no Copilot section");
        assert.equal((await folderRow.locator(".workspace-name").first().innerText()).trim().length > 0, true, "the folder row has a name");
        assert.equal(await folderRow.locator('svg[aria-label="copilot"]').count(), 1, "the folder row leads with Copilot's mark");
        assert.equal(await page.locator('svg[aria-label="vscode"]').count(), 0, "no vscode mark");
        assert.equal(await remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-repo"]').count(), 0, "a folder a workspace works in is no folder row");
        assert.equal(await page.locator('[data-machine="local"].host-chat-item').count(), 0, "a PC whose bridge has the feature off has no chats");
        const noVsCode = async (what: string) => assert.doesNotMatch(await page.locator("body").innerText(), /VS Code|Copilot chats/, `${what}: no "VS Code" or "Copilot chats" text`);
        await noVsCode("the sidebar");
        // the build chat asks: the Agents list shows it, with Copilot's mark
        const agentsRow = page.locator(`.agents-sidebar .host-chat-item[data-machine="remote"][data-host-session="${SESSION}"]`);
        await page.locator(".agents-sidebar .agent-section-toggle").click();
        await agentsRow.waitFor();
        assert.equal(await agentsRow.locator('svg[aria-label="copilot"]').count(), 1, "an Agents row wears Copilot's mark");
        assert.equal(await page.locator('.agents-sidebar [data-host-session="fictional-session-0"]').count(), 0, "an idle, read chat is not in the Agents list");
        // the workspace's row counts its asking chat: a "?" in its state
        const workspaceRow = remoteGroup.locator(".workspace-group").first();
        assert.equal(await workspaceRow.locator('.sidebar-status[data-status="blocked"]').count(), 1, "the workspace's roll-up counts its asking host chat");
        await fits("the sidebar");
        await folderRow.scrollIntoViewIfNeeded();
        if (shots) await page.screenshot({ path: join(shots, "task-6-folder-row-390.png") });
        console.log("PASS a host chat is a Copilot agent: a folder row, an Agents row, a counted workspace, no Copilot section and no VS Code text");

        // 2. the chat: the app's ChatView, with a user turn, an assistant's text and a folded tool row,
        // opened from the Agents list, as a tab of its workspace after the panes' tabs
        await agentsRow.locator(".agent-select").click();
        const view = page.locator(`.host-chat[data-host-session="${SESSION}"]`);
        await view.waitFor();
        const hostTab = page.locator(`.tab-strip .host-chat-tab[data-host-session="${SESSION}"]`);
        await hostTab.waitFor();
        assert.equal(await hostTab.locator('[role="tab"]').getAttribute("aria-selected"), "true", "its tab is the open one");
        assert.equal(await hostTab.locator('svg[aria-label="copilot"]').count(), 1, "the tab wears Copilot's mark");
        assert.equal(await hostTab.locator(".host-chat-tab-glyph").count(), 0, "no host glyph: no Copilot pane in the workspace");
        assert.equal(await hostTab.locator('.tab-strip-dot[data-status="blocked"]').count(), 1, "its status dot says it asks");
        assert.equal(await page.locator('.tab-strip-item:not(.host-chat-tab) [role="tab"][aria-selected="true"]').count(), 0, "no pane's tab is open beside it");
        assert.ok(await page.locator(".tab-strip-item:not(.host-chat-tab)").count() > 0, "the workspace's pane tabs stand before it");
        await noVsCode("the open chat");
        // the PC's agent host stops and comes back (VS Code closed, then opened): the chat stays open
        await page.evaluate(() => (window as unknown as { setHostDown(down: boolean): void }).setHostDown(true));
        await page.waitForTimeout(300);
        assert.equal(await page.locator(`.host-chat[data-host-session="${SESSION}"]`).count(), 1, "a host going down leaves the open chat open");
        await page.evaluate(() => (window as unknown as { setHostDown(down: boolean): void }).setHostDown(false));
        await hostTab.waitFor();
        assert.equal(await hostTab.locator('[role="tab"]').getAttribute("aria-selected"), "true", "and it is still the open tab once the host is back");
        await fits("the workspace with its Copilot tab");
        // the pick puts the drawer away: the shot waits for it to have gone
        await page.waitForFunction(() => { const drawer = document.querySelector("#workspace-drawer"); return drawer !== null && !drawer.classList.contains("is-open") && drawer.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"); });
        await page.waitForTimeout(400);
        // the demo's own alerts (a Laptop agent finishing) float over the strip: hidden for the picture alone
        if (shots) await page.screenshot({ path: join(shots, "task-6-workspace-tab-390.png"), style: ".droplet, .droplet-stack { display: none !important; }" });
        // only ChatView reading a host source draws these: its transcript tagged with the source's
        // kind, and rows keyed by the source's key (the old screen tagged none and keyed by place)
        const transcript = view.locator('.terminal-surface > .chat-frame .chat-view[data-conversation-source="agent-host"]');
        await transcript.waitFor();
        assert.equal(await view.locator(".chat-view").count(), 1, "one transcript");
        assert.equal(await transcript.getAttribute("aria-label"), "Copilot chat FICTIONAL build chat", "named for the chat");
        assert.ok((await transcript.locator("[data-chat-row]").first().getAttribute("data-chat-row"))?.includes(`host:remote:${SESSION}`), "its rows are keyed by the host source's key");
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL look at the build" }).waitFor();
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).waitFor();
        const block = view.locator(".work-block").first();
        await block.waitFor();
        assert.match(await block.getAttribute("class") ?? "", /is-folded/, "the finished turn's tool work is folded");
        assert.equal(await block.locator(".work-row").count(), 0, "a folded block draws no tool rows");
        // the vscode style: VS Code's sentence for the group, the edits' lines and the time on the right
        const head = block.locator(".work-block-head");
        assert.match(await block.getAttribute("class") ?? "", /is-vscode/, "a host chat reads in the vscode style");
        assert.equal((await head.locator(".work-block-title").innerText()).trim(), "Edited build.ts, ran 1 command, read README.md, 1 other step", "the head sums the group up as VS Code does, a file read twice once");
        assert.equal((await head.locator(".work-title-detail").innerText()).trim(), "build.ts, ran 1 command, read README.md, 1 other step", "the first word is plain, the rest quieter");
        assert.equal(await head.locator(".work-block-lines").innerText(), "+28 −3", "the edits' lines on the right");
        assert.equal(await head.locator(".work-block-time").count(), 0, "an earlier group leaves the time to the last");
        assert.equal(await head.locator("svg.lucide-check.work-block-icon").count(), 1, "a finished group wears the check");
        assert.equal(await head.locator(".work-block-summary").count(), 0, "no classic counts");
        // VS Code's grouping: the words between two runs of tools stand in the open, each run folds
        const agentTurn = view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." });
        assert.equal(await agentTurn.locator(".work-block.is-vscode").count(), 2, "one group per run of tools");
        assert.equal(await agentTurn.locator(":scope > .work-words").innerText(), "FICTIONAL the edit is in; now the tests.", "the narration is outside every fold");
        const second = agentTurn.locator(".work-block.is-vscode").nth(1);
        assert.equal((await second.locator(".work-block-title").innerText()).trim(), "Ran 2 commands", "the second group has its own sentence");
        assert.match(await second.locator(".work-block-time").innerText(), /^Worked for \d+m$/, "the last group says how long the turn worked, on its quiet right");
        // a diagram in the answer: drawn by Pele in the app's colours, recoloured by a theme switch
        const diagram = agentTurn.locator(".markdown-mermaid svg.pele");
        await diagram.waitFor();
        const stroke = () => diagram.evaluate((svg) => getComputedStyle(svg).getPropertyValue("--pele-fg").trim());
        const darkInk = await stroke();
        if (shots) { await diagram.scrollIntoViewIfNeeded(); await agentTurn.locator(".markdown-mermaid").screenshot({ path: join(shots, "diagram-dark.png") }); }
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
        assert.notEqual(await stroke(), darkInk, "the light theme recolours the drawn diagram");
        if (shots) await agentTurn.locator(".markdown-mermaid").screenshot({ path: join(shots, "diagram-light.png") });
        await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
        // the tool's picture: under the block, outside the fold, through the host source
        const thumb = view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).locator(":scope > .work-images .chat-user-image img");
        // the workspace's tab strip stands above the chat now: the turn is brought into view, where its lazy picture loads
        await thumb.scrollIntoViewIfNeeded();
        await thumb.waitFor();
        assert.equal(await thumb.count(), 1, "the picture a tool returned shows under the folded block");
        assert.match(await thumb.getAttribute("src") ?? "", /host-chats\/image\?.*ref=c-shot%3A0/, "its URL is the host source's");
        await head.click();
        const command = block.locator(".work-row", { hasText: "make test" });
        await command.waitFor();
        assert.equal((await command.locator(".work-row-text").innerText()).trim(), "Ran make test", "a terminal row reads Ran and its command");
        assert.equal(await command.locator(".work-row-text code").innerText(), "make test", "the command in a code chip");
        assert.equal(await command.locator("svg.lucide-square-terminal").count(), 1, "the terminal icon");
        await command.locator(".work-row-head").click();
        await command.locator(".chat-tool-output", { hasText: "FICTIONAL ok" }).waitFor();
        const pill = block.locator(".work-row", { hasText: "Edited" }).locator(".work-file-pill");
        assert.equal(await pill.innerText(), "build.ts", "a file the row names is a pill with its name");
        assert.equal(await pill.locator("svg").count(), 1, "and its icon");
        await page.waitForFunction(() => (window as unknown as { hostCalls: { posts: { path: string }[] } }).hostCalls.posts.some((post) => post.path.endsWith("/host-chats/chat/watch")));
        await fits("the chat");
        if (shots) await page.screenshot({ path: join(shots, "task-5-chat-390.png") });
        if (shots) await page.screenshot({ path: join(shots, "task-4-host-390.png") });
        console.log("PASS the chat renders through ChatView: a user turn, an assistant text and a folded tool row, and is watched");

        // 2b. earlier messages: the host's cursor loads the turn before, above the ones shown, once
        // a chat shorter than the view asks for it on its own, as a pane's does (the button stays for a long one)
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL an earlier answer" }).waitFor();
        await view.locator(".chat-endcap", { hasText: "beginning of conversation" }).waitFor();
        const earlierFirst = await view.locator(".chat-turn").allTextContents();
        assert.ok(earlierFirst.findIndex((text) => text.includes("FICTIONAL an earlier answer")) < earlierFirst.findIndex((text) => text.includes("FICTIONAL look at the build")), "the earlier turn sits above");
        assert.equal(earlierFirst.filter((text) => text.includes("FICTIONAL look at the build")).length, 1, "no turn twice");
        assert.deepEqual(await page.evaluate(() => (window as unknown as { hostCalls: { before?: string[] } }).hostCalls.before), ["c-older"], "one read with the host's cursor");
        console.log("PASS the host's cursor loads the older turn above the ones shown, once, to the beginning");

        // 2c. a turn made on the PC: its push alone brings it, under the turns already shown
        await page.evaluate(() => (window as unknown as { pushHostTurn(text: string): void }).pushHostTurn("FICTIONAL pushed answer"));
        // the reader opened a row above, so the list is not following: the new turn is drawn at the end
        await transcript.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL pushed answer" }).waitFor({ timeout: 5_000 });
        assert.equal(await view.locator(".chat-turn-agent", { hasText: "FICTIONAL an earlier answer" }).count(), 1, "the earlier page stays");
        // no scrollback, terminal output, prompt state or skill list is read for it: it has no pane
        assert.deepEqual(await page.evaluate(() => (window as unknown as { hostCalls: { paneless?: string[] } }).hostCalls.paneless ?? []), [], "no pane request for a host chat");
        console.log("PASS a pushed change appears in the chat");

        // 2d. a subagent row (its own row, outside the work block) that opens to its own chat, and an
        // answered question as VS Code's summary
        const subTurn = view.locator(".chat-turn-agent", { hasText: "FICTIONAL release it is." });
        const sub = subTurn.locator(":scope > .subagent-row");
        await sub.waitFor();
        assert.equal(await subTurn.locator(".work-block .subagent-row").count(), 0, "a subagent is never inside a work block");
        assert.equal((await sub.locator(".subagent-row-name").innerText()).trim(), "explore", "the agent's name");
        assert.equal((await sub.locator(".subagent-row-description").innerText()).trim(), "FICTIONAL find the build config", "its task");
        assert.equal((await sub.locator(".subagent-row-model").innerText()).trim(), "FICTIONAL Model B", "a model not the chat's");
        assert.equal((await sub.locator(".subagent-row-time").innerText()).trim(), "Worked for 5m 43s", "VS Code's elapsed time");
        assert.equal(await sub.locator("svg.lucide-messages-square").count(), 1, "the comment-discussion icon");
        await sub.scrollIntoViewIfNeeded();
        await fits("the subagent row");
        if (shots) await page.screenshot({ path: join(shots, "task-5-subagent-collapsed-390.png") });
        await sub.locator(".subagent-row-head").click();
        await sub.locator(".subagent-row-body .chat-turn-agent", { hasText: "FICTIONAL the config is release.toml" }).waitFor();
        assert.ok((await page.evaluate(() => (window as unknown as { hostCalls: { subagent?: number } }).hostCalls.subagent ?? 0)) >= 1, "its chat is read by its URI");
        await fits("the opened subagent row");
        if (shots) await page.screenshot({ path: join(shots, "task-5-subagent-expanded-390.png") });
        const summary = subTurn.locator(".question-summary");
        assert.equal((await summary.locator(".question-summary-question").innerText()).replace(/\s+/g, " ").trim(), "Question: FICTIONAL which config?", "Question: and the text");
        assert.equal((await summary.locator(".question-summary-answer").innerText()).replace(/\s+/g, " ").trim(), "Answered: FICTIONAL release", "Answered: and the answer");
        await summary.locator(".question-summary-answer").click();
        const chosen = summary.locator(".question-summary-option.is-selected");
        assert.equal((await chosen.innerText()).trim(), "FICTIONAL release", "the chosen option is checked");
        assert.equal(await chosen.locator("svg.lucide-check").count(), 1);
        await summary.scrollIntoViewIfNeeded();
        await fits("the answered question");
        if (shots) await page.screenshot({ path: join(shots, "task-5-question-390.png") });
        console.log("PASS a subagent row shows its name, task, model and time and opens to its own chat; an answered question reads Question / Answered");

        // 3. the question card: its markdown rendered, a typed answer through "Other…", then option 2
        const card = page.locator(".prompt-card");
        await card.locator(".prompt-card-question strong", { hasText: "one" }).waitFor();
        await card.locator(".prompt-card-body code", { hasText: "map" }).waitFor();
        assert.match(await card.locator(".prompt-card-option-description").innerText(), /\*\*plain\*\*/, "an option's description stays plain");
        assert.equal(await card.getByRole("textbox").getAttribute("placeholder"), "Other…", "the typed-answer field is the Other… slot");
        // the status row says what the chat waits on, VS Code's words, and ends with its context meter
        assert.equal((await view.locator(".host-chat-status-line").textContent())?.trim(), "Waiting for your response", "an open question: Waiting for your response");
        assert.equal((await view.locator(".host-chat-meter-label").textContent())?.trim(), "42% · 84K / 200K", "the meter reads copilot.usageInfo");
        assert.equal(await view.locator(".host-chat-meter").getAttribute("title"), "Context window: 42% · 84K / 200K");
        assert.equal((await view.locator(".host-chat-meter-short").innerText()).trim(), "42%", "a phone shows the percent, the counts in its title and sheet");
        await fits("the card");
        // the card opens to a full-height sheet: the question scrolls, the answer field stays in view,
        // and collapsing keeps the typed text
        await card.getByRole("textbox").fill("FICTIONAL kept");
        await card.getByRole("button", { name: "Open full screen" }).click();
        const expanded = page.getByRole("dialog", { name: "Agent is asking" });
        await expanded.waitFor();
        const opened = expanded.locator(".prompt-card");
        assert.equal(await opened.getByRole("textbox").inputValue(), "FICTIONAL kept", "the typed text goes with the card");
        // the sheet rises: measure it once it has stopped moving
        await expanded.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
        const sized = await expanded.evaluate((node) => {
          const field = node.querySelector(".prompt-card-custom .input")!.getBoundingClientRect();
          const body = node.querySelector(".prompt-card-body")!;
          return { height: node.getBoundingClientRect().height, viewport: window.innerHeight, fieldBottom: field.bottom, bodyScrolls: body.scrollHeight > body.clientHeight + 1 };
        });
        assert.ok(sized.height > sized.viewport * 0.85, `the sheet fills the screen (${sized.height} of ${sized.viewport})`);
        assert.ok(sized.bodyScrolls, "the long message scrolls on its own inside the sheet");
        assert.ok(sized.fieldBottom <= sized.viewport, `the answer field is on screen without scrolling (bottom ${sized.fieldBottom} of ${sized.viewport})`);
        await fits("the expanded card");
        if (shots) await page.screenshot({ path: join(shots, "task-10-card-expanded-390.png") });
        await opened.getByRole("button", { name: "Exit full screen" }).click();
        await expanded.waitFor({ state: "detached" });
        assert.equal(await card.getByRole("textbox").inputValue(), "FICTIONAL kept", "collapsing returns the card inline with its text");
        assert.equal(await page.locator(".modal-scrim .prompt-card").count(), 0, "no card left in a sheet");
        // a typed answer with an image: the upload fails first (nothing posted, text and chip kept),
        // then the answer goes as "@<path> " + the text
        await card.getByRole("textbox").fill("FICTIONAL west");
        await page.evaluate(() => { (window as unknown as { hostState: { failUpload: boolean } }).hostState.failUpload = true; });
        await card.locator('input[type="file"]').setInputFiles({ name: "fictional-west.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
        await card.locator(".prompt-card-files img").waitFor();
        await card.getByRole("button", { name: "Send" }).click();
        await card.locator(".prompt-card-error", { hasText: /^FICTIONAL no room on the PC$/ }).waitFor();
        assert.equal((await posts("/api/machines/remote/host-chats/chat/answer")).length, 0, "a failed upload posts no answer");
        assert.equal(await card.getByRole("textbox").inputValue(), "FICTIONAL west", "and keeps the typed text");
        assert.equal(await card.locator(".prompt-card-files .composer-attachment").count(), 1, "and the chip");
        if (shots) {
          // the collapsed sheet's leaving copy (lib/sheets.ts) is gone before the picture
          await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLElement && node.inert && node.shadowRoot === null && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
          await page.screenshot({ path: join(shots, "task-10-card-attach-390.png") });
        }
        await page.evaluate(() => { (window as unknown as { hostState: { failUpload: boolean } }).hostState.failUpload = false; });
        // a typed answer goes as its text and the slot's empty id (refused here, so the card stays for option 2)
        await page.evaluate(() => { (window as unknown as { hostState: { holdAnswer: boolean } }).hostState.holdAnswer = true; });
        await card.getByRole("button", { name: "Send" }).click();
        await card.locator(".prompt-card-error", { hasText: "changed" }).waitFor();
        const typed = await posts("/api/machines/remote/host-chats/chat/answer");
        const uploaded = await posts("/api/machines/remote/host-chats/chat/upload");
        assert.deepEqual(uploaded.map((post) => [post.body["name"], post.body["media_type"]]), [["fictional-west.png", "image/png"], ["fictional-west.png", "image/png"]], "the card's file is uploaded on each try");
        assert.deepEqual(typed.map((post) => post.body), [{ session: SESSION, request_id: "req-1", question_id: "q-1", text: "@/tmp/fictional-repo/.herdr-web-ui/fictional-west.png FICTIONAL west", option_ids: [""] }], "a typed answer with a file posts \"@<path> <text>\" and the slot's id");
        await page.evaluate(() => { (window as unknown as { hostState: { holdAnswer: boolean } }).hostState.holdAnswer = false; });
        await card.getByRole("button", { name: /FICTIONAL south/ }).click();
        await card.waitFor({ state: "detached" });
        const answers = await posts("/api/machines/remote/host-chats/chat/answer");
        assert.deepEqual(answers.slice(1).map((post) => post.body), [{ session: SESSION, request_id: "req-1", question_id: "q-1", option_ids: ["opt-south"] }], "option 2 is answered by its host id, once");
        console.log("PASS the question card answers option 2 with its option id and goes away");

        // 4. model · effort and agent picks, then Send
        const modelPill = view.locator(".host-chat-model");
        await modelPill.waitFor();
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model A/);
        assert.equal(await modelPill.locator('svg[aria-label="claude"]').count(), 1, "the FICTIONAL Anthropic model wears the Claude mark");
        assert.equal(await modelPill.getAttribute("title"), "FICTIONAL Model A (Anthropic) · 200K", "the trigger's tooltip has the whole name and its context");
        assert.equal((await modelPill.locator(".host-chat-pill-label").textContent())?.trim(), "FICTIONAL Model A", "the trigger drops the provider the mark already says");
        await modelPill.click();
        const sheet = page.getByRole("dialog", { name: "Model", exact: true });
        await sheet.waitFor();
        await sheet.locator('[data-model="fictional/model-b"]').waitFor();
        assert.deepEqual(await sheet.getByRole("tab").allTextContents(), ["All", "Copilot", "fictional"], "a tab per group, Copilot first");
        assert.deepEqual(await sheet.locator(".host-picker-group").evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label"))),
          ["Copilot", "fictional · Anthropic", "fictional · FICTIONAL Go", "fictional"], "Copilot's own, then the router split by the vendor its names carry");
        assert.equal((await sheet.locator('[data-model="fictional-own"] .host-model-rate').textContent())?.trim(), "27x", "a Copilot model says its premium-request rate");
        assert.equal(await sheet.locator('[data-model="fictional-own"] [aria-label="FICTIONAL Own has a planned deprecation date."]').count(), 1, "and its deprecation notice");
        assert.equal((await sheet.locator('[data-model="fictional/model-a"] .host-model-name').textContent())?.trim(), "FICTIONAL Model A", "a row under its vendor drops the vendor from its name");
        if (shots) {
          await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
          await page.screenshot({ path: join(shots, "model-groups-390.png") });
        }
        await sheet.getByRole("searchbox", { name: "Search models" }).fill("glm");
        assert.deepEqual(await sheet.locator("[data-model]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model"))), ["fictional/glm-x"], "the search keeps the GLM row only");
        assert.equal(await sheet.locator('[data-model="fictional/glm-x"] svg[aria-label="zhipu"]').count(), 1, "GLM wears Zhipu's mark");
        await sheet.getByRole("searchbox", { name: "Search models" }).fill("");
        assert.match(await sheet.locator('[data-model="fictional/model-b"] .host-model-detail').textContent() ?? "", /^1M$/, "a row says its context");
        await sheet.locator('[data-model="fictional/model-b"] .host-model-pick').click();
        await sheet.waitFor({ state: "detached" });
        await modelPill.click();
        // the pick is Recent now, above All models
        const recent = sheet.getByRole("region", { name: "Recent" });
        assert.deepEqual(await recent.locator("[data-model]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model"))), ["fictional/model-b"], "the pick heads Recent");
        await recent.locator('[data-model="fictional/model-b"] button.host-model-detail').click();
        await sheet.locator('[data-effort="high"]').click();
        await sheet.waitFor({ state: "detached" });
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model B/, "the pill says the model");
        assert.equal((await modelPill.locator(".host-chat-pill-aside").textContent())?.trim(), "High", "and its effort beside the name");
        await view.locator(".host-chat-agent").click();
        const agents = page.getByRole("dialog", { name: "Agent", exact: true });
        await agents.waitFor();
        assert.equal(await agents.locator(".host-picker-option[data-agent]").first().textContent(), "Agent", '"Agent" comes first');
        await agents.getByText("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.", { exact: true }).waitFor();
        // the sheet slides up from the bottom edge: measured and drawn once it has settled
        await page.waitForFunction(() => {
          const surface = document.querySelector(".host-picker");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the open sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-5-sheet-390.png") });
        await agents.locator(`[data-agent="${REPORT}"]`).click();
        await agents.waitFor({ state: "detached" });
        // the chat's mode and permissions: a third pill, set once on the chat (session/config)
        const modePill = view.locator(".host-chat-mode");
        assert.equal(await modePill.getAttribute("title"), "Interactive · Manual", "the trigger's tooltip says the mode and the permissions");
        assert.equal(await modePill.getAttribute("aria-label"), "Pick Mode and Permissions, Interactive, Manual", "both are read out");
        await modePill.click();
        const modes = page.getByRole("dialog", { name: "Agent mode", exact: true });
        await modes.waitFor();
        await page.waitForFunction(() => {
          const surface = document.querySelector(".host-picker");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the open mode sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-9-mode-390.png") });
        await modes.locator('[data-mode="plan"]').click();
        await modes.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.querySelector(".host-chat-mode")?.getAttribute("title") === "Plan · Manual");
        assert.deepEqual((await posts("/api/machines/remote/host-chats/session/config")).map((post) => post.body), [{ session: SESSION, mode: "plan" }], "picking Plan posts the mode alone");
        console.log("PASS the model pill wears the Claude mark, search narrows to GLM, and Plan is the chat's mode");
        // Allow all at 390 px: the row fits before Send (no sideways scroll), the level is a shield glyph in the notice's color
        await modePill.click();
        const modes2 = page.getByRole("dialog", { name: "Agent mode", exact: true });
        await modes2.waitFor();
        await modes2.locator('[data-approvals="autoApprove"]').click();
        await modes2.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.querySelector(".host-chat-mode")?.getAttribute("data-approvals") === "autoApprove", undefined, { timeout: 10_000 })
          .catch(() => assert.fail("the mode pill shows Allow all"));
        const row = await view.locator(".composer-pickers").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        assert.ok(row.scroll <= row.client + 1, `the pickers fit before Send with Allow all (${row.scroll} > ${row.client})`);
        assert.equal(await modePill.locator(".host-chat-pill-shield").count(), 1, "a raised level wears a shield");
        await page.waitForFunction(() => document.querySelector(".modal-scrim, .host-picker") === null);
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        if (shots) await view.locator(".composer-surface").screenshot({ path: join(shots, "composer-allow-all-390.png") });
        await modePill.click();
        await modes2.waitFor();
        await modes2.locator('[data-approvals="default"]').click();
        await modes2.waitFor({ state: "detached" });
        console.log("PASS Allow all keeps the composer's pickers on one row before Send, as a shield");
        assert.match(await view.locator(".host-chat-agent").textContent() ?? "", /Report/);
        const drafts = await posts("/api/machines/remote/host-chats/chat/draft");
        assert.deepEqual(drafts.at(-1)?.body, { session: SESSION, model: { id: "fictional/model-b", effort: "high" } }, "the model pick is written to the chat's draft");
        const box = view.getByRole("textbox", { name: "Message" });
        await box.fill("FICTIONAL next");
        await view.getByRole("button", { name: "Send message" }).click();
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL next" }).waitFor();
        const sends = await posts("/api/machines/remote/host-chats/chat/send");
        assert.deepEqual(sends.map(bare), [{ session: SESSION, text: "FICTIONAL next", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT }], "the send carries the model, its effort and the agent, once");
        assert.equal(await box.inputValue(), "", "a sent message leaves the box");
        console.log("PASS the pills pick model-b · high and Report; the send carries both and the draft the model");

        // 4b. attachments are chips, VS Code's way: a PNG picked and a file taken with "@" go with the
        // message as attachments, and the text carries no @path
        await view.locator('.composer input[type="file"]').setInputFiles({ name: "fictional-shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
        const chips = view.locator(".composer-attachments .composer-attachment");
        await view.locator(".composer-attachment.is-ready img").waitFor();
        assert.equal(await box.inputValue(), "", "an uploaded file puts no @path in the box");
        await box.fill("FICTIONAL look @READ");
        await view.locator(".composer-menu").getByText("README.md").click();
        await page.waitForFunction(() => document.querySelectorAll(".composer-attachments .composer-attachment").length === 2);
        assert.equal(await box.inputValue(), "FICTIONAL look ", "an @ pick leaves the box and becomes a chip");
        assert.deepEqual(await chips.evaluateAll((nodes) => nodes.map((node) => node.querySelector("img") ? "image" : node.querySelector(".composer-attachment-file")?.textContent?.trim())), ["image", "README.md"], "a thumbnail chip, then the file's chip");
        await fits("the composer with chips");
        if (shots) await page.screenshot({ path: join(shots, "task-10-composer-chips-390.png") });
        await box.fill("FICTIONAL look");
        await view.getByRole("button", { name: "Send message" }).click();
        await page.waitForFunction(() => document.querySelectorAll(".composer-attachments .composer-attachment").length === 0);
        const withFiles = bare((await posts("/api/machines/remote/host-chats/chat/send")).at(-1));
        assert.deepEqual(withFiles, { session: SESSION, text: "FICTIONAL look", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT,
          attachments: [{ path: "/tmp/fictional-repo/.herdr-web-ui/fictional-shot.png", media_type: "image/png", name: "fictional-shot.png" }, { path: "README.md" }] }, "the send carries both chips as attachments");
        console.log("PASS a picked PNG and an @ file are chips and go as the message's attachments");

        // 5. a busy chat: VS Code's send menu. Send steers by default, a second steer joins the first,
        // Add to Queue waits for the turn, and Stop and Send ends the turn and sends
        await page.evaluate(() => (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(true));
        assert.equal(await view.locator(".composer-send-menu").count(), 0, "no send menu while the box is empty");
        await box.fill("FICTIONAL steer one");
        await view.locator(".composer-send-menu").waitFor();
        await view.getByRole("button", { name: "Send message" }).click();
        const steering = view.locator('.host-pending-group[data-kind="steering"]');
        await steering.locator(".host-pending-divider", { hasText: "Steering" }).waitFor();
        await steering.locator(".host-pending-row", { hasText: "FICTIONAL steer one" }).waitFor();
        assert.equal(await box.inputValue(), "", "a steer leaves the box");
        const steered = await posts("/api/machines/remote/host-chats/chat/send");
        assert.deepEqual(bare(steered.at(-1)), { session: SESSION, text: "FICTIONAL steer one", mode: "steer", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT }, "Send on a busy chat steers, with the pills' model and agent");
        console.log("PASS a send while busy steers by default, and the Steering row shows");
        await box.fill("FICTIONAL steer two");
        await box.press("Enter");
        await view.locator(".host-pending-note", { hasText: "Added to your steer" }).waitFor();
        assert.equal(await steering.locator(".host-pending-row").count(), 1, "one steering row");
        assert.match(await steering.locator(".host-pending-text").textContent() ?? "", /FICTIONAL steer one\s+FICTIONAL steer two/, "holding both texts in order");
        console.log("PASS a second steer says it was added to your steer, one row holding both");
        await box.fill("FICTIONAL later");
        await view.locator(".composer-send-menu").click();
        // at 390 px the menu is the app's bottom sheet (RowMenu)
        const menu = page.getByRole("dialog", { name: "Send", exact: true });
        await menu.waitFor();
        assert.deepEqual((await menu.locator(".row-sheet-item").allInnerTexts()).map((text) => text.trim()), ["Stop and Send", "Add to Queue", "Steer with Message"], "VS Code's menu, in its order");
        assert.equal(await menu.locator('.row-sheet-item[aria-current="true"]').innerText().then((text) => text.trim()), "Steer with Message", "the default (steer) is marked");
        await fits("the open send menu");
        if (shots) await page.screenshot({ path: join(shots, "task-8-send-menu-390.png") });
        await menu.getByRole("button", { name: "Add to Queue" }).click();
        const queuedRows = view.locator('.host-pending-group[data-kind="queued"]');
        await queuedRows.locator(".host-pending-row", { hasText: "FICTIONAL later" }).waitFor();
        await queuedRows.locator(".host-pending-divider", { hasText: "Queued" }).waitFor();
        assert.equal((await modelPill.locator(".host-chat-pill-aside").textContent())?.trim(), "High", "the pills still show model-b · high after the send");
        assert.match(await view.locator(".host-chat-agent").textContent() ?? "", /Report/, "and Report");
        assert.deepEqual(bare((await posts("/api/machines/remote/host-chats/chat/send")).at(-1)), { session: SESSION, text: "FICTIONAL later", mode: "queue", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT }, "Add to Queue posts mode queue with the pills' model and agent");
        await menu.waitFor({ state: "detached" });
        if (shots) await page.screenshot({ path: join(shots, "task-8-pending-390.png"), style: ".droplet, .droplet-stack { display: none !important; }" });
        console.log("PASS Add to Queue adds a Queued row");
        await queuedRows.getByRole("button", { name: "Remove from Queue" }).click();
        await queuedRows.waitFor({ state: "detached" });
        assert.deepEqual((await posts("/api/machines/remote/host-chats/chat/pending/remove")).map((post) => post.body["session"]), [SESSION], "the row's remove posts once");
        console.log("PASS a pending row's remove takes it off");

        // 5a. background work while busy: VS Code's words, then the meter's breakdown
        await page.evaluate(() => {
          const host = window as unknown as { hostState: { background: { subagents: number; commands: number } }; setHostBusy(busy: boolean): void };
          host.hostState.background = { subagents: 2, commands: 1 };
          host.setHostBusy(true);
        });
        const line = view.locator(".host-chat-status-line", { hasText: "2 subagents and 1 background command running" });
        await line.waitFor();
        assert.equal(await line.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "the line is whole at 390 px");
        await view.locator(".host-chat-meter").click();
        const contextSheet = page.getByRole("dialog", { name: "Context window" });
        await contextSheet.waitFor();
        assert.deepEqual((await contextSheet.locator("dt").allInnerTexts()).map((text) => text.trim()), ["Conversation", "System", "Tool definitions", "Used"], "the breakdown the host sent");
        assert.match(await contextSheet.locator(".is-total dd").innerText(), /84,000 of 200,000/);
        await fits("the context sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-12-context-390.png") });
        await contextSheet.getByRole("button", { name: "Close" }).click();
        await contextSheet.waitFor({ state: "detached" });
        await page.evaluate(() => { (window as unknown as { hostState: { background: unknown } }).hostState.background = { subagents: 0, commands: 0 }; });
        if (shots) {
          await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLElement && node.inert && node.shadowRoot === null && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
          await page.screenshot({ path: join(shots, "task-12-status-390.png") });
        }
        console.log("PASS background work reads as VS Code says it, and the meter opens the context breakdown");

        // 5b. a send whose answer is lost (502): it says to send again, and the retry goes under the same id
        const before = (await posts("/api/machines/remote/host-chats/chat/send")).length;
        await page.evaluate(() => { (window as unknown as { hostState: { failNextSend: boolean } }).hostState.failNextSend = true; });
        await box.fill("FICTIONAL maybe");
        await view.getByRole("button", { name: "Send message" }).click();
        await view.getByRole("alert").filter({ hasText: "Couldn't confirm it was sent. Send again: it won't go twice." }).waitFor();
        assert.equal(await box.inputValue(), "FICTIONAL maybe", "the words stay in the box");
        await view.getByRole("button", { name: "Send message" }).click();
        await page.waitForFunction((count) => (window as unknown as { hostCalls: { posts: { path: string }[] } }).hostCalls.posts.filter((post) => post.path.endsWith("/chat/send")).length >= count + 2, before);
        const retried = (await posts("/api/machines/remote/host-chats/chat/send")).slice(before);
        assert.equal(retried.length, 2);
        assert.match(String(retried[0]!.body["id"]), UUID);
        assert.equal(retried[1]!.body["id"], retried[0]!.body["id"], "the retry of the same words reuses the id");
        assert.notEqual(retried[0]!.body["id"], (await posts("/api/machines/remote/host-chats/chat/send"))[before - 1]!.body["id"], "a new message has a new id");
        console.log("PASS a send whose answer was lost says to send again, and the retry reuses its id");

        // 5c. Stop and Send: the turn is cancelled and the text starts the next one
        await box.fill("FICTIONAL instead");
        await view.locator(".composer-send-menu").click();
        await page.getByRole("dialog", { name: "Send", exact: true }).getByRole("button", { name: "Stop and Send" }).click();
        await page.getByRole("dialog", { name: "Send", exact: true }).waitFor({ state: "detached", timeout: 5000 });
        // the chat follows to the turn just sent: it is in view, with no New messages jump to press
        const sentTurn = view.locator(".chat-turn-user", { hasText: "FICTIONAL instead" });
        await sentTurn.waitFor({ state: "attached" });
        await page.waitForFunction(() => {
          const turns = [...document.querySelectorAll(".host-chat .chat-turn-user")].filter((node) => node.textContent?.includes("FICTIONAL instead"));
          const scroller = document.querySelector(".host-chat .chat-view");
          if (turns.length === 0 || scroller === null) return false;
          const box = turns[0]!.getBoundingClientRect(), view = scroller.getBoundingClientRect();
          return box.bottom > view.top && box.top < view.bottom;
        }, undefined, { timeout: 5000 }).catch(() => assert.fail("the chat did not follow to the turn just sent"));
        assert.equal(await view.locator(".chat-new-messages").count(), 0, "no New messages jump after the user's own send");
        assert.equal((await posts("/api/machines/remote/host-chats/chat/send")).at(-1)?.body["mode"], "stop_and_send", "Stop and Send posts its mode");
        console.log("PASS Stop and Send cancels, then sends");

        // 5d. "/" and "@": VS Code's config commands, then the host's; /plan sets Plan and sends the rest
        // back to Interactive (as if set in VS Code), so /plan has something to change; the turn ends
        await page.evaluate(() => { (window as unknown as { hostState: { mode: string } }).hostState.mode = "interactive"; });
        await page.evaluate(() => (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(false));
        await page.waitForFunction(() => document.querySelector(".host-chat-mode")?.getAttribute("title")?.startsWith("Interactive"));
        const slashConfigsBefore = (await posts("/api/machines/remote/host-chats/session/config")).length;
        const slashSendsBefore = (await posts("/api/machines/remote/host-chats/chat/send")).length;
        await box.fill("/");
        const slashMenu = view.locator(".composer-menu");
        await slashMenu.waitFor();
        const labels = (await slashMenu.locator(".menu-item-main").allInnerTexts()).map((text) => text.trim());
        assert.ok(labels.some((label) => label.startsWith("/plan")), "the menu offers /plan");
        assert.ok(labels.includes("/fictional-skill"), "and the host's skill");
        assert.ok(labels.indexOf("/fictional-skill") > labels.findIndex((label) => label.startsWith("/plan")), "the config commands come first");
        await slashMenu.getByText("Create an implementation plan before coding").first().waitFor();
        await fits("the / menu");
        // the pills say their words: none is cut at 390 px (the old status slot squeezed them to "FICTION…", "R…", "In…")
        const cut = await view.locator(".host-chat-pill-label, .host-chat-pill-aside").evaluateAll((spans) => spans.filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent));
        assert.deepEqual(cut, [], "no pill's words are cut");
        assert.equal(await view.locator(".composer-pickers").evaluate((row) => row.scrollWidth <= row.clientWidth + 1), true, "the pickers fit the row at 390 px: nothing scrolls out of sight");
        // a closed sheet slides out as a copy in an inert shadow host at the end of <body> (lib/sheets.ts leave): the picture waits for it to go
        await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLElement && node.inert && node.shadowRoot === null && node.getAttribute("aria-hidden") === "true" && node.childElementCount === 0));
        if (shots) await page.screenshot({ path: join(shots, "task-9b-slash-390.png"), style: ".droplet, .droplet-stack { display: none !important; }" });
        if (shots) await view.locator(".composer-surface").screenshot({ path: join(shots, "task-9c-composer-390.png") });
        // a desktop window: the same row with room, every word and caret shown
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".host-chat-mode .host-chat-pill-label")!).display !== "none");
        if (shots) await view.locator(".composer-surface").screenshot({ path: join(shots, "task-9c-composer-1280.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await box.fill("/plan FICTIONAL task");
        await box.press("Escape");
        await view.getByRole("button", { name: "Send message" }).click();
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL task" }).waitFor({ state: "attached" });
        await page.waitForFunction(() => document.querySelector(".host-chat-mode")?.getAttribute("title")?.startsWith("Plan"));
        const configs = (await posts("/api/machines/remote/host-chats/session/config")).slice(slashConfigsBefore);
        assert.deepEqual(configs.map((post) => post.body), [{ session: SESSION, mode: "plan" }], "/plan sets the mode, once");
        assert.deepEqual((await posts("/api/machines/remote/host-chats/chat/send")).slice(slashSendsBefore).map((post) => post.body["text"]), ["FICTIONAL task"], "and the rest is the message, once");
        console.log("PASS / offers /plan and the host's skill; /plan FICTIONAL task turns the pill to Plan and sends FICTIONAL task");
        await box.fill("look at @build");
        await view.locator(".composer-menu").getByText("src/fictional-build.ts").waitFor();
        await box.fill("");
        console.log("PASS @ lists a file of the chat's folder");
        assert.equal(await view.locator(".composer .voice-mic").count(), 1, "the mic button is there");
        console.log("PASS the mic button is present");

        // 6. nothing wider than the phone
        await fits("the busy chat");
        console.log("PASS no horizontal overflow at 390 px");

        // 6b. the folder row opens its chat, whose tab is the folder's; a read that fails says the bridge's words, not the request's URL
        // it finished while nobody looked: unread, and opening it reads it (as VS Code does)
        await page.evaluate(() => { (window as unknown as { hostEdits: { unread: Record<string, boolean> } }).hostEdits.unread["fictional-session-0"] = true; (window as unknown as { pushHostList(): void }).pushHostList(); });
        await page.locator('.agents-sidebar [data-host-session="fictional-session-0"]').waitFor({ state: "attached" });
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await folderRow.locator(".workspace-select").click();
        await page.waitForFunction(() => (window as unknown as { hostCalls: { posts: { path: string; body: { session?: string; read?: boolean } }[] } }).hostCalls.posts
          .some((post) => post.path.endsWith("/chat/read") && post.body.session === "fictional-session-0" && post.body.read === true));
        const down = page.locator('.host-chat[data-host-session="fictional-session-0"]');
        await down.locator(".chat-inline-error").waitFor();
        // the app's failure line, as for any chat; the bridge's own words are its detail, and no URL or status shows anywhere
        assert.equal(await down.locator(".chat-failure-line").textContent(), "Couldn't load the conversation", "the read's failure line");
        assert.equal(await down.locator(".chat-failure-details code").textContent(), "FICTIONAL the agent host is down", "the bridge's detail");
        assert.doesNotMatch(await down.locator(".chat-inline-error").textContent() ?? "", /\/api\/|\b50\d\b|host-chats\//, "no URL or status in the error");
        assert.equal(await page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-session-0"] [role="tab"]').getAttribute("aria-selected"), "true", "the folder row's chat is its tab");
        assert.equal((await posts("/api/machines/remote/host-chats/chat/read")).filter((post) => post.body["session"] === "fictional-session-0").length, 1, "read once on opening");
        console.log("PASS a folder row opens its unread chat as its tab and marks it read; a read that fails says the bridge's own words");

        // 6c. "All agents on Build PC…", from the Agents head's ⋯ (a PC row has no ⋯): search finds the
        // month-old chat, Archived waits folded, and opening one makes it a tab of its workspace
        const agentsMenu = async () => {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.locator(".agents-sidebar").getByRole("button", { name: "More for Agents", exact: true }).click();
        };
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        assert.equal(await remoteGroup.locator(".machine-header").getByRole("button", { name: "More for Build PC" }).count(), 0, "a PC row keeps sliders, fold and + only");
        await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        const all = page.getByRole("dialog", { name: "All agents on Build PC", exact: true });
        await all.waitFor();
        assert.equal(await all.getByRole("button", { name: "Archived" }).getAttribute("aria-expanded"), "false", "Archived starts folded");
        assert.equal(await all.locator('[data-host-session="fictional-session-done"]').count(), 0, "an archived chat waits under the fold");
        assert.ok((await all.locator('[data-host-session="fictional-session-old"]').innerText()).includes("20 days ago"), "relative time");
        await page.waitForFunction(() => {
          const surface = document.querySelector(".all-agents");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the All agents sheet");
        await noVsCode("the All agents sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-6-all-agents-390.png") });
        await all.getByRole("searchbox", { name: "Search agents" }).fill("release notes");
        assert.equal(await all.locator(".host-chat-item").count(), 1, "the search keeps the one it finds");
        await all.locator('[data-host-session="fictional-session-old"] .agent-select').click();
        await all.waitFor({ state: "detached" });
        await page.locator('.host-chat[data-host-session="fictional-session-old"]').waitFor();
        await page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-session-old"]').waitFor();
        // its pills read its models: settled before the new-chat sheet counts its own reads
        await page.waitForFunction(() => (window as unknown as { hostCalls: { models: string[] } }).hostCalls.models.includes("fictional-session-old"));
        console.log("PASS All agents on Build PC… finds an old chat by search and opens it as a tab of its workspace");

        // 7. the PC's "+" with Copilot (host) picked: a folder chip, a model, a mode, the first message, Start
        const newChats = () => posts("/api/machines/remote/host-chats/chat/new");
        const openNewSheet = async () => {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await remoteGroup.getByRole("button", { name: "New workspace on Build PC", exact: true }).click();
          const form = page.getByRole("dialog", { name: "New workspace · Build PC" });
          await form.waitFor();
          // the PC's agents come in a moment after the dialog opens; the picker remembers the last one
          const pick = form.locator(".agent-picker-trigger");
          if (!(await pick.innerText()).includes("Copilot (host)")) {
            await pick.click();
            await page.getByRole("option", { name: "Copilot (host)" }).click({ timeout: 10_000 });
          }
          return form;
        };
        // the models and agents are a session's: the newest chat in the folder picked, else the PC's newest
        const modelReads = async (): Promise<string[]> => page.evaluate(() => [...(window as unknown as { hostCalls: { models: string[] } }).hostCalls.models]);
        const nextModelRead = async (after: number, what: string): Promise<string | undefined> => {
          await page.waitForFunction((count) => (window as unknown as { hostCalls: { models: string[] } }).hostCalls.models.length > count, after, { timeout: 10_000 })
            .catch(() => assert.fail(`${what}: the dialog read no models after the folder changed`));
          return (await modelReads())[after];
        };
        const readsBefore = (await modelReads()).length;
        let form = await openNewSheet();
        const agentPick = form.locator(".agent-picker-trigger, [aria-labelledby=\"new-session-agent\"]").first();
        // the PC's agents come in a moment after the dialog opens
        await agentPick.filter({ hasText: "Copilot (host)" }).waitFor({ timeout: 10_000 }).catch(async () => assert.fail(`the dialog opens on Copilot (host), not ${await agentPick.innerText()}`));
        assert.equal(await form.getByRole("textbox", { name: "Name" }).count(), 0, "a host chat has a first message, not a name");
        const folder = form.getByRole("textbox", { name: "Directory" });
        await folder.fill("/tmp/fictional-repo");
        assert.equal(await nextModelRead(readsBefore, "the opened dialog"), SESSION, "the pickers read the newest chat in /tmp/fictional-repo");
        // another folder: its own newest chat, not the PC's newest; the PC's chats' folders are chips
        await form.getByRole("button", { name: "Use folder /tmp/fictional-docs", exact: true }).click();
        assert.equal(await folder.inputValue(), "/tmp/fictional-docs", "the chip fills the folder");
        assert.equal(await nextModelRead(readsBefore + 1, "/tmp/fictional-docs"), "fictional-session-0", "the pickers read the newest chat in /tmp/fictional-docs");
        await form.getByRole("button", { name: "Use folder /tmp/fictional-repo", exact: true }).click();
        assert.equal(await nextModelRead(readsBefore + 2, "/tmp/fictional-repo"), SESSION, "back in /tmp/fictional-repo, its newest chat's models");
        await form.locator(".host-chat-model").click();
        const picker = page.getByRole("dialog", { name: "Model", exact: true });
        await picker.locator('[data-model="fictional/model-a"] .host-model-pick').click();
        await picker.waitFor({ state: "detached" });
        assert.match(await form.locator(".host-chat-model").textContent() ?? "", /FICTIONAL Model A/);
        await form.locator(".host-chat-mode").click();
        const modePicker = page.getByRole("dialog", { name: "Agent mode", exact: true });
        await modePicker.locator('[data-mode="plan"]').click();
        await modePicker.waitFor({ state: "detached" });
        assert.match(await form.locator(".host-chat-mode").textContent() ?? "", /Plan/);
        await form.getByRole("textbox", { name: "First message" }).fill("FICTIONAL first");
        await page.waitForFunction(() => {
          const surface = document.querySelector(".new-session-modal");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the new-chat dialog");
        if (shots) await page.screenshot({ path: join(shots, "task-11-new-chat-390.png") });
        const configsBefore = (await posts("/api/machines/remote/host-chats/session/config")).length;
        await form.getByRole("button", { name: "Start", exact: true }).click();
        const made = page.locator('.host-chat[data-host-session="fictional-new-1"]');
        await made.waitFor();
        await made.locator(".chat-turn-user", { hasText: "FICTIONAL first" }).waitFor();
        assert.equal(await form.count(), 0, "the dialog closes on the chat made");
        assert.deepEqual((await newChats()).map(bare), [{ cwd: "/tmp/fictional-repo", text: "FICTIONAL first", model: { id: "fictional/model-a" } }], "one chat/new with the folder, the text and the model");
        assert.deepEqual((await posts("/api/machines/remote/host-chats/session/config")).slice(configsBefore).map((post) => post.body), [{ session: "fictional-new-1", mode: "plan" }], "the mode is set on the chat made");
        // the header names the chat: Copilot's mark, its title, PC › folder, Chat pressed, Terminal off
        const header = page.locator(".app-header");
        await header.locator(".context-title-text", { hasText: "FICTIONAL new chat" }).waitFor();
        assert.equal(await header.locator('.context-title svg[aria-label="copilot"]').count(), 1, "the header wears Copilot's mark");
        assert.deepEqual((await header.locator(".context-sub > span").allInnerTexts()).map((text) => text.trim()).filter((text) => text !== "›"), ["Build PC", "fictional-repo"], "the crumb is PC › folder");
        const terminalButton = header.getByRole("button", { name: "Terminal" });
        assert.equal(await terminalButton.getAttribute("aria-disabled"), "true", "Terminal is disabled");
        await terminalButton.click({ force: true });
        assert.equal(await terminalButton.getAttribute("aria-pressed"), "false", "and pressing it changes nothing");
        assert.equal(await page.locator('.host-chat[data-host-session="fictional-new-1"]').count(), 1, "the chat stays");
        assert.equal(await terminalButton.getAttribute("title"), "This chat has no terminal");
        assert.equal(await header.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed"), "true", "Chat is pressed");
        await header.locator(".conn.conn-live").waitFor({ state: "attached" });
        assert.equal(await page.locator(".host-chat-title").count(), 0, "the title is the header's alone: no second title bar over the chat");
        if (shots) await page.screenshot({ path: join(shots, "task-11-header-390.png") });
        console.log("PASS the PC's + on Copilot (host): one chat/new, the mode set, and the header names the chat");

        // 7b. made, but its first message did not go: the chat opens with the words in its box, nothing re-sent
        await page.evaluate(() => { (window as unknown as { hostState: { newSent: boolean } }).hostState.newSent = false; });
        const sendsBefore = (await posts("/api/machines/remote/host-chats/chat/send")).length;
        form = await openNewSheet();
        await form.getByRole("textbox", { name: "Directory" }).fill("/tmp/fictional-repo");
        await form.getByRole("textbox", { name: "First message" }).fill("FICTIONAL kept");
        await form.getByRole("button", { name: "Start", exact: true }).click();
        const kept = page.locator('.host-chat[data-host-session="fictional-new-2"]');
        await kept.waitFor();
        assert.equal(await kept.getByRole("textbox", { name: "Message" }).inputValue(), "FICTIONAL kept", "the unsent first message waits in the composer");
        // an empty chat greets with Copilot's mark, never VS Code's
        await kept.locator(".chat-empty").waitFor();
        assert.equal(await kept.locator('.chat-empty svg[aria-label="copilot"]').count(), 1, "the empty chat wears Copilot's mark");
        assert.equal(await page.locator('svg[aria-label="vscode"]').count(), 0, "no VS Code mark anywhere");
        assert.equal((await newChats()).length, 2, "exactly one chat/new for this tap: no second chat");
        assert.equal((await posts("/api/machines/remote/host-chats/chat/send")).length, sendsBefore, "nothing is sent on the user's behalf");
        await fits("the chat made unsent");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS a chat made with its first message unsent opens with the words in its composer, once");

        // 7c. a chat's own actions (Task 7): rename from its tab's menu and the header's ⋯, mark it
        // unread (and a refusal undone), mark it done, delete it; a pane's tab keeps its own menu
        const keptTab = page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-new-2"]');
        const actionPosts = async (route: string) => (await posts(`/api/machines/remote/host-chats/chat/${route}`)).map((post) => post.body);
        const sheetItems = async () => (await page.locator(".row-sheet .row-sheet-item").allInnerTexts()).map((text) => text.trim());
        // a pane's tab: the menu it always had, none of a chat's items
        // the list's push carries the chats made, so they stand as tabs of their workspace; the drawer and sheet have gone
        await page.evaluate(() => (window as unknown as { pushHostList(): void }).pushHostList());
        await keptTab.waitFor();
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null && document.querySelector(".new-session-modal") === null);
        await page.waitForTimeout(400);
        await page.locator('.tab-strip-item:not(.host-chat-tab) [role="tab"]').first().click({ button: "right" });
        await page.locator(".row-sheet").waitFor();
        const paneItems = await sheetItems();
        for (const item of ["Rename…", "Mark as done", "Mark as read", "Mark as unread", "Delete…"]) assert.ok(!paneItems.includes(item), `a pane's tab menu has no "${item}"`);
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        // the open chat's tab: ⋯ opens the chat's menu
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL new chat" }).click();
        await page.locator(".row-sheet").waitFor();
        assert.deepEqual(await sheetItems(), ["Pin agent", "Rename…", "Mark as unread", "Mark as done", "Delete…"], "the chat's menu: pin, rename, unread, done, delete");
        await page.waitForFunction(() => document.querySelector(".row-sheet")?.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running") ?? false);
        await fits("the chat tab's menu");
        await noVsCode("the chat tab's menu");
        if (shots) await page.screenshot({ path: join(shots, "task-7-tab-menu-390.png") });
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Rename…" }).click();
        const nameField = keptTab.getByRole("textbox", { name: "Chat name" });
        await nameField.waitFor();
        await nameField.fill("   ");
        await nameField.press("Enter");
        await keptTab.locator(".tab-strip-error", { hasText: "A chat needs a name." }).waitFor();
        await nameField.fill("FICTIONAL renamed chat");
        await nameField.press("Enter");
        await keptTab.locator(".tab-strip-label", { hasText: "FICTIONAL renamed chat" }).waitFor();
        await page.locator(".app-header .context-title-text", { hasText: "FICTIONAL renamed chat" }).waitFor();
        assert.deepEqual(await actionPosts("rename"), [{ session: "fictional-new-2", title: "FICTIONAL renamed chat" }], "one rename, trimmed, never the empty one");
        // the header's ⋯: Rename chat… in the sheet, the same route
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Rename chat…" }).click();
        const renameSheet = page.getByRole("dialog", { name: "Rename chat" });
        await renameSheet.getByRole("textbox", { name: "Chat name" }).fill("FICTIONAL named in the header");
        await renameSheet.getByRole("button", { name: "Save", exact: true }).click();
        await renameSheet.waitFor({ state: "detached" });
        await keptTab.locator(".tab-strip-label", { hasText: "FICTIONAL named in the header" }).waitFor();
        await page.locator(".app-header .context-title-text", { hasText: "FICTIONAL named in the header" }).waitFor();
        assert.equal((await actionPosts("rename")).length, 2, "the header's rename went too");
        console.log("PASS rename from the tab's menu and the header's ⋯: the new title on the tab and over the chat");

        // read and unread: shown at once; a refusal puts it back and says so
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL named in the header" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Mark as unread" }).click();
        await keptTab.locator('.tab-strip-dot[data-status="done"]').waitFor();
        assert.deepEqual((await actionPosts("read")).filter((body) => body["session"] === "fictional-new-2"), [{ session: "fictional-new-2", read: false }], "marked unread, and kept so while open");
        await page.evaluate(() => { (window as unknown as { hostEdits: { failRead: boolean } }).hostEdits.failRead = true; });
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL named in the header" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Mark as read" }).click();
        await page.locator(".pane-notice", { hasText: "Mark as read failed: FICTIONAL the host said no" }).waitFor();
        await keptTab.locator('.tab-strip-dot[data-status="done"]').waitFor();
        await page.evaluate(() => { (window as unknown as { hostEdits: { failRead: boolean } }).hostEdits.failRead = false; });
        console.log("PASS mark as unread shows at once; a refused mark as read is put back and said");

        // mark as done: its tab goes, the chat is let go, and All agents lists it under Archived
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL named in the header" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Mark as done" }).click();
        await keptTab.waitFor({ state: "detached" });
        await kept.waitFor({ state: "detached" });
        assert.deepEqual(await actionPosts("archive"), [{ session: "fictional-new-2", archived: true }]);
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        await all.waitFor();
        await all.getByRole("button", { name: "Archived" }).click();
        const archivedRow = all.getByRole("region", { name: "Archived" }).locator('[data-host-session="fictional-new-2"]');
        await archivedRow.waitFor();
        await archivedRow.getByRole("button", { name: "More for FICTIONAL named in the header" }).click();
        assert.ok((await sheetItems()).includes("Restore"), "an archived chat's menu offers Restore");
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        console.log("PASS mark as done: the tab goes and the chat waits under Archived in All agents");

        // delete: the confirm names the chat (the one place the product's name is said); it goes everywhere
        const madeRow = all.locator('.host-chat-item[data-host-session="fictional-new-1"]');
        await madeRow.getByRole("button", { name: "More for FICTIONAL new chat" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Delete…" }).click();
        const confirmDelete = page.getByRole("alertdialog", { name: "Delete “FICTIONAL new chat”?" });
        await confirmDelete.waitFor();
        assert.equal((await confirmDelete.locator(".confirm-body").innerText()).trim(), "This removes it from VS Code too.");
        await page.waitForFunction(() => document.querySelector(".confirm-dialog")?.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running") ?? false);
        await fits("the delete confirm");
        if (shots) await page.screenshot({ path: join(shots, "task-7-delete-confirm-390.png") });
        await confirmDelete.getByRole("button", { name: "Delete", exact: true }).click();
        await confirmDelete.waitFor({ state: "detached" });
        await madeRow.waitFor({ state: "detached" });
        assert.deepEqual(await actionPosts("delete"), [{ session: "fictional-new-1" }], "one delete");
        await page.keyboard.press("Escape");
        await all.waitFor({ state: "detached" });
        assert.equal(await page.locator('[data-host-session="fictional-new-1"]').count(), 0, "the deleted chat is gone from every surface");
        await noVsCode("after the delete");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS delete asks, naming the chat, and the chat is gone");

        // 8. six PCs: five fold under "Other PCs (5)"; the one whose chat asks stays open outside it
      } finally { await context.close(); }
      // a fresh device: the PC in use is the first, and the fold has never been opened
      const sixContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await sixContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const errors: string[] = [];
        const fits = async (what: string) => {
          const width = await six.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(width <= 390, `${what}: no horizontal overflow at 390 px (scrollWidth ${width})`);
        };
        const six = await sixContext.newPage();
        six.on("pageerror", (error) => errors.push(error.message));
        await six.goto(`http://127.0.0.1:${server.port}/?pcs=6`);
        await six.locator(".conn-live").waitFor({ state: "attached" });
        await six.getByRole("button", { name: "Open workspace list", exact: true }).click();
        const fold = six.getByRole("region", { name: "Other PCs", exact: true });
        await fold.getByRole("button", { name: /^Other PCs \(5\)/ }).waitFor();
        assert.equal(await six.locator(".machine-group").count(), 1, "only the PC in use is a full group");
        if (shots) await six.screenshot({ path: join(shots, "task-6-other-pcs-closed-390.png") });
        // a question waits on FICTIONAL PC E: it opens outside the fold, until it no longer needs you
        await six.evaluate(() => (window as unknown as { askOnPcE(): void }).askOnPcE());
        const asking = six.getByRole("region", { name: "PC FICTIONAL PC E", exact: true });
        await asking.waitFor();
        await fold.getByRole("button", { name: /^Other PCs \(4\)/ }).waitFor();
        assert.equal(await six.locator(".machine-group").count(), 2, "the PC in use and the one that needs you are open");
        assert.equal(await six.getByRole("region", { name: "PC Laptop", exact: true }).count(), 1, "the PC in use is open");
        const toggle = fold.locator(".other-pcs-toggle");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false", "the fold starts closed");
        await toggle.click();
        assert.deepEqual(await fold.locator(".other-pcs-name").allInnerTexts(), ["Build PC", "FICTIONAL PC C", "FICTIONAL PC D", "FICTIONAL PC F"], "each folded PC is a one-line row");
        await fits("the Other PCs fold");
        await six.evaluate(() => document.querySelector(".other-pcs")?.scrollIntoView({ block: "center" }));
        if (shots) await six.screenshot({ path: join(shots, "task-6-other-pcs-390.png") });
        await six.reload();
        await six.locator(".conn-live").waitFor({ state: "attached" });
        await six.getByRole("button", { name: "Open workspace list", exact: true }).click();
        assert.equal(await six.getByRole("region", { name: "Other PCs", exact: true }).locator(".other-pcs-toggle").getAttribute("aria-expanded"), "true", "the fold's open state is kept on this device");
        // a PC picked from the fold opens as a full group
        await six.getByRole("region", { name: "Other PCs", exact: true }).locator('.other-pcs-item[data-machine="pc-c"] .other-pcs-row').click();
        await six.getByRole("region", { name: "PC FICTIONAL PC C", exact: true }).waitFor();
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS six PCs: Other PCs folds the ones not in use, the one that needs you stays open, and the fold is remembered");
      } finally { await sixContext.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
