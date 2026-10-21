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
// "+ New agent host chat" (made and sent, and made with its first message not sent).
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
  const state = window.hostState = { answered: false, busy: false, model: { id: "fictional/model-a", effort: null }, agent: null, sent: [], created: [], newSent: true, failNextSend: false, older: false, pushed: [], pending: [], stopped: 0, resumed: false, mode: "interactive", approvals: "default" };
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
      return { session, title: edits.titles[session] ?? "FICTIONAL new chat", status: "idle", turns, cursor: null, prompt: null, model: null, agent: null, busy: false, pending: [], checkpoints: [], restored: null, message_ids: made.sent ? ["new-1"] : [], signature: JSON.stringify([made, edits.titles[session] ?? null]) };
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
        { kind: "thinking", text: "FICTIONAL **the build** first, then the tests" },
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
        { kind: "notice", text: "Subagent \`FICTIONAL explore\` has completed.", source: "system" },
        { kind: "question", text: "FICTIONAL which config?", options: ["FICTIONAL debug", "FICTIONAL release"], chosen: ["FICTIONAL release"], custom: null, skipped: false },
        { kind: "text", text: "FICTIONAL release it is." },
        // a reply as the review chats write them: list items with long code and paths, and a table wider than the phone
        { kind: "text", text: "FICTIONAL findings:\\n\\n- **FICTIONAL blocker**: \\\`FICTIONAL_unusually_long_function_name_that_never_breaks_anywhere()\\\` in /tmp/fictional-repo/src/some/deeply/nested/folder/structure/file.ts reads the wrong row\\n- FICTIONAL second point that is a plain long sentence and has to wrap onto several lines on a phone\\n\\n| FICTIONAL file | FICTIONAL finding | FICTIONAL severity | FICTIONAL suggested change |\\n|---|---|---|---|\\n| src/fictional/review/handlers/charge.ts | FICTIONAL the handler reads a stale snapshot | FICTIONAL high | FICTIONAL read the row inside the transaction |\\n| src/fictional/review/handlers/refund.ts | FICTIONAL no idempotency key | FICTIONAL medium | FICTIONAL key the request on the order id |" },
        { kind: "tool", name: "Read file", tool_id: "view", summary: "Reading", past: "Read", input: JSON.stringify({ path: "/tmp/fictional-repo/src/refund.ts" }), output: "", error: false },
        { kind: "text", text: "FICTIONAL done." },
      ] },
      { role: "user", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL what next" }] },
      { role: "assistant", ts: at(2), parts: [        { kind: "question", text: "FICTIONAL Next", report: "FICTIONAL **Bundle 9** is live.\\n\\n- FICTIONAL the row reads its own chat\\n- FICTIONAL a path that runs long: /tmp/fictional-repo/src/some/deeply/nested/folder/structure/file.ts", options: [], chosen: [], custom: "FICTIONAL ship it", skipped: false }, { kind: "question", text: "FICTIONAL Notes (optional)", options: [], chosen: [], custom: null, skipped: true }, { kind: "text", text: "FICTIONAL which way should I go?" }, ...(state.resumed ? [] : [{ kind: "notice", text: "FICTIONAL 502 from the model", source: "error", resumable: true }])] },
    ];
    for (const text of state.pushed) turns.push({ role: "user", ts: at(1), parts: [{ kind: "text", text: "FICTIONAL from the PC" }] }, { role: "assistant", ts: at(1), parts: [{ kind: "text", text }] });
    for (const text of state.sent) turns.push({ role: "user", ts: at(0), parts: [{ kind: "text", text }] }, { role: "assistant", ts: at(0), parts: [] });
    const ids = [...(state.older ? ["h0"] : []), "h1", "h1b", "h2", ...state.pushed.map((_, index) => "p" + index), ...state.sent.map((_, index) => "s" + index)];
    const prompt = state.answered ? null : {
      id: "req-1:q-1", agent: "copilot", kind: "question", title: "FICTIONAL direction", question: "FICTIONAL pick **one** direction",
      body: "FICTIONAL see the \`map\` first" + Array.from({ length: 40 }, (_, index) => "\\n\\n- FICTIONAL step " + (index + 1)).join(""), options: [{ label: "FICTIONAL north", description: "FICTIONAL the short way, through the pass", recommended: true }, { label: "FICTIONAL south", description: null }, { label: "FICTIONAL east", description: "FICTIONAL **plain** here" }, { label: "Other…", description: null }],
      multi_select: false, custom_option_index: 3,
      host: { request_id: "req-1", question_id: "q-1", option_ids: ["opt-north", "opt-south", "opt-east", ""] },
    };
    // a form of two (VS Code's carousel): paged and answered on the phone, one Submit
    if (prompt && state.form) Object.assign(prompt, { id: "req-1:form", form: [
      { title: "FICTIONAL direction", question: "FICTIONAL pick **one** direction", options: prompt.options, multi_select: false, custom_option_index: 3, required: true },
      { title: "FICTIONAL pace", question: "FICTIONAL how fast?", options: [{ label: "FICTIONAL slow", description: null }, { label: "FICTIONAL quick", description: null }, { label: "Other…", description: null }], multi_select: false, custom_option_index: 2, required: false },
    ] }, { host: { ...prompt.host, form: [{ question_id: "q-1", option_ids: prompt.host.option_ids }, { question_id: "q-2", option_ids: ["slow", "quick", ""] }] } });
    return { session: SESSION, title: "FICTIONAL build chat", status: prompt ? "asks" : state.busy ? "working" : "idle", turns, cursor: state.older ? null : "c-older", prompt,
      model: state.model, agent: state.agent, busy: state.busy || prompt !== null, pending: state.pending,
      commands: [{ name: "fictional-skill", description: "FICTIONAL does a thing", kind: "skill" }], message_ids: ids,
      // VS Code's checkpoints, one per host turn: h1 edited build.ts (+28 -3), h1b and h2 nothing
      checkpoints: ids.map((id) => ({ turn: id, files: id === "h1" ? [{ path: "/tmp/fictional-repo/src/build.ts", added: 28, removed: 3 }] : [] })),
      restored: state.restored ?? null,
      background: state.background ?? { subagents: 0, commands: 0 }, confirmations: 0,
      context: { currentTokens: 84000, tokenLimit: 200000, conversationTokens: 60000, systemTokens: 9000, toolDefinitionsTokens: 15000 },
      signature: JSON.stringify([state.answered, state.busy, state.sent, state.model, state.agent, state.older, state.pushed, state.pending, state.background ?? null, state.resumed, state.restored ?? null]) };
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
    if (path === "/api/workspace/move") (calls.moves ??= []).push(machine);
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
        { session: "fictional-session-0", title: "FICTIONAL docs chat", status: "idle", modified_at: at(60 * 30), cwd: "/tmp/fictional-docs", unread: false, archived: false, ...(sessionStorage.getItem("fictional-worktrees") === "1" ? { branch: "main" } : {}) },
        // 20 days old: only "All agents on Build PC…" lists it
        { session: "fictional-session-old", title: "FICTIONAL old release notes", status: "idle", modified_at: at(60 * 24 * 20), cwd: "/tmp/fictional-repo", unread: false, archived: false },
        { session: "fictional-session-done", title: "FICTIONAL archived chat", status: "idle", modified_at: at(60 * 24 * 2), cwd: "/tmp/fictional-repo", unread: false, archived: true },
        // worktree folders: the host names their main checkout as the project (row.repo)
        ...(sessionStorage.getItem("fictional-worktrees") === "1" ? [
          { session: "fictional-wt-a", title: "FICTIONAL worktree chat", status: "idle", modified_at: at(5), cwd: "/tmp/fictional-docs.wt/feat-a", unread: false, archived: false, repo: "/tmp/fictional-docs", branch: "feat/fictional-a" },
          { session: "fictional-wt-x", title: "FICTIONAL lone worktree chat", status: "idle", modified_at: at(6), cwd: "/tmp/fictional-lib.wt/fix-x", unread: false, archived: false, repo: "/tmp/fictional-lib", branch: "fix/fictional-x" },
          // VS Code gave the host no folder: it ran in a scratch folder, filed under ~/.copilot/chats
          { session: "fictional-lost", title: "FICTIONAL lost chat", status: "idle", modified_at: at(7), cwd: "/home/fictional/.copilot/chats", unread: false, archived: false, no_folder: true },
        ] : []),
        ...state.created.filter((chat) => !chat.discarded).map((chat) => ({ session: chat.session, title: "FICTIONAL new chat", status: "idle", modified_at: at(0), cwd: chat.cwd, unread: false, archived: false })),
      ]) });
      // an attached file, stored in the chat's folder on its PC (a failure on request)
      if (path === "/api/host-chats/chat/upload") {
        if (state.failUpload) return json({ error: { code: "image_too_large", message: "FICTIONAL no room on the PC" } }, 413);
        return json({ path: "/tmp/fictional-repo/.herdr-web-ui/" + body.name });
      }
      if (path === "/api/host-chats/chat/resume") { state.resumed = true; return json({ ok: true }); }
      // VS Code's Fork Conversation: a chat in the same folder with the turns before the request
      if (path === "/api/host-chats/chat/fork") {
        if (state.failFork) return json({ error: { code: "first_turn", message: "FICTIONAL nothing to fork" } }, 409);
        const session = "fictional-fork-" + (state.created.length + 1);
        state.created.push({ session, cwd: "/tmp/fictional-repo", text: "FICTIONAL forked from " + body.turn, sent: true });
        edits.titles[session] = "FICTIONAL forked chat";
        return json({ session });
      }
      if (path === "/api/host-chats/chat/checkpoint/restore") { state.restored = { turn: body.turn, files: body.turn === "h1" || body.turn === "h0" ? 1 : 0 }; return json({ files: state.restored.files }); }
      if (path === "/api/host-chats/chat/checkpoint/redo") { const files = state.restored?.files ?? 0; state.restored = null; return json({ files }); }
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
        // no text: VS Code's New Chat, made empty for its own composer
        const sent = body.text !== undefined && state.newSent;
        state.created.push({ session, cwd: body.cwd, text: body.text ?? "", sent });
        return json(body.text === undefined || sent ? { session } : { session, sent: false });
      }
      if (path === "/api/host-chats/chat/discard") {
        const made = state.created.find((chat) => chat.session === body.session && !chat.discarded);
        const discarded = made !== undefined && !made.sent;
        if (discarded) made.discarded = true;
        return json({ discarded });
      }
      if (path === "/api/host-chats/models") calls.models.push(url.searchParams.get("session"));
      if (path === "/api/host-chats/models") return json({
        models: [
          { id: "fictional-own", name: "FICTIONAL Own", provider: "copilotcli", efforts: null, context: null, group: "copilot", multiplier: 27, warning: "FICTIONAL Own has a planned deprecation date." },
          { id: "fictional/model-a", name: "FICTIONAL Model A (Anthropic)", provider: "copilotcli", efforts: null, context: 200000 },
          { id: "fictional/model-b", name: "FICTIONAL Model B", provider: "copilotcli", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"], default: "medium" }, context: 1000000 },
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
        // an empty chat's first message is its first turn
        const made = state.created.find((chat) => chat.session === body.session);
        if (made && !made.sent) { made.sent = true; made.text = body.text; }
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
      { kind: "copilot-host", label: "Agent host", installed: true },
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
        // a returning user: Build PC's docs folder and its repo's build chat were opened before (lib/hostWorkspaces.ts)
        await context.addInitScript((session) => {
          if (localStorage.getItem("herdr-web-ui:host-workspaces") === null) localStorage.setItem("herdr-web-ui:host-workspaces", JSON.stringify({ remote: { open: [{ cwd: "/tmp/fictional-repo", tabs: [session] }, { cwd: "/tmp/fictional-docs", tabs: ["fictional-session-0"] }] } }));
        }, SESSION);
        // the browser's speech engine, as a phone's: interim words as they come, then the final ones
        await context.addInitScript(() => {
          class FakeSpeech {
            lang = ""; continuous = false; interimResults = false;
            onaudiostart: (() => void) | null = null; onresult: ((event: unknown) => void) | null = null;
            onerror: ((event: unknown) => void) | null = null; onend: (() => void) | null = null;
            private said = (window as unknown as { fakeSpeech?: string }).fakeSpeech ?? "FICTIONAL west wing";
            start(): void {
              setTimeout(() => this.onaudiostart?.(), 10);
              const words = this.said.split(" ");
              words.forEach((_, index) => setTimeout(() => {
                const partial = words.slice(0, index + 1).join(" ");
                this.onresult?.({ results: Object.assign([Object.assign([{ transcript: partial }], { isFinal: false })], { length: 1 }) });
              }, 30 + index * 30));
            }
            stop(): void {
              this.onresult?.({ results: Object.assign([Object.assign([{ transcript: this.said }], { isFinal: true })], { length: 1 }) });
              setTimeout(() => this.onend?.(), 10);
            }
            abort(): void { setTimeout(() => this.onend?.(), 0); }
          }
          // Chromium has the unprefixed name too, which the app reads first
          Object.assign(window, { SpeechRecognition: FakeSpeech, webkitSpeechRecognition: FakeSpeech });
        });
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
        const sheetItems = async () => (await page.locator(".row-sheet .row-sheet-item").allInnerTexts()).map((text) => text.trim());
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
        assert.equal(await folderRow.locator('svg[aria-label="copilot"]').count(), 1, "the folder row wears Copilot's mark");
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
        assert.equal(await command.locator("pre.work-row-command").innerText(), "make test", "opened, the command stands as a code block above its output (VS Code's terminal part)");
        // reasoning, as VS Code shows it whatever the pane setting: Thinking and its first words; opened, the whole as markdown
        const reasoning = block.locator(".work-row-reasoning");
        assert.equal((await reasoning.locator(".work-row-text").innerText()).trim(), "Thinking FICTIONAL the build first, then the tests", "the row says Thinking and the first words");
        await reasoning.locator(".work-row-head").click();
        assert.equal(await reasoning.locator(".work-reasoning-text strong").innerText(), "the build", "opened, the reasoning is markdown");
        const pill = block.locator(".work-row", { hasText: "Edited" }).locator(".work-file-pill");
        assert.equal(await pill.innerText(), "build.ts", "a file the row names is a pill with its name");
        assert.equal(await pill.locator("svg").count(), 1, "and its icon");
        await page.waitForFunction(() => (window as unknown as { hostCalls: { posts: { path: string }[] } }).hostCalls.posts.some((post) => post.path.endsWith("/host-chats/chat/watch")));
        await fits("the chat");
        // nothing in the chat runs past its column: text wraps, and a table wider than the phone
        // scrolls in its own wrap (the page's scrollWidth cannot see what a scroller clips)
        const review = view.locator(".chat-turn-agent .markdown", { hasText: "FICTIONAL findings:" });
        // the findings sit between two tool calls: the work block holds them, as the review chats' did
        assert.equal(await review.evaluate((node) => node.parentElement?.className), "work-words", "the findings sit between two tool calls, as VS Code's words between tool groups");
        await review.scrollIntoViewIfNeeded().catch(() => {});
        const spill = await view.locator(".chat-transcript").evaluate((transcript) => {
          const edge = transcript.getBoundingClientRect().right + 1;
          const out: string[] = [];
          for (const node of transcript.querySelectorAll<HTMLElement>(".markdown, .markdown :is(p, li, code, a, span, pre, table, .markdown-table-wrap), .question-summary-report-body")) {
            if (node.closest(".markdown-table-wrap") && !node.matches(".markdown-table-wrap")) continue;
            const right = node.getBoundingClientRect().right;
            if (right > edge) out.push(`${node.tagName.toLowerCase()}.${node.className} ${Math.round(right)} > ${Math.round(edge)}: ${(node.textContent ?? "").slice(0, 40)}`);
          }
          return out;
        });
        // the ask_user report: folded under its question, opened as markdown, and still in the column
        // a form: its report once, first, then one question per field
        const asked = view.locator(".question-summary", { hasText: "FICTIONAL Bundle 9 is live." });
        await asked.waitFor();
        assert.deepEqual(await asked.locator("xpath=..").locator(".question-summary-prefix").allInnerTexts(), ["Report:", "Question:", "Answered:", "Question:"], "the report leads, then each field's question once");
        if (shots) await asked.locator("xpath=..").screenshot({ path: join(shots, "ask-form-folded-390.png") });
        await asked.getByRole("button", { name: /Report: FICTIONAL Bundle 9 is live/ }).click();
        await asked.locator(".question-summary-report-body strong", { hasText: "Bundle 9" }).waitFor();
        assert.equal(await asked.locator(".question-summary-report-body li").count(), 2, "the report is the whole markdown message");
        assert.equal(await asked.locator(".question-summary-answer-value").innerText(), "FICTIONAL ship it");
        await asked.scrollIntoViewIfNeeded();
        if (shots) await page.screenshot({ path: join(shots, "ask-report-390.png") });
        assert.deepEqual(spill, [], "nothing in the chat runs past its column");
        const wrap = review.locator(".markdown-table-wrap");
        const sizes = await wrap.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, overflow: getComputedStyle(node).overflowX }));
        assert.ok(sizes.scroll > sizes.client && sizes.overflow === "auto", `the wide table scrolls sideways in its wrap (${JSON.stringify(sizes)})`);
        if (shots) await page.screenshot({ path: join(shots, "task-5-chat-390.png") });
        if (shots) await page.screenshot({ path: join(shots, "task-4-host-390.png") });
        console.log("PASS the chat renders through ChatView: a user turn, an assistant text and a folded tool row, and is watched");

        // a turn that stopped at an error: VS Code's error row in the open, and Try Again resumes it
        const failedTurn = view.locator(".chat-turn-agent", { hasText: "FICTIONAL which way should I go?" });
        const errorRow = failedTurn.locator(".chat-turn-error");
        await errorRow.waitFor();
        assert.equal(await errorRow.locator(".chat-turn-error-text").innerText(), "FICTIONAL 502 from the model", "the host's words, in the open");
        assert.equal(await errorRow.getAttribute("role"), "alert");
        if (shots) { await errorRow.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, "r3-error-390.png") }); }
        await errorRow.getByRole("button", { name: "Try again" }).click();
        await page.waitForFunction(() => (window as unknown as { hostCalls: { posts: { path: string }[] } }).hostCalls.posts.some((post) => post.path.endsWith("/host-chats/chat/resume")));
        await errorRow.waitFor({ state: "detached" });
        console.log("PASS an error the turn stopped at shows in the open, and Try again resumes the turn");

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
        // the host's "has completed" sits between the subagent and the question, its Markdown drawn
        const done = await subTurn.evaluate((node) => {
          const row = node.querySelector(".chat-system-notification")!;
          const order = [...node.querySelectorAll(".subagent-row, .chat-system-notification, .question-summary")].map((el) => el.className.split(" ")[0]);
          return { text: (row as HTMLElement).innerText.trim(), code: row.querySelector("code")?.textContent ?? null, order };
        });
        assert.deepEqual(done, { text: "Subagent FICTIONAL explore has completed.", code: "FICTIONAL explore", order: ["subagent-row", "chat-system-notification", "question-summary"] }, "a system notification in place, as Markdown");
        // VS Code's sticky request: the turn's own message pinned over the view once it has scrolled
        // out, two lines; a tap takes the reader back to it
        await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>(".host-chat .chat-view")!;
          const asked = [...document.querySelectorAll(".host-chat .chat-turn-user")].find((node) => node.textContent?.includes("FICTIONAL find the config"))!;
          scroller.scrollTop += asked.getBoundingClientRect().top - scroller.getBoundingClientRect().top + asked.getBoundingClientRect().height + 8;
          scroller.dispatchEvent(new Event("scroll"));
        });
        const pinned = view.locator(".chat-sticky-request");
        await pinned.waitFor({ timeout: 3000 }).catch(() => assert.fail("no sticky request once the message scrolled out"));
        assert.equal((await pinned.innerText()).trim(), "FICTIONAL find the config", "the sticky row is the turn's own message");
        const clamp = await pinned.locator(".chat-sticky-request-text").evaluate((node) => getComputedStyle(node).webkitLineClamp);
        assert.equal(clamp, "2", "cut to two lines");
        if (shots) await page.screenshot({ path: join(shots, "r5-sticky-390.png") });
        await pinned.click();
        await page.waitForFunction(() => {
          const asked = [...document.querySelectorAll(".host-chat .chat-turn-user")].find((node) => node.textContent?.includes("FICTIONAL find the config"));
          const scroller = document.querySelector(".host-chat .chat-view");
          if (!asked || !scroller) return false;
          return Math.abs(asked.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 24;
        }, undefined, { timeout: 3000 }).catch(() => assert.fail("tapping the sticky request did not take the reader to the message"));
        await page.locator(".host-chat .chat-view").evaluate((node) => node.dispatchEvent(new Event("scroll")));
        await pinned.waitFor({ state: "detached", timeout: 3000 }).catch(() => assert.fail("the sticky request stays while its message is in view"));
        console.log("PASS the turn's message sticks at the top, two lines, and a tap goes back to it");

        // VS Code's checkpoints: Start Over on the chat's first message, Restore on the others; the
        // sheet names the files and what goes; a restore fades the turns from there, puts the message
        // in the box and shows Redo; Redo puts it all back
        const firstAsk = view.locator(".chat-turn-user", { hasText: "FICTIONAL an earlier ask" });
        assert.equal(await firstAsk.getByRole("button", { name: "Start Over" }).count(), 1, "the first message is Start Over");
        const buildAsk = view.locator(".chat-turn-user", { hasText: "FICTIONAL look at the build" });
        assert.equal(await buildAsk.getByRole("button", { name: "Start Over" }).count(), 0, "a later message is no Start Over");
        await buildAsk.scrollIntoViewIfNeeded();
        await buildAsk.getByRole("button", { name: "Restore Checkpoint" }).click();
        const ckSheet = page.getByRole("alertdialog", { name: "Restore checkpoint?" });
        await ckSheet.waitFor();
        // the chat still asks (busy): the host would restore nothing, so the sheet says Stop first
        assert.equal(await ckSheet.getByRole("button", { name: "Restore", exact: true }).isDisabled(), true, "no restore while the agent works");
        assert.equal(await ckSheet.getByRole("button", { name: "Stop", exact: true }).count(), 1, "Stop is offered");
        await ckSheet.getByRole("button", { name: "Cancel" }).click();
        await ckSheet.waitFor({ state: "detached" });
        await page.evaluate(() => { const state = (window as unknown as { hostState: { answered: boolean } }).hostState; state.answered = true; (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(false); });
        await view.locator(".host-chat-status-line", { hasText: "Waiting for your response" }).waitFor({ state: "detached" });
        await buildAsk.getByRole("button", { name: "Restore Checkpoint" }).click();
        await ckSheet.waitFor();
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".checkpoint-sheet-restore")?.disabled);
        assert.deepEqual(await ckSheet.locator(".checkpoint-file").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
          ["build.ts /tmp/fictional-repo/src +28 −3"], "the files it puts back, with their lines");
        assert.match(await ckSheet.innerText(), /Sending removes it and the \d+ after it/, "it says what a send removes");
        if (shots) { await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished.catch(() => undefined)))); await page.screenshot({ path: join(shots, "r5-checkpoint-sheet-390.png") }); }
        await ckSheet.getByRole("button", { name: "Restore", exact: true }).click();
        await ckSheet.waitFor({ state: "detached" });
        const ckPost = (await page.evaluate(() => (window as unknown as { hostCalls: { posts: { path: string; body: Record<string, unknown> }[] } }).hostCalls.posts)).filter((post) => post.path.endsWith("/checkpoint/restore"));
        assert.deepEqual(ckPost.map((post) => post.body), [{ session: SESSION, turn: "h1" }], "one restore, of that turn");
        const bar = view.locator(".checkpoint-bar");
        await bar.waitFor();
        await buildAsk.scrollIntoViewIfNeeded();
        await page.locator(".host-chat .chat-view").evaluate((node) => node.dispatchEvent(new Event("scroll")));
        const overlap = await page.evaluate(() => {
          const pinned = document.querySelector(".host-chat .chat-sticky-request-text")?.getBoundingClientRect();
          if (!pinned) return null;
          return [...document.querySelectorAll(".host-chat .chat-turn-user .chat-bubble")].map((node) => node.getBoundingClientRect()).some((box) => box.top < pinned.bottom && box.bottom > pinned.top);
        });
        assert.ok(overlap !== true, "the pinned request never covers a user message in view");
        assert.equal((await bar.locator(".checkpoint-bar-text").innerText()).trim(), "Checkpoint restored · 1 file");
        assert.equal(await view.locator(".composer-text").inputValue(), "FICTIONAL look at the build", "the message is back in the box");
        const faded = await view.locator(".chat-turn").evaluateAll((rows) => rows.filter((row) => row.parentElement?.closest(".chat-turn") === null).map((row) => [(row as HTMLElement).innerText.slice(0, 40), row.classList.contains("is-checkpoint-faded")]));
        const fromBuild = faded.findIndex(([text]) => String(text).includes("FICTIONAL look at the build"));
        assert.ok(fromBuild > 0 && faded.slice(0, fromBuild).every(([, on]) => on === false) && faded.slice(fromBuild).every(([, on]) => on === true), `faded from that message on: ${JSON.stringify(faded)}`);
        if (shots) { await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished.catch(() => undefined)))); await page.screenshot({ path: join(shots, "r5-checkpoint-restored-390.png") }); }
        await bar.getByRole("button", { name: "Redo" }).click();
        await bar.waitFor({ state: "detached" });
        assert.equal(await view.locator(".chat-turn.is-checkpoint-faded").count(), 0, "Redo: nothing faded");
        await view.locator(".composer-text").fill("");
        // the rest of the demo starts from the question still open
        await page.evaluate(() => { const state = (window as unknown as { hostState: { answered: boolean } }).hostState; state.answered = false; (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(false); });
        await view.locator(".host-chat-status-line", { hasText: "Waiting for your response" }).waitFor();
        console.log("PASS a checkpoint restores through its sheet, fades the turns after it, puts its message back, and Redo undoes it");
        await summary.scrollIntoViewIfNeeded();
        await fits("the answered question");
        if (shots) await page.screenshot({ path: join(shots, "task-5-question-390.png") });
        console.log("PASS a subagent row shows its name, task, model and time and opens to its own chat; an answered question reads Question / Answered");

        // 3. the question card: its markdown rendered, a typed answer through "Other…", then option 2
        const card = page.locator(".prompt-card");
        await card.locator(".prompt-card-question strong", { hasText: "one" }).waitFor();
        await card.locator(".prompt-card-body code", { hasText: "map" }).waitFor();
        assert.match(await card.locator(".prompt-card-option-description").nth(1).innerText(), /\*\*plain\*\*/, "an option's description stays plain");
        // the host's recommended option: a pill beside its bold title, its description under it
        const north = card.locator(".prompt-card-option", { hasText: "FICTIONAL north" });
        assert.equal((await north.locator(".prompt-card-tag").innerText()).trim(), "Recommended", "the host's recommended option carries the pill");
        assert.equal(await card.locator(".prompt-card-tag").count(), 1, "only the recommended option has it");
        const rows = await north.evaluate((node) => {
          const title = node.querySelector(".prompt-card-option-label")!.getBoundingClientRect();
          const description = node.querySelector(".prompt-card-option-description")!.getBoundingClientRect();
          return { below: description.top >= title.bottom - 1, weight: Number(getComputedStyle(node.querySelector(".prompt-card-option-label")!).fontWeight) };
        });
        assert.ok(rows.below && rows.weight >= 600, `title bold over its description: ${JSON.stringify(rows)}`);
        if (shots) { await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: join(shots, "r4-askcard-390.png") }); }
        assert.equal(await card.getByRole("textbox").getAttribute("placeholder"), "Other…", "the typed-answer field is the Other… slot");
        // the status row says what the chat waits on, VS Code's words, and ends with its context meter
        assert.equal((await view.locator(".host-chat-status-line").textContent())?.trim(), "Waiting for your response", "an open question: Waiting for your response");
        assert.equal((await view.locator(".host-chat-meter-label").textContent())?.trim(), "42% · 84K / 200K", "the meter reads copilot.usageInfo");
        assert.equal(await view.locator(".host-chat-meter").getAttribute("title"), "Context window: 42% · 84K / 200K");
        assert.equal((await view.locator(".host-chat-meter-short").innerText()).trim(), "42%", "a phone shows the percent, the counts in its title and sheet");
        await fits("the card");
        // the card opens to a full-height sheet: the question scrolls, the answer field stays in view,
        // and collapsing keeps the typed text
        // the header's two controls sit together at its end, and the title is plain text, not the alarm red
        const cardHead = await card.locator(".prompt-card-header").evaluate((node) => {
          const expand = node.querySelector(".prompt-card-expand")!.getBoundingClientRect();
          const fold = node.querySelector(".prompt-card-fold")!.getBoundingClientRect();
          const title = getComputedStyle(node.querySelector("h2")!).color;
          const probe = document.createElement("span");
          probe.style.color = "var(--status-blocked)";
          node.append(probe);
          const red = getComputedStyle(probe).color;
          probe.remove();
          return { gap: Math.round(fold.left - expand.right), end: Math.round(node.getBoundingClientRect().right - fold.right), red: title === red };
        });
        assert.ok(cardHead.gap >= 0 && cardHead.gap <= 8 && cardHead.end <= 1 && !cardHead.red, `expand beside fold at the end, title not red: ${JSON.stringify(cardHead)}`);
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
        // dictation in the card is the composer's: the same mic, the same pill over the field, and
        // what is said lands once in the field, after what was typed
        await card.getByRole("textbox").fill("FICTIONAL typed");
        const cardMic = card.locator(".prompt-card-mic .voice-mic");
        await cardMic.click();
        const cardPill = card.locator(".voice-pill.is-open");
        await cardPill.waitFor();
        await card.locator('.prompt-card-mic[data-state="recording"]').waitFor({ timeout: 5000 }).catch(async () => assert.fail(`the card's mic never records: ${await card.locator(".prompt-card-mic").getAttribute("data-state")}`));
        await page.waitForTimeout(200);
        const pillAt = await card.evaluate((node) => {
          const pill = node.querySelector(".voice-pill")!.getBoundingClientRect();
          const field = node.querySelector(".prompt-card-custom .input")!.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return { above: pill.bottom <= field.top + 1, inside: pill.left >= box.left - 1 && pill.right <= box.right + 1 };
        });
        assert.ok(pillAt.above && pillAt.inside, `the card's pill sits over its field, inside the card: ${JSON.stringify(pillAt)}`);
        if (shots) await page.screenshot({ path: join(shots, "r6-card-dictation-390.png") });
        await cardMic.click();
        await cardPill.waitFor({ state: "detached" }).catch(() => undefined);
        await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".prompt-card-custom .input")?.value.includes("wing"), null, { timeout: 5000 });
        assert.equal(await card.getByRole("textbox").inputValue(), "FICTIONAL typed FICTIONAL west wing", "the words land once, after the typed ones");
        await card.getByRole("textbox").fill("");
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

        // 3b. a form of two: a pick goes on to the next page and is kept; Back shows it picked, a
        // change sticks, an optional page left empty goes as null, and Submit sends both at once
        await page.evaluate(() => { const host = (window as unknown as { hostState: { answered: boolean; form: boolean } }).hostState; host.answered = false; host.form = true; (window as unknown as { setHostBusy(busy: boolean): void }).setHostBusy(false); });
        const formCard = page.locator(".prompt-dock .prompt-card");
        await formCard.locator(".prompt-card-pager-count", { hasText: "1 of 2" }).waitFor();
        const answeredBefore = (await posts("/api/machines/remote/host-chats/chat/answer")).length;
        assert.equal(await formCard.getByRole("button", { name: "Next question" }).isDisabled(), true, "a required page waits for its answer");
        await formCard.getByRole("button", { name: /FICTIONAL south/ }).click();
        await formCard.locator(".prompt-card-pager-count", { hasText: "2 of 2" }).waitFor();
        assert.equal((await posts("/api/machines/remote/host-chats/chat/answer")).length, answeredBefore, "a pick posts nothing until Submit");
        await formCard.getByRole("button", { name: "Previous question" }).click();
        await formCard.locator(".prompt-card-pager-count", { hasText: "1 of 2" }).waitFor();
        assert.equal(await formCard.getByRole("button", { name: /FICTIONAL south/ }).getAttribute("aria-pressed"), "true", "Back shows what was picked");
        await formCard.getByRole("button", { name: /FICTIONAL east/ }).click();
        await formCard.locator(".prompt-card-pager-count", { hasText: "2 of 2" }).waitFor();
        if (shots) await formCard.screenshot({ path: join(shots, "r4-form-390.png") });
        await formCard.getByRole("button", { name: "Submit", exact: true }).click();
        await formCard.waitFor({ state: "detached" });
        const sent = (await posts("/api/machines/remote/host-chats/chat/answer")).slice(answeredBefore);
        assert.deepEqual(sent.map((post) => post.body), [{ session: SESSION, request_id: "req-1", answers: { "q-1": { option_ids: ["opt-east"] }, "q-2": null } }], "one Submit, the changed pick and the empty optional page");
        await page.evaluate(() => { (window as unknown as { hostState: { form: boolean } }).hostState.form = false; });
        console.log("PASS a form pages on the phone, keeps and changes its picks, and Submit sends them all at once");

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
        assert.deepEqual(await sheet.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent)), ["All, 4 models", "Copilot, 1 model", "fictional, 3 models"], "a tab per group, Copilot first, each with its count");
        // the provider tabs stay at the sheet's top while its list scrolls (the owner scrolled past Copilot's to reach OmniRoute's)
        const tabsAt = await sheet.locator(".modal-body").evaluate((body) => {
          body.style.flex = "none"; body.style.height = "160px";
          body.scrollTop = body.scrollHeight;
          const scrolled = body.scrollTop;
          const box = body.querySelector(".host-picker-tabs")!.getBoundingClientRect();
          const frame = body.getBoundingClientRect();
          return { scrolled, top: Math.round(box.top - frame.top), shown: box.top >= frame.top - 1 && box.bottom <= frame.bottom };
        });
        assert.ok(tabsAt.scrolled > 100, `the list really scrolled: ${JSON.stringify(tabsAt)}`);
        assert.ok(tabsAt.shown, `the provider tabs stay in view at the list's end: ${JSON.stringify(tabsAt)}`);
        await sheet.locator(".modal-body").evaluate((body) => { body.style.flex = ""; body.style.height = ""; body.scrollTop = 0; });
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
        assert.match(await sheet.locator('[data-model="fictional/model-b"] .host-model-detail').textContent() ?? "", /^Medium · 1M$/, "a row says its default thinking level and its context");
        // a row with a thinking level shows it can open, not only a dotted underline (the owner missed it, 2026-10-20)
        assert.equal(await sheet.locator('[data-model="fictional/model-b"] .host-model-detail svg.host-model-detail-caret').count(), 1, "the thinking level wears a caret");
        assert.equal(await sheet.locator('[data-model="fictional/model-a"] .host-model-detail svg').count(), 0, "a row without one has none");
        await sheet.locator('[data-model="fictional/model-b"] .host-model-pick').click();
        await sheet.waitFor({ state: "detached" });
        assert.equal((await modelPill.locator(".host-chat-pill-aside").textContent())?.trim(), "Medium", "the pill says the default thinking level until one is picked");
        await modelPill.click();
        // the pick is Recent now, above All models
        const recent = sheet.getByRole("region", { name: "Recent" });
        assert.deepEqual(await recent.locator("[data-model]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model"))), ["fictional/model-b"], "the pick heads Recent");
        await recent.locator('[data-model="fictional/model-b"] button.host-model-detail').click();
        await sheet.getByRole("group", { name: "Reasoning effort" }).waitFor();
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
        // the busy chat's "Working…" shimmers as VS Code's does: the text clipped to a moving gradient
        const working = view.locator(".work-block.is-live:not(.is-waiting) .work-block-title, .chat-activity-text").last();
        await working.waitFor();
        const shimmer = await working.evaluate((node) => { const style = getComputedStyle(node); return { clip: style.backgroundClip || (style as unknown as Record<string, string>)["webkitBackgroundClip"], name: style.animationName, image: style.backgroundImage.startsWith("linear-gradient") }; });
        assert.deepEqual(shimmer, { clip: "text", name: "work-shimmer", image: true }, "the live title shimmers");
        if (shots) await page.screenshot({ path: join(shots, "r4-working-390.png") });
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

        // a Copilot folder (AHP chats, no herdr workspace): the header's ⋯ is its row's menu, none of a pane's items
        const menuItems = async () => (await page.locator(".row-sheet .row-sheet-item").allInnerTexts()).map((text) => text.trim());
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.locator(".row-sheet").waitFor();
        const headerFolder = await menuItems();
        assert.deepEqual(headerFolder, ["New agent host chat…", "Chats in fictional-docs…", "Pin folder", "Close workspace", "Copy path"], "an agent host workspace's header ⋯: its own items");
        if (shots) { await page.waitForFunction(() => document.querySelector(".row-sheet")?.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running") ?? false); await page.screenshot({ path: join(shots, "r9-folder-header-menu-390.png") }); }
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await folderRow.getByRole("button", { name: /^More for / }).click();
        await page.locator(".row-sheet").waitFor();
        assert.deepEqual(await menuItems(), headerFolder, "the folder row's ⋯ is the same menu");
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null);
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Chats in fictional-docs…" }).click();
        const fromHeader = page.getByRole("dialog", { name: "Chats in fictional-docs", exact: true });
        await fromHeader.waitFor();
        await fromHeader.getByRole("button", { name: "Close dialog" }).click();
        await fromHeader.waitFor({ state: "detached" });
        console.log("PASS an agent host workspace's header ⋯ is its row's menu: New agent host chat, Chats in <folder>, Pin, Close workspace, Copy path");

        // a Copilot folder pins as a workspace does: its row stands in Pinned, and its menus say Unpin
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await folderRow.getByRole("button", { name: /^More for / }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Pin folder" }).click();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        const pinnedList = remoteGroup.locator(".sidebar-pinned");
        await pinnedList.locator('.host-folder[data-host-folder="/tmp/fictional-docs"]').waitFor();
        assert.equal(await remoteGroup.locator('.workspace-list:not(.sidebar-pinned) > .host-folder[data-host-folder="/tmp/fictional-docs"]').count(), 0, "a pinned folder leaves the workspace list");
        assert.equal(await remoteGroup.locator(".sidebar-pinned-label").count(), 1, "Pinned says so once");
        assert.ok((await page.evaluate(() => localStorage.getItem("herdr-web-ui:sidebar-agent-pins")) ?? "").includes("remote:folder:/tmp/fictional-docs"), "the pin is saved by PC and folder");
        if (shots) await remoteGroup.screenshot({ path: join(shots, "r10-folder-pinned-390.png") });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null);
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.locator(".row-sheet").waitFor();
        assert.equal((await menuItems())[2], "Unpin folder", "the header ⋯ unpins the folder");
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Unpin folder" }).click();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await remoteGroup.locator('.workspace-list:not(.sidebar-pinned) > .host-folder[data-host-folder="/tmp/fictional-docs"]').waitFor();
        assert.equal(await pinnedList.locator(".host-folder").count(), 0, "unpinned, the folder is back among the workspaces");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null);
        console.log("PASS a Copilot folder pins from its row's ⋯ into Pinned, and unpins from the header's");

        // 6c. "All agents on Build PC…", from the Agents head's ⋯ (a PC row has no ⋯): search finds the
        // month-old chat, Archived waits folded, and opening one makes it a tab of its workspace
        const drawerOpen = async () => {
          if (await page.locator("#workspace-drawer.is-open").count() === 0) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        };
        const agentsMenu = async () => {
          await drawerOpen();
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
        // VS Code's ages head the chats, and under All each row names its folder
        const ages = await all.locator(".all-agents-age").allInnerTexts();
        assert.equal(ages[0], "Today", "the newest chats sit under Today");
        assert.equal(ages.at(-1), "Last 30 days", "the 20-day-old chat sits under Last 30 days");
        assert.equal(await all.getByRole("region", { name: "Last 30 days" }).locator('[data-host-session="fictional-session-old"]').count(), 1, "the old chat under its age");
        assert.ok((await all.locator('[data-host-session="fictional-session-old"]').innerText()).includes("fictional-repo"), "under All a row names its folder");
        // a pill per folder, the most recently active first; one narrows the list to its folder
        const pills = all.getByRole("radiogroup", { name: "Folders" }).getByRole("radio");
        assert.deepEqual((await pills.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()), ["All 3", "fictional-repo 2", "fictional-docs 1"], "All, then each folder with its chats");
        assert.equal(await pills.first().getAttribute("aria-checked"), "true", "All starts picked");
        await pills.filter({ hasText: "fictional-docs" }).click();
        assert.deepEqual(await all.locator(".host-chat-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-host-session"))), ["fictional-session-0"], "the docs pill keeps the docs chat only");
        assert.equal(await all.locator(".all-agents-archived").count(), 0, "no archived chat in that folder: no Archived");
        assert.ok(!(await all.locator('[data-host-session="fictional-session-0"]').innerText()).includes("fictional-docs"), "a folder's pill already names it: its rows don't");
        await pills.first().click();
        assert.equal(await all.locator('[data-host-session="fictional-session-old"]').count(), 1, "All brings every folder back");
        // a tap on Archived opens it on the chats it holds, and a second folds it again; the body is
        // cut short first, as a PC with many chats makes it, so Archived sits at the fold's edge
        await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>(".all-agents .modal-body")!;
          const archived = document.querySelector<HTMLElement>(".all-agents-archived")!;
          body.style.maxHeight = `${archived.getBoundingClientRect().bottom - body.getBoundingClientRect().top + 4}px`;
          body.scrollTop = 0;
        });
        await all.locator(".all-agents-archived").click();
        await all.locator('[data-host-session="fictional-session-done"]').waitFor({ timeout: 3000 }).catch(() => assert.fail("Archived opened on nothing"));
        assert.ok(await all.locator('[data-host-session="fictional-session-done"]').isVisible(), "the archived chat shows once Archived is open");
        // with a long list Archived opens below the fold: the sheet brings it up
        await page.waitForFunction(() => {
          const body = document.querySelector(".all-agents .modal-body")!.getBoundingClientRect();
          const row = document.querySelector('.all-agents [data-host-session="fictional-session-done"]')!.getBoundingClientRect();
          return row.top >= body.top - 1 && row.bottom <= body.bottom + 1;
        }, null, { timeout: 3000 }).catch(() => assert.fail("the opened Archived rows stay out of sight"));
        // VS Code's Unarchive: an archived row's menu restores it, and it joins the current chats
        await all.locator('[data-host-session="fictional-session-done"]').getByRole("button", { name: /^More for / }).click();
        await page.locator(".row-sheet").getByRole("button", { name: "Restore", exact: true }).click();
        await page.waitForFunction(() => (window as unknown as { hostEdits: { archived: Record<string, boolean> } }).hostEdits.archived["fictional-session-done"] === false, null, { timeout: 3000 }).catch(() => assert.fail("Restore sent nothing"));
        await page.waitForFunction(() => {
          const row = document.querySelector('.all-agents [data-host-session="fictional-session-done"]');
          return row !== null && row.closest(".all-agents-group")?.getAttribute("aria-label") !== "Archived";
        }, null, { timeout: 3000 }).catch(() => assert.fail("the restored chat stays under Archived"));
        assert.equal(await all.locator(".all-agents-archived").count(), 0, "nothing archived left: no Archived");
        // archived again, as it was, for what follows
        await all.locator('[data-host-session="fictional-session-done"]').getByRole("button", { name: /^More for / }).click();
        await page.locator(".row-sheet").getByRole("button", { name: "Mark as done", exact: true }).click();
        await all.locator(".all-agents-archived").waitFor({ timeout: 3000 });
        if (await all.locator(".all-agents-archived").getAttribute("aria-expanded") === "true") await all.locator(".all-agents-archived").click();
        assert.equal(await all.locator('[data-host-session="fictional-session-done"]').count(), 0, "folded again");
        await page.evaluate(() => { document.querySelector<HTMLElement>(".all-agents .modal-body")!.style.maxHeight = ""; });
        await page.waitForFunction(() => {
          const surface = document.querySelector(".all-agents");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the All agents sheet");
        await noVsCode("the All agents sheet");
        // a stroke that starts on a row's words scrolls the list: a clipped line (overflow: hidden) is a
        // scroll container, and one that kept its overscroll held the stroke, so the list stalled until
        // a finger landed between rows. The wheel takes the same chain as a finger.
        await page.evaluate(() => { const body = document.querySelector<HTMLElement>(".all-agents .modal-body")!; body.style.maxHeight = `${body.scrollHeight - 60}px`; body.scrollTop = 0; });
        // the sheet sits down at its new height, then the finger lands on the words of a row in sight
        await page.waitForFunction(() => { const sheet = document.querySelector(".all-agents")!; return sheet.getBoundingClientRect().bottom <= window.innerHeight + 1 && sheet.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"); });
        const wordsAt = await page.evaluate(() => {
          const body = document.querySelector(".all-agents .modal-body")!.getBoundingClientRect();
          for (const node of document.querySelectorAll(".all-agents .host-chat-item .agent-context")) {
            const box = node.getBoundingClientRect();
            if (box.top >= body.top && box.bottom <= body.bottom) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          }
          return null;
        });
        assert.ok(wordsAt, "a row's words are in sight");
        assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".agent-context") !== null, wordsAt), "the finger lands on the row's words");
        await page.mouse.move(wordsAt.x, wordsAt.y);
        await page.mouse.wheel(0, 200);
        await page.waitForFunction(() => document.querySelector(".all-agents .modal-body")!.scrollTop > 0, null, { timeout: 2000 })
          .catch(() => assert.fail("a stroke on a row's words does not scroll the list"));
        await page.evaluate(() => { const body = document.querySelector<HTMLElement>(".all-agents .modal-body")!; body.style.maxHeight = ""; body.scrollTop = 0; });
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

        // 6d. a chat opened from a list is a look: its tab stands while it is on screen, and nothing is
        // saved. Keep open makes it a tab for good; Close tab hides one (never archives), and a
        // workspace's last closes it (lib/hostWorkspaces.ts)
        const savedTabs = async (): Promise<Record<string, { open: { cwd: string; tabs: string[] }[] }>> => JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:host-workspaces") ?? "{}"));
        const oldTab = page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-session-old"]');
        const keepOpen = page.locator(".host-chat .look-bar").getByRole("button", { name: "Keep open", exact: true });
        await keepOpen.waitFor();
        assert.ok(!(await savedTabs()).remote!.open.some((each) => each.tabs.includes("fictional-session-old")), "a look is saved nowhere");
        if (shots) { await page.locator(".all-agents").waitFor({ state: "detached" }); await page.waitForTimeout(300); await page.screenshot({ path: join(shots, "look-keep-open-390.png") }); }
        // leaving it: its tab goes
        await page.locator(`.tab-strip .host-chat-tab[data-host-session="${SESSION}"] [role="tab"]`).click();
        await page.locator(`.host-chat[data-host-session="${SESSION}"]`).waitFor();
        await oldTab.waitFor({ state: "detached", timeout: 3000 }).catch(() => assert.fail("a look's tab stays after leaving it"));
        assert.equal(await page.locator(".host-chat .look-bar").count(), 0, "a tab is no look");
        // again, and Keep open: it stays a tab after leaving
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        await all.waitFor();
        await all.getByRole("searchbox", { name: "Search agents" }).fill("release notes");
        await all.locator('[data-host-session="fictional-session-old"] .agent-select').click();
        await all.waitFor({ state: "detached" });
        await keepOpen.click();
        await page.locator(".host-chat .look-bar").waitFor({ state: "detached", timeout: 3000 }).catch(() => assert.fail("Keep open leaves the look bar"));
        assert.deepEqual((await savedTabs()).remote!.open.find((each) => each.cwd === "/tmp/fictional-repo")!.tabs, [SESSION, "fictional-session-old"], "Keep open saves it as the strip's last tab");
        await page.locator(`.tab-strip .host-chat-tab[data-host-session="${SESSION}"] [role="tab"]`).click();
        await page.locator(`.host-chat[data-host-session="${SESSION}"]`).waitFor();
        assert.equal(await oldTab.count(), 1, "a kept tab stays after leaving it");
        // Close tab: the tab goes, the chat is kept (not archived), and the strip moves on to a neighbour
        await oldTab.locator('[role="tab"]').click();
        await page.locator('.host-chat[data-host-session="fictional-session-old"]').waitFor();
        await oldTab.getByRole("button", { name: /^Actions for / }).click();
        await page.locator(".row-sheet").getByRole("button", { name: "Close tab", exact: true }).click();
        await oldTab.waitFor({ state: "detached", timeout: 3000 }).catch(() => assert.fail("Close tab leaves the tab"));
        await page.locator(`.host-chat[data-host-session="${SESSION}"]`).waitFor({ timeout: 3000 }).catch(() => assert.fail("closing the tab on screen does not move to its neighbour"));
        assert.equal(await page.evaluate(() => (window as unknown as { hostEdits: { archived: Record<string, boolean> } }).hostEdits.archived["fictional-session-old"]), undefined, "Close tab archives nothing");
        // the docs workspace's only tab: closing it closes the workspace, and its row leaves the sidebar
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-docs"] .workspace-select').click();
        const docsTab = page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-session-0"]');
        await docsTab.getByRole("button", { name: /^Actions for / }).click();
        await page.locator(".row-sheet").getByRole("button", { name: "Close tab", exact: true }).click();
        await docsTab.waitFor({ state: "detached", timeout: 3000 });
        assert.ok(!(await savedTabs()).remote!.open.some((each) => each.cwd === "/tmp/fictional-docs"), "the last tab closes its workspace");
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        assert.equal(await remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-docs"]').count(), 0, "a closed workspace has no row");
        await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
        // the docs folder open again, for what follows: Keep open on a look reopens its workspace
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        await all.waitFor();
        await all.locator('[data-host-session="fictional-session-0"] .agent-select').click();
        await all.waitFor({ state: "detached" });
        await keepOpen.click();
        await page.locator(".host-chat .look-bar").waitFor({ state: "detached" });
        assert.ok((await savedTabs()).remote!.open.some((each) => each.cwd === "/tmp/fictional-docs"), "Keep open opens its workspace");
        await page.locator(`.tab-strip .host-chat-tab[data-host-session="${SESSION}"]`).waitFor({ state: "attached" }).catch(() => undefined);
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await remoteGroup.locator(".workspace-group").first().locator(".workspace-select").click();
        console.log("PASS a listed chat opens as a look (saved nowhere, gone on leaving), Keep open makes it a tab, Close tab hides it and the last closes its workspace");

        // 6e. agent host workspaces open and close as herdr's: New workspace → the agent host lists the
        // folders its chats work in; picking one opens it (no chat made). Its ⋯ holds what is about the
        // folder: Chats in <folder>… (that folder's chats, archived too) and Close workspace, which
        // leaves its chats as they are. The PC's whole list stays on the Agents menu.
        const openList = async () => {
          await drawerOpen();
          await remoteGroup.getByRole("button", { name: "New workspace on Build PC", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "New workspace · Build PC" });
          await dialog.waitFor();
          const trigger = dialog.locator(".agent-picker-trigger");
          if (!(await trigger.innerText()).includes("Agent host")) {
            await trigger.click();
            await page.getByRole("option", { name: "Agent host" }).click({ timeout: 10_000 });
          }
          return dialog;
        };
        const docsRow = remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-docs"]');
        const folderMenu = async () => {
          await drawerOpen();
          await docsRow.getByRole("button", { name: "More for fictional-docs", exact: true }).click();
          await page.locator(".row-sheet").waitFor();
        };
        // the docs folder's ⋯: about the folder only
        await folderMenu();
        assert.deepEqual(await sheetItems(), ["New agent host chat…", "Chats in fictional-docs…", "Pin folder", "Close workspace", "Copy path"], "the folder's menu: new chat, its chats, pin, close, copy path");
        // the row's face is its folder; Copilot's mark leads the name once, as an agent's leads herdr's rows
        assert.equal(await docsRow.locator('.host-folder-face .workspace-folder').count(), 1, "a folder row's face is a folder");
        assert.equal(await docsRow.locator('.workspace-select > .sidebar-mark svg[aria-label="copilot"]').count(), 1, "Copilot's mark leads the name");
        assert.equal(await docsRow.locator('svg[aria-label="copilot"]').count(), 1, "Copilot's mark once");
        if (shots) await docsRow.screenshot({ path: join(shots, "folder-row-mark.png") });
        // New agent host chat… is a new chat in that folder: no folder list to open it as a workspace
        await page.locator(".row-sheet").getByRole("button", { name: "New agent host chat…", exact: true }).click();
        const chatIn = page.getByRole("dialog", { name: "New chat · fictional-docs", exact: true });
        await chatIn.waitFor({ timeout: 5000 }).catch(() => assert.fail("the folder's New agent host chat… is titled New chat · <folder>"));
        assert.equal(await chatIn.getByRole("radiogroup", { name: "Folders with chats" }).count(), 0, "no folder list: the folder is given");
        assert.equal(await chatIn.getByRole("textbox", { name: "Directory" }).inputValue(), "/tmp/fictional-docs");
        assert.equal(await chatIn.getByRole("button", { name: "Start", exact: true }).count(), 1, "Start makes the chat");
        assert.equal(await chatIn.getByRole("button", { name: "Open workspace", exact: true }).count(), 0);
        if (shots) await page.screenshot({ path: join(shots, "new-chat-in-folder-390.png") });
        await chatIn.getByRole("button", { name: "Cancel", exact: true }).click();
        await chatIn.waitFor({ state: "detached" });
        await folderMenu();
        await page.locator(".row-sheet").getByRole("button", { name: "Chats in fictional-docs…", exact: true }).click();
        const folderChats = page.getByRole("dialog", { name: "Chats in fictional-docs", exact: true });
        await folderChats.waitFor();
        assert.deepEqual(await folderChats.locator(".host-chat-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-host-session"))), ["fictional-session-0"], "only the folder's chats");
        assert.equal(await folderChats.getByRole("radiogroup", { name: "Folders" }).count(), 0, "no folder pills in one folder's list");
        await folderChats.getByRole("button", { name: "Close dialog" }).click();
        await folderChats.waitFor({ state: "detached" });
        // Close workspace: the row goes, the chat is kept
        await folderMenu();
        await page.locator(".row-sheet").getByRole("button", { name: "Close workspace", exact: true }).click();
        await docsRow.waitFor({ state: "detached", timeout: 3000 }).catch(() => assert.fail("Close workspace leaves its row"));
        assert.equal(await page.evaluate(() => (window as unknown as { hostEdits: { archived: Record<string, boolean> } }).hostEdits.archived["fictional-session-0"]), undefined, "Close workspace archives nothing");
        await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
        // the PC's whole list is still on the Agents menu
        await agentsMenu();
        assert.equal(await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).count(), 1, "All agents stays on the Agents menu");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Close workspace list", exact: true }).click().catch(() => undefined);
        // New workspace → agent host: the folders, newest first, each with its count; the open one says so
        const newBefore = (await posts("/api/machines/remote/host-chats/chat/new")).length;
        let listDialog = await openList();
        const folderRows = listDialog.getByRole("radiogroup", { name: "Folders with chats" }).getByRole("radio");
        await folderRows.first().waitFor();
        const folderTexts = (await folderRows.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
        // the repo's newest chat is the newest anywhere: it leads; the archived chat is not counted
        assert.match(folderTexts[0] ?? "", /^fictional-repo Open \/tmp\/fictional-repo 2 chats · \S/, "the open repo first: name, Open, path, its two chats, the newest's age");
        assert.match(folderTexts[1] ?? "", /^fictional-docs \/tmp\/fictional-docs 1 chat · \S/, "then the closed docs folder with its one chat");
        assert.equal(folderTexts.length, 2, "one row per folder");
        await fits("the agent host folder list");
        await folderRows.filter({ hasText: "fictional-docs" }).click();
        assert.equal(await listDialog.getByRole("button", { name: "Open workspace", exact: true }).count(), 1, "a picked folder can open as a workspace");
        assert.equal(await listDialog.getByRole("button", { name: "New chat", exact: true }).getAttribute("type"), "submit", "and a new chat there stays the dialog's action (Enter)");
        if (shots) await page.screenshot({ path: join(shots, "agent-host-folders-390.png") });
        await listDialog.getByRole("button", { name: "Open workspace", exact: true }).click();
        await listDialog.waitFor({ state: "detached" });
        await page.locator('.host-chat[data-host-session="fictional-session-0"]').waitFor();
        assert.equal((await posts("/api/machines/remote/host-chats/chat/new")).length, newBefore, "opening a folder makes no chat");
        await drawerOpen();
        await docsRow.waitFor({ timeout: 3000 }).catch(() => assert.fail("the opened folder has no row"));
        // one order with herdr's workspaces: the folder row moves above the herdr group before it, and
        // the move is the PC's saved order (another page of the same browser draws it the same way)
        const restOrder = async (target = page) => target.getByRole("region", { name: "PC Build PC", exact: true }).locator(".sidebar-list > .workspace-list:not(.sidebar-pinned) > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace ?? ""));
        const orderBefore = await restOrder();
        const docsAt = orderBefore.indexOf("f:/tmp/fictional-docs");
        assert.ok(docsAt > 0 && !orderBefore[docsAt - 1]!.startsWith("f:"), `a herdr group stands above the opened folder (${orderBefore.join(", ")})`);
        const movesBefore = await page.evaluate(() => ((window as unknown as { hostCalls: { moves?: string[] } }).hostCalls.moves ?? []).length);
        await docsRow.locator(".workspace-select").focus();
        await page.keyboard.press("Alt+ArrowUp");
        const expected = [...orderBefore.slice(0, docsAt - 1), orderBefore[docsAt]!, orderBefore[docsAt - 1]!, ...orderBefore.slice(docsAt + 1)];
        await page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('[aria-label="PC Build PC"] .sidebar-list > .workspace-list:not(.sidebar-pinned) > .workspace-group')].map((row) => (row as HTMLElement).dataset.workspace)) === want, JSON.stringify(expected), { timeout: 3000 }).catch(async () => assert.fail(`Alt+↑ moved the folder above ${orderBefore[docsAt - 1]} (before ${orderBefore.join(", ")}; now ${(await restOrder()).join(", ")}; saved ${JSON.stringify((await savedTabs()).remote)})`));
        assert.equal(await page.evaluate(() => ((window as unknown as { hostCalls: { moves?: string[] } }).hostCalls.moves ?? []).length), movesBefore, "a folder's move leaves herdr's order alone");
        assert.deepEqual((await savedTabs()).remote?.["order" as never], expected.filter((id) => id !== "").map((id) => id.startsWith("f:") ? id : `w:${id}`), "the merged order is saved for the PC");
        const otherPage = await page.context().newPage();
        await otherPage.goto(page.url());
        await otherPage.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await otherPage.locator('[data-host-folder="/tmp/fictional-docs"]').first().waitFor();
        assert.deepEqual(await restOrder(otherPage), expected, "the order holds on another page");
        await otherPage.close();
        console.log("PASS an agent host workspace moves among herdr's workspaces (Alt+↑), and the order is saved");
        {
        // herdr's tree: a worktree's folder sits under its repository's folder row, whose face folds
        // it; a repository whose folder is not open gets a header row holding its worktrees
        await page.evaluate(() => {
          sessionStorage.setItem("fictional-worktrees", "1");
          const key = "herdr-web-ui:host-workspaces";
          const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
          // two worktrees' folders: one of the open docs folder's repository, one whose repository's folder is not open
          saved.remote.open.push({ cwd: "/tmp/fictional-docs.wt/feat-a", tabs: ["fictional-wt-a"] }, { cwd: "/tmp/fictional-lib.wt/fix-x", tabs: ["fictional-wt-x"] }, { cwd: "/home/fictional/.copilot/chats", tabs: ["fictional-lost"] });
          localStorage.setItem(key, JSON.stringify(saved));
        });
        await page.reload();
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        const repoRow = remoteGroup.locator('.host-folder[data-host-folder="/tmp/fictional-docs"]');
        const childRow = remoteGroup.locator('.worktree-children .host-folder[data-host-folder="/tmp/fictional-docs.wt/feat-a"]');
        await childRow.waitFor({ timeout: 20000 }).catch(() => assert.fail("the worktree's folder sits under its repository's row"));
        assert.equal(await remoteGroup.locator('.sidebar-list > .workspace-list:not(.sidebar-pinned) > .host-folder[data-host-folder="/tmp/fictional-docs.wt/feat-a"]').count(), 0, "not a top-level row");
        const repoRowWithChild = await repoRow.evaluate((row) => row.nextElementSibling?.querySelector('[data-host-folder="/tmp/fictional-docs.wt/feat-a"]') !== null);
        assert.ok(repoRowWithChild, "right under the repository's row");
        const header = remoteGroup.locator('.host-repo[data-host-repo="/tmp/fictional-lib"]');
        await header.waitFor({ timeout: 3000 }).catch(() => assert.fail("a repository with only worktrees open has a header row"));
        assert.equal(await header.evaluate((row) => row.nextElementSibling?.querySelector('[data-host-folder="/tmp/fictional-lib.wt/fix-x"]') !== null), true, "holding its worktree");
        // branches as herdr's rows say them: the repository's under its name, a worktree's beside it
        assert.equal(await repoRow.locator(".workspace-branch").innerText(), "main", "the repository's row says its branch on a second line");
        assert.equal(await childRow.locator(".worktree-workspace-label").innerText(), "feat/fictional-a", "a worktree's row says its branch beside its name");
        // a chat VS Code gave no folder: one "No folder" row, not its scratch folder's id
        const lost = remoteGroup.locator('.host-folder[data-host-folder="/home/fictional/.copilot/chats"]');
        await lost.waitFor({ timeout: 3000 }).catch(() => assert.fail("a chat with no folder has a row"));
        assert.equal(await lost.locator(".workspace-name").innerText(), "No folder", "named No folder");
        await lost.getByRole("button", { name: "More for No folder", exact: true }).click();
        await page.locator(".row-sheet").waitFor();
        assert.deepEqual(await sheetItems(), ["Chats in No folder…", "Pin folder", "Close workspace"], "no new chat there, no path to copy");
        assert.match(await page.locator(".row-sheet").innerText(), /VS Code gave these chats no folder/, "the menu says why");
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "hidden" });
        // the face folds: the worktree hides, the row counts it, and opening it again shows it
        const fold = repoRow.getByRole("button", { name: "Collapse worktrees of fictional-docs", exact: true });
        await fold.click();
        await childRow.waitFor({ state: "hidden", timeout: 3000 }).catch(() => assert.fail("folding hides the worktree"));
        assert.equal(await repoRow.locator(".workspace-fold-count").innerText(), "+1");
        await repoRow.getByRole("button", { name: "Expand worktrees of fictional-docs", exact: true }).click();
        await childRow.waitFor();
        // the repository's row moves with its worktree under it
        const top = async () => remoteGroup.locator(".sidebar-list > .workspace-list:not(.sidebar-pinned) > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace ?? ""));
        const before = await top();
        const at = before.indexOf("f:/tmp/fictional-docs");
        assert.ok(at > 0, `the repository's row has a row above it (${before.join(", ")})`);
        await repoRow.locator(".workspace-select").focus();
        await page.keyboard.press("Alt+ArrowUp");
        await page.waitForFunction((want) => [...document.querySelectorAll('[aria-label="PC Build PC"] .sidebar-list > .workspace-list:not(.sidebar-pinned) > .workspace-group')].map((row) => (row as HTMLElement).dataset.workspace).indexOf("f:/tmp/fictional-docs") === want, at - 1, { timeout: 3000 }).catch(async () => assert.fail(`Alt+↑ moves the repository's row up (${(await top()).join(", ")})`));
        assert.equal(await repoRow.evaluate((row) => row.nextElementSibling?.querySelector('[data-host-folder="/tmp/fictional-docs.wt/feat-a"]') !== null), true, "its worktree moved with it");
        const saved = (await savedTabs()).remote?.["order" as never] as unknown as string[];
        assert.equal(saved.indexOf("f:/tmp/fictional-docs.wt/feat-a"), saved.indexOf("f:/tmp/fictional-docs") + 1, `the saved order keeps the worktree after its repository (${saved.join(", ")})`);
        if (shots) await page.screenshot({ path: join(shots, "agent-host-worktree-tree-390.png") });
        await page.evaluate(() => {
          sessionStorage.removeItem("fictional-worktrees");
          const key = "herdr-web-ui:host-workspaces";
          const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
          saved.remote.open = saved.remote.open.filter((folder: { cwd: string }) => !folder.cwd.includes(".wt/") && !folder.cwd.includes(".copilot/chats"));
          localStorage.setItem(key, JSON.stringify(saved));
        });
        await page.reload();
        console.log("PASS herdr's tree: a worktree's folder under its repository's row (folded by its face, moved with it, branches said as herdr's), a header row for a repository with only worktrees open, and one No folder row");
        }
        await drawerOpen();
        await remoteGroup.locator(".workspace-group").first().locator(".workspace-select").click();
        // typing another folder after a pick starts a chat again, as before
        listDialog = await openList();
        await listDialog.getByRole("radiogroup", { name: "Folders with chats" }).getByRole("radio").filter({ hasText: "fictional-docs" }).click();
        await listDialog.getByRole("textbox", { name: "Directory" }).fill("/tmp/fictional-elsewhere");
        assert.equal(await listDialog.getByRole("button", { name: "Start", exact: true }).count(), 1, "a typed folder starts a chat");
        await listDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await listDialog.waitFor({ state: "detached" });
        console.log("PASS agent host workspaces open from New workspace (no chat made), their ⋯ lists the folder's chats and closes them, and All agents stays on the Agents menu");

        // 7. the PC's "+" with Agent host picked: VS Code's New Chat. The dialog asks the folder
        // only; Start makes the chat empty and opens it, and its first message is written in the
        // chat's own composer (the same one every chat has: pills, "/", attach, dictation, send menu)
        const newChats = () => posts("/api/machines/remote/host-chats/chat/new");
        const openNewSheet = async () => {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await remoteGroup.getByRole("button", { name: "New workspace on Build PC", exact: true }).click();
          const form = page.getByRole("dialog", { name: "New workspace · Build PC" });
          await form.waitFor();
          // the PC's agents come in a moment after the dialog opens; the picker remembers the last one
          const pick = form.locator(".agent-picker-trigger");
          if (!(await pick.innerText()).includes("Agent host")) {
            await pick.click();
            await page.getByRole("option", { name: "Agent host" }).click({ timeout: 10_000 });
          }
          return form;
        };
        let form = await openNewSheet();
        const agentPick = form.locator(".agent-picker-trigger, [aria-labelledby=\"new-session-agent\"]").first();
        await agentPick.filter({ hasText: "Agent host" }).waitFor({ timeout: 10_000 }).catch(async () => assert.fail(`the dialog opens on Agent host, not ${await agentPick.innerText()}`));
        assert.equal(await form.getByRole("textbox", { name: "Name" }).count(), 0, "a host chat has no name field");
        assert.equal(await form.getByRole("textbox", { name: "First message" }).count(), 0, "no second composer in the dialog: the chat's own takes the first message");
        const folder = form.getByRole("textbox", { name: "Directory" });
        // a folder typed (not picked from the list) starts a chat there
        await folder.fill("/tmp/fictional-repo");
        assert.equal(await form.getByRole("button", { name: "Start", exact: true }).count(), 1, "a typed folder starts a chat");
        await fits("the new-chat dialog");
        if (shots) await page.screenshot({ path: join(shots, "task-11-new-chat-390.png") });
        await form.getByRole("button", { name: "Start", exact: true }).click();
        const made = page.locator('.host-chat[data-host-session="fictional-new-1"]');
        await made.waitFor();
        assert.equal(await form.count(), 0, "the dialog closes on the chat made");
        assert.deepEqual((await newChats()).map(bare), [{ cwd: "/tmp/fictional-repo" }], "one chat/new with the folder alone: the chat is made empty");
        // the empty chat greets with Copilot's mark and has the composer every chat has
        await made.locator(".chat-empty").waitFor();
        assert.equal(await made.locator('.chat-empty svg[aria-label="copilot"]').count(), 1, "the empty chat wears Copilot's mark");
        assert.equal(await page.locator('svg[aria-label="vscode"]').count(), 0, "no VS Code mark anywhere");
        for (const pill of [".host-chat-model", ".host-chat-agent"]) assert.equal(await made.locator(`.composer ${pill}`).count(), 1, `the composer's ${pill} pill`);
        assert.equal(await made.locator(".composer .composer-attach").count(), 1, "attach, as any chat");
        assert.equal(await made.locator(".composer .voice-mic").count(), 1, "dictation, as any chat");
        // the first message goes from that composer, once, as a chat/send of that chat
        const sendsBefore = (await posts("/api/machines/remote/host-chats/chat/send")).length;
        await made.getByRole("textbox", { name: "Message" }).fill("FICTIONAL first");
        await made.getByRole("button", { name: "Send message", exact: true }).click();
        await made.locator(".chat-turn-user", { hasText: "FICTIONAL first" }).waitFor();
        const firstSends = (await posts("/api/machines/remote/host-chats/chat/send")).slice(sendsBefore);
        assert.equal(firstSends.length, 1, "one send");
        assert.equal(firstSends[0]!.body["session"], "fictional-new-1", "to the chat made");
        assert.equal(firstSends[0]!.body["text"], "FICTIONAL first");
        // the header names where the chat works (its tab names the chat): Copilot's mark, the folder, the PC, Chat pressed, Terminal off
        const header = page.locator(".app-header");
        await header.locator(".context-title-text", { hasText: "fictional-repo" }).waitFor();
        assert.equal(await header.locator('.context-title svg[aria-label="copilot"]').count(), 1, "the header wears Copilot's mark");
        assert.deepEqual((await header.locator(".context-sub > span").allInnerTexts()).map((text) => text.trim()).filter((text) => text !== "›"), ["Build PC"], "the crumb is the PC: the folder is the header's name already");
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
        assert.equal((await posts("/api/machines/remote/host-chats/chat/discard")).length, 0, "a chat with a message is never discarded");
        console.log("PASS the PC's + on Agent host: the chat made empty, its first message from its own composer");

        // 7b. a new chat left without a message goes: leaving it asks the bridge to discard it, once
        form = await openNewSheet();
        await form.getByRole("textbox", { name: "Directory" }).fill("/tmp/fictional-repo");
        await form.getByRole("button", { name: "Start", exact: true }).click();
        const kept = page.locator('.host-chat[data-host-session="fictional-new-2"]');
        await kept.waitFor();
        await kept.locator(".chat-empty").waitFor();
        assert.equal((await newChats()).length, 2, "exactly one chat/new for this tap");
        // left for a pane's tab: the empty chat is discarded
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null && document.querySelector(".new-session-modal") === null);
        // the new chat has no workspace yet (no tab strip): the sidebar opens the first chat again
        if (shots) await page.screenshot({ path: join(shots, "r6-empty-chat-390.png") });
        await page.waitForFunction(() => document.querySelector(".new-session-modal") === null);
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        await all.waitFor();
        await all.locator(`.host-chat-item[data-host-session="${SESSION}"] .agent-select`).click();
        await kept.waitFor({ state: "detached" });
        const discards = async () => (await posts("/api/machines/remote/host-chats/chat/discard")).map((post) => post.body);
        for (let tries = 0; tries < 30 && (await discards()).length === 0; tries++) await page.waitForTimeout(100);
        assert.deepEqual(await discards(), [{ session: "fictional-new-2" }], "the empty chat left is discarded, once");
        assert.equal((await posts("/api/machines/remote/host-chats/chat/send")).length, sendsBefore + 1, "nothing is sent on the user's behalf");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS a new chat left without a message is discarded, and nothing is sent for it");

        // another chat, given its first message, for the chat actions below
        form = await openNewSheet();
        await form.getByRole("textbox", { name: "Directory" }).fill("/tmp/fictional-repo");
        await form.getByRole("button", { name: "Start", exact: true }).click();
        const kept3 = page.locator('.host-chat[data-host-session="fictional-new-3"]');
        await kept3.waitFor();
        await kept3.getByRole("textbox", { name: "Message" }).fill("FICTIONAL second chat");
        await kept3.getByRole("button", { name: "Send message", exact: true }).click();
        await kept3.locator(".chat-turn-user", { hasText: "FICTIONAL second chat" }).waitFor();

        // 7c. a chat's own actions (Task 7): rename from its tab's menu and the header's ⋯, mark it
        // unread (and a refusal undone), mark it done, delete it; a pane's tab keeps its own menu
        const keptTab = page.locator('.tab-strip .host-chat-tab[data-host-session="fictional-new-3"]');
        const actionPosts = async (route: string) => (await posts(`/api/machines/remote/host-chats/chat/${route}`)).map((post) => post.body);
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
        assert.deepEqual(await sheetItems(), ["Pin agent", "Rename…", "Mark as unread", "Close tab", "Mark as done", "Delete…"], "the chat's menu: pin, rename, unread, close tab, done, delete");
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
        // the chat is a tab of its workspace now: the header names the workspace, never the chat's new name
        assert.equal((await page.locator(".app-header .context-title-text").innerText()).trim(), "checkout-api", "the header names the chat's workspace, not its new name");
        assert.deepEqual(await actionPosts("rename"), [{ session: "fictional-new-3", title: "FICTIONAL renamed chat" }], "one rename, trimmed, never the empty one");
        // a herdr workspace with chat tabs keeps its own header ⋯ (a pane's): the chat's actions are its tab's
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.locator(".row-sheet").waitFor();
        const workspaceItems = await sheetItems();
        assert.ok(workspaceItems.includes("Search panes and actions") && !workspaceItems.includes("New agent host chat…") && !workspaceItems.includes("Rename…"), `a herdr workspace's header ⋯ is its own: ${JSON.stringify(workspaceItems)}`);
        await page.keyboard.press("Escape");
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL renamed chat" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Rename…" }).click();
        await nameField.fill("FICTIONAL named in the header");
        await nameField.press("Enter");
        await keptTab.locator(".tab-strip-label", { hasText: "FICTIONAL named in the header" }).waitFor();
        assert.equal((await actionPosts("rename")).length, 2, "the second rename went too");
        console.log("PASS rename from the tab's menu, twice: the new title on the tab, and the workspace keeps its own ⋯");

        // read and unread: shown at once; a refusal puts it back and says so
        await keptTab.getByRole("button", { name: "Actions for FICTIONAL named in the header" }).click();
        await page.locator(".row-sheet .row-sheet-item", { hasText: "Mark as unread" }).click();
        await keptTab.locator('.tab-strip-dot[data-status="done"]').waitFor();
        assert.deepEqual((await actionPosts("read")).filter((body) => body["session"] === "fictional-new-3"), [{ session: "fictional-new-3", read: false }], "marked unread, and kept so while open");
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
        await kept3.waitFor({ state: "detached" });
        assert.deepEqual((await actionPosts("archive")).filter((post) => (post as { session?: string }).session !== "fictional-session-done"), [{ session: "fictional-new-3", archived: true }]);
        await agentsMenu();
        await page.getByRole("button", { name: "All agents on Build PC…", exact: true }).click();
        await all.waitFor();
        await all.getByRole("button", { name: "Archived" }).click();
        const archivedRow = all.getByRole("region", { name: "Archived" }).locator('[data-host-session="fictional-new-3"]');
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

        // 7d. VS Code's Fork Conversation: on every request but the first, beside Restore; a fork
        // that fails says why in the bar over the box; one that goes opens the new chat as a tab
        if (await page.locator("#workspace-drawer.is-open").count() > 0) await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector("#workspace-drawer.is-open") === null);
        await page.locator(`.tab-strip .host-chat-tab[data-host-session="${SESSION}"] [role="tab"]`).click();
        await view.waitFor();
        const firstForkAsk = view.locator(".chat-turn-user", { hasText: "FICTIONAL an earlier ask" });
        // the list draws what is in view: the chat's first request is at its top
        for (let tries = 0; tries < 20 && await firstForkAsk.count() === 0; tries++) {
          await view.locator(".chat-view").evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
          await page.waitForTimeout(100);
        }
        await firstForkAsk.waitFor();
        assert.equal(await firstForkAsk.getByRole("button", { name: "Fork Conversation" }).count(), 0, "the first request has nothing before it to fork");
        const forkAsk = view.locator(".chat-turn-user", { hasText: "FICTIONAL look at the build" });
        await forkAsk.scrollIntoViewIfNeeded();
        const forkButton = forkAsk.getByRole("button", { name: "Fork Conversation" });
        assert.equal(await forkButton.count(), 1, "a later request offers Fork Conversation");
        const meta = await forkAsk.locator(".chat-turn-meta").evaluate((node) => [...node.querySelectorAll("button")].map((each) => each.getAttribute("aria-label")));
        assert.deepEqual(meta, ["Restore Checkpoint", "Fork Conversation", "Copy message"], "Fork sits between Restore and Copy");
        await page.evaluate(() => { (window as unknown as { hostState: { failFork: boolean } }).hostState.failFork = true; });
        await forkButton.click();
        const forkBar = view.locator(".fork-bar");
        await forkBar.locator(".checkpoint-bar-error", { hasText: "FICTIONAL nothing to fork" }).waitFor();
        assert.equal((await forkBar.locator(".checkpoint-bar-text").innerText()).trim(), "Couldn't fork the conversation");
        await fits("the fork error");
        if (shots) await page.screenshot({ path: join(shots, "r8-fork-error-390.png") });
        await forkBar.getByRole("button", { name: "Dismiss" }).click();
        await forkBar.waitFor({ state: "detached" });
        await page.evaluate(() => { (window as unknown as { hostState: { failFork: boolean } }).hostState.failFork = false; });
        await forkButton.click();
        const forked = page.locator('.host-chat[data-host-session^="fictional-fork-"]');
        await forked.waitFor();
        const forkPosts = (await posts("/api/machines/remote/host-chats/chat/fork")).map((post) => post.body);
        assert.equal(forkPosts.length, 2, "two forks asked: the refused one and this one");
        assert.deepEqual(forkPosts.map((body) => [body["session"], body["turn"]]), [[SESSION, "h1"], [SESSION, "h1"]], "forked at that request");
        assert.ok(forkPosts.every((body) => /^[0-9a-f-]{36}$/.test(String(body["id"]))) && forkPosts[0]!["id"] !== forkPosts[1]!["id"], "each fork carries its own id");
        await page.evaluate(() => (window as unknown as { pushHostList(): void }).pushHostList());
        await page.locator('.tab-strip .host-chat-tab[data-host-session^="fictional-fork-"] .tab-strip-label', { hasText: "FICTIONAL forked chat" }).waitFor();
        assert.equal(await view.count(), 0, "the fork replaced the chat it came from on screen");
        await fits("the forked chat");
        if (shots) await page.screenshot({ path: join(shots, "r8-forked-390.png") });
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS Fork Conversation is offered on later requests, says why when refused, and opens the fork as a tab");

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
        // a host chat's alert links to it (an ntfy tap, a tapped push on a cold start): the address opens
        // the chat on its PC, then lets the chat go from the address
        await six.goto(`http://127.0.0.1:${server.port}/?machine=remote&chat=${encodeURIComponent("fictional-session-old")}`);
        await six.locator('.host-chat[data-host-session="fictional-session-old"]').waitFor({ timeout: 10_000 }).catch(() => assert.fail("a chat's link opens nothing"));
        assert.ok(!new URL(six.url()).searchParams.has("chat"), "the chat leaves the address once open");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS a host chat's alert link opens the chat on its PC");
      } finally { await sixContext.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
