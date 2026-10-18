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
  const state = window.hostState = { answered: false, busy: false, model: { id: "fictional/model-a", effort: null }, agent: null, sent: [], created: [], newSent: true, failNextSend: false, older: false, pushed: [] };
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
      return { session, title: "FICTIONAL new chat", status: "idle", turns, cursor: null, prompt: null, model: null, agent: null, busy: false, message_ids: made.sent ? ["new-1"] : [], signature: JSON.stringify(made) };
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
        { kind: "text", text: "FICTIONAL the build passes." },
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
      body: "FICTIONAL see the \`map\` first", options: [{ label: "FICTIONAL north", description: null }, { label: "FICTIONAL south", description: null }, { label: "FICTIONAL east", description: "FICTIONAL **plain** here" }, { label: "Other…", description: null }],
      multi_select: false, custom_option_index: 3,
      host: { request_id: "req-1", question_id: "q-1", option_ids: ["opt-north", "opt-south", "opt-east", ""] },
    };
    return { session: SESSION, title: "FICTIONAL build chat", status: prompt ? "asks" : state.busy ? "working" : "idle", turns, cursor: state.older ? null : "c-older", prompt,
      model: state.model, agent: state.agent, busy: state.busy || prompt !== null, message_ids: ids,
      signature: JSON.stringify([state.answered, state.busy, state.sent, state.model, state.agent, state.older, state.pushed]) };
  };
  const push = (message) => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote", message }) }));
  };
  // the six-PC fixture: FICTIONAL PC E's chat starts asking, and its push says so
  window.askOnPcE = () => {
    state.peAsks = true;
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "pc-e", message: { type: "host-chat-changed", session: null } }) }));
  };
  window.setHostBusy = (busy) => { state.busy = busy; push({ type: "host-chat-changed", session: SESSION }); };
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
      if (path === "/api/host-chats/state") return json({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
      if (path === "/api/host-chats/chats") return json({ chats: [
        { session: SESSION, title: "FICTIONAL build chat", status: SIX || state.answered ? (state.busy ? "working" : "idle") : "asks", modified_at: at(2), cwd: "/tmp/fictional-repo", unread: false, archived: false },
        { session: "fictional-session-0", title: "FICTIONAL docs chat", status: "idle", modified_at: at(60 * 30), cwd: "/tmp/fictional-docs", unread: false, archived: false },
        // 20 days old: only "All agents on Build PC…" lists it
        { session: "fictional-session-old", title: "FICTIONAL old release notes", status: "idle", modified_at: at(60 * 24 * 20), cwd: "/tmp/fictional-repo", unread: false, archived: false },
        { session: "fictional-session-done", title: "FICTIONAL archived chat", status: "idle", modified_at: at(60 * 24 * 2), cwd: "/tmp/fictional-repo", unread: false, archived: true },
        ...state.created.map((chat) => ({ session: chat.session, title: "FICTIONAL new chat", status: "idle", modified_at: at(0), cwd: chat.cwd, unread: false, archived: false })),
      ] });
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
          { id: "fictional-own", name: "FICTIONAL Own", provider: "copilotcli", efforts: null, context: null },
          { id: "fictional/model-a", name: "FICTIONAL Model A", provider: "copilotcli", efforts: null, context: null },
          { id: "fictional/model-b", name: "FICTIONAL Model B", provider: "copilotcli", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] }, context: null },
        ],
        agents: [{ uri: REPORT, name: "Report", description: "FICTIONAL writes a report" }],
      });
      if (path === "/api/host-chats/chat/watch" || path === "/api/host-chats/chat/draft" || path === "/api/host-chats/chat/confirm") return json({ ok: true });
      if (path === "/api/host-chats/chat/answer") { if (state.holdAnswer) return json({ error: { code: "prompt_changed", message: "FICTIONAL changed" } }, 409); state.answered = true; return json({ ok: true }); }
      if (path === "/api/host-chats/chat/send") {
        // the proxy's 502 after the bridge got it: the message went, the answer did not
        const lost = state.failNextSend;
        state.failNextSend = false;
        const queued = state.busy;
        state.sent.push(body.text);
        if (body.model) state.model = { id: body.model.id, effort: body.model.effort ?? null };
        if ("agent" in body) state.agent = body.agent;
        if (lost) return json({ error: { code: "bad_gateway", message: "FICTIONAL proxy" } }, 502);
        return json({ queued });
      }
      return json({ error: { code: "not_found", message: path } }, 404);
    }
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
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
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
        assert.match(await head.locator(".work-block-time").innerText(), /^Worked for \d+m$/, "the time stays on the head's quiet right");
        assert.equal(await head.locator("svg.lucide-check.work-block-icon").count(), 1, "a finished group wears the check");
        assert.equal(await head.locator(".work-block-summary").count(), 0, "no classic counts");
        // the tool's picture: under the block, outside the fold, through the host source
        const thumb = view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).locator(":scope > .work-images .chat-user-image img");
        // the workspace's tab strip stands above the chat now: the turn is brought into view, where its lazy picture loads
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).scrollIntoViewIfNeeded();
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
        await fits("the card");
        // a typed answer goes as its text and the slot's empty id (refused here, so the card stays for option 2)
        await page.evaluate(() => { (window as unknown as { hostState: { holdAnswer: boolean } }).hostState.holdAnswer = true; });
        await card.getByRole("textbox").fill("FICTIONAL west");
        await card.getByRole("button", { name: "Send" }).click();
        await card.locator(".prompt-card-error").waitFor();
        const typed = await posts("/api/machines/remote/host-chats/chat/answer");
        assert.deepEqual(typed.map((post) => post.body), [{ session: SESSION, request_id: "req-1", question_id: "q-1", text: "FICTIONAL west", option_ids: [""] }], "a typed answer posts { text, option_ids: [\"\"] }");
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
        await modelPill.click();
        const sheet = page.getByRole("dialog", { name: "Model and agent" });
        await sheet.waitFor();
        await sheet.locator('[data-model="fictional/model-b"]').waitFor();
        assert.deepEqual(await sheet.locator(".host-picker-group .host-picker-provider").allTextContents(), ["Copilot", "fictional"], "the host's own models (no provider in the id) stand first, as Copilot");
        await sheet.locator('[data-model="fictional/model-b"]').click();
        await sheet.locator('[data-effort="high"]').click();
        await sheet.waitFor({ state: "detached" });
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model B.*high/, "the pill says the model and its effort");
        await view.locator(".host-chat-agent").click();
        await sheet.waitFor();
        assert.equal(await sheet.locator(".host-picker-option[data-agent]").first().textContent(), "Agent", '"Agent" comes first');
        await sheet.getByText("This choice applies to messages sent from here; a message typed on the PC uses the agent picked there.", { exact: true }).waitFor();
        // the sheet slides up from the bottom edge: measured and drawn once it has settled
        await page.waitForFunction(() => {
          const surface = document.querySelector(".host-picker");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the open sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-5-sheet-390.png") });
        await sheet.locator(`[data-agent="${REPORT}"]`).click();
        await sheet.waitFor({ state: "detached" });
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

        // 5. a busy chat: the composer says it works, and Send queues
        await page.evaluate(() => (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(true));
        await view.locator(".host-chat-status", { hasText: "Copilot is working on this chat" }).waitFor();
        await box.fill("FICTIONAL later");
        await view.getByRole("button", { name: "Queue message" }).click();
        await view.locator(".host-chat-status", { hasText: "Queued" }).waitFor();
        const queued = await posts("/api/machines/remote/host-chats/chat/send");
        assert.equal(queued.length, 2);
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model B.*high/, "the pills still show model-b · high after the send");
        assert.match(await view.locator(".host-chat-agent").textContent() ?? "", /Report/, "and Report");
        assert.deepEqual(bare(queued[1]), { session: SESSION, text: "FICTIONAL later", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT }, "the next send carries the model and agent the pills show");
        console.log("PASS a busy chat says it is working, and Send queues the message with the model and agent the pills show");

        // 5b. a send whose answer is lost (502): it says to send again, and the retry goes under the same id
        await page.evaluate(() => { (window as unknown as { hostState: { failNextSend: boolean } }).hostState.failNextSend = true; });
        await box.fill("FICTIONAL maybe");
        await view.getByRole("button", { name: "Queue message" }).click();
        await view.getByRole("alert").filter({ hasText: "Couldn't confirm it was sent. Send again: it won't go twice." }).waitFor();
        assert.equal(await box.inputValue(), "FICTIONAL maybe", "the words stay in the box");
        await view.getByRole("button", { name: "Queue message" }).click();
        await view.locator(".host-chat-status", { hasText: "Queued" }).waitFor();
        const retried = (await posts("/api/machines/remote/host-chats/chat/send")).slice(2);
        assert.equal(retried.length, 2);
        assert.match(String(retried[0]!.body["id"]), UUID);
        assert.equal(retried[1]!.body["id"], retried[0]!.body["id"], "the retry of the same words reuses the id");
        assert.notEqual(retried[0]!.body["id"], (await posts("/api/machines/remote/host-chats/chat/send"))[1]!.body["id"], "a new message has a new id");
        console.log("PASS a send whose answer was lost says to send again, and the retry reuses its id");

        // 6. nothing wider than the phone
        await fits("the busy chat");
        console.log("PASS no horizontal overflow at 390 px");

        // 6b. the folder row opens its chat, whose tab is the folder's; a read that fails says the bridge's words, not the request's URL
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await folderRow.locator(".workspace-select").click();
        const down = page.locator('.host-chat[data-host-session="fictional-session-0"]');
        await down.locator(".chat-inline-error").waitFor();
        assert.equal(await down.locator(".chat-inline-error").textContent(), "FICTIONAL the agent host is down", "the bridge's detail, without the URL and status");
        assert.equal(await page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-session-0"] [role="tab"]').getAttribute("aria-selected"), "true", "the folder row's chat is its tab");
        console.log("PASS a folder row opens its chat as its tab; a read that fails says the bridge's own words");

        // 6c. "All agents on Build PC…": search finds the month-old chat, Archived waits folded, and opening one makes it a tab of its workspace
        const pcMenu = async () => {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await remoteGroup.getByRole("button", { name: "More for Build PC", exact: true }).click();
        };
        await pcMenu();
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

        // 7. "+ New Copilot chat" on the remote PC: a folder chip, a model, the first message, Start chat
        const newChats = () => posts("/api/machines/remote/host-chats/chat/new");
        // until the "+" dialog offers Copilot (Task 11), the PC's menu opens the new-chat sheet
        const openNewSheet = async () => {
          await pcMenu();
          await page.getByRole("button", { name: "New Copilot chat…", exact: true }).click();
          const form = page.getByRole("dialog", { name: "New Copilot chat · Build PC" });
          await form.waitFor();
          return form;
        };
        assert.equal(await page.getByRole("region", { name: "PC Laptop", exact: true }).getByRole("button", { name: "More for Laptop" }).count(), 0, "a PC without the feature has no host menu");
        // the models and agents are a session's: the newest chat in the folder picked, else the PC's newest
        const modelReads = async (): Promise<string[]> => page.evaluate(() => [...(window as unknown as { hostCalls: { models: string[] } }).hostCalls.models]);
        const nextModelRead = async (after: number, what: string): Promise<string | undefined> => {
          await page.waitForFunction((count) => (window as unknown as { hostCalls: { models: string[] } }).hostCalls.models.length > count, after, { timeout: 10_000 })
            .catch(() => assert.fail(`${what}: the sheet read no models after the folder changed`));
          return (await modelReads())[after];
        };
        const readsBefore = (await modelReads()).length;
        let form = await openNewSheet();
        const folder = form.getByRole("textbox", { name: "Folder" });
        assert.equal(await folder.inputValue(), "/tmp/fictional-repo", "the newest chat's folder is filled in");
        assert.equal(await nextModelRead(readsBefore, "the opened sheet"), SESSION, "the pills read the newest chat in /tmp/fictional-repo");
        // another folder: its own newest chat (older than the PC's newest), not the PC's newest
        await form.getByRole("button", { name: "Use folder /tmp/fictional-docs", exact: true }).click();
        assert.equal(await folder.inputValue(), "/tmp/fictional-docs", "the chip fills the folder");
        assert.equal(await nextModelRead(readsBefore + 1, "/tmp/fictional-docs"), "fictional-session-0", "the pills read the newest chat in /tmp/fictional-docs");
        await form.getByRole("button", { name: "Use folder /tmp/fictional-repo", exact: true }).click();
        assert.equal(await folder.inputValue(), "/tmp/fictional-repo", "the chip fills the folder");
        assert.equal(await nextModelRead(readsBefore + 2, "/tmp/fictional-repo"), SESSION, "back in /tmp/fictional-repo, its newest chat's models");
        await form.locator(".host-chat-model").click();
        const picker = page.getByRole("dialog", { name: "Model and agent" });
        await picker.locator('[data-model="fictional/model-a"]').click();
        await picker.waitFor({ state: "detached" });
        assert.match(await form.locator(".host-chat-model").textContent() ?? "", /FICTIONAL Model A/);
        await form.getByRole("textbox", { name: "First message" }).fill("FICTIONAL first");
        await page.waitForFunction(() => {
          const surface = document.querySelector(".new-host-chat");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the new-chat sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-6-new-chat-sheet-390.png") });
        await form.getByRole("button", { name: "Start chat", exact: true }).click();
        const made = page.locator('.host-chat[data-host-session="fictional-new-1"]');
        await made.waitFor();
        await made.locator(".chat-turn-user", { hasText: "FICTIONAL first" }).waitFor();
        assert.equal(await form.count(), 0, "the sheet closes on the chat made");
        assert.deepEqual((await newChats()).map(bare), [{ cwd: "/tmp/fictional-repo", text: "FICTIONAL first", model: { id: "fictional/model-a" } }], "one chat/new with the folder, the text and the model");
        console.log("PASS + New Copilot chat posts the folder chip's path and the first message once, and opens the chat made");

        // 7b. made, but its first message did not go: the chat opens with the words in its box, nothing re-sent
        await page.evaluate(() => { (window as unknown as { hostState: { newSent: boolean } }).hostState.newSent = false; });
        const sendsBefore = (await posts("/api/machines/remote/host-chats/chat/send")).length;
        form = await openNewSheet();
        await form.getByRole("textbox", { name: "First message" }).fill("FICTIONAL kept");
        await form.getByRole("button", { name: "Start chat", exact: true }).click();
        const kept = page.locator('.host-chat[data-host-session="fictional-new-2"]');
        await kept.waitFor();
        assert.equal(await kept.getByRole("textbox", { name: "Message" }).inputValue(), "FICTIONAL kept", "the unsent first message waits in the composer");
        assert.equal((await newChats()).length, 2, "exactly one chat/new for this tap: no second chat");
        assert.equal((await posts("/api/machines/remote/host-chats/chat/send")).length, sendsBefore, "nothing is sent on the user's behalf");
        await fits("the chat made unsent");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS a chat made with its first message unsent opens with the words in its composer, once");

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
