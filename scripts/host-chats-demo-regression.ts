import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// One fictional host chat on a remote demo PC, at 390 px: the sidebar group, the chat's rows,
// the question card, the model · effort and agent pills with their sheet, a send that queues, and
// "+ New Copilot chat" (made and sent, and made with its first message not sent).
// The roster's `remote` is the fixture's `local` cloned; this patched fetch answers that PC's
// /api/host-chats routes itself and records what the app posts. No live session or agent host is read.
// HOST_CHATS_SHOTS=<dir> also saves the chat, the open sheet and the new-chat sheet as screenshots.
const SESSION = "fictional-session-1";
const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
const app = mkdtempSync(join(tmpdir(), "herdr-agent-host-chats-"));
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const SESSION = ${JSON.stringify(SESSION)}, REPORT = ${JSON.stringify(REPORT)};
  const calls = window.hostCalls = { posts: [], models: [] };
  const state = window.hostState = { answered: false, busy: false, model: { id: "fictional/model-a", effort: null }, agent: null, sent: [], created: [], newSent: true, failNextSend: false, older: false, pushed: [] };
  const sources = new Set();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const roster = (original) => ["local", "remote"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Build PC";
    machine.state = "connected";
    return machine;
  });
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const read = (session, before) => {
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
        { kind: "tool", name: "runInTerminal", summary: "FICTIONAL make test", input: "{}", output: "FICTIONAL ok" },
        { kind: "text", text: "FICTIONAL the build passes." },
      ] },
      { role: "user", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL what next" }] },
      { role: "assistant", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL which way should I go?" }] },
    ];
    for (const text of state.pushed) turns.push({ role: "user", ts: at(1), parts: [{ kind: "text", text: "FICTIONAL from the PC" }] }, { role: "assistant", ts: at(1), parts: [{ kind: "text", text }] });
    for (const text of state.sent) turns.push({ role: "user", ts: at(0), parts: [{ kind: "text", text }] }, { role: "assistant", ts: at(0), parts: [] });
    const ids = [...(state.older ? ["h0"] : []), "h1", "h2", ...state.pushed.map((_, index) => "p" + index), ...state.sent.map((_, index) => "s" + index)];
    const prompt = state.answered ? null : {
      id: "req-1:q-1", agent: "copilot", kind: "question", title: "FICTIONAL direction", question: "FICTIONAL pick a direction",
      body: null, options: [{ label: "FICTIONAL north", description: null }, { label: "FICTIONAL south", description: null }, { label: "FICTIONAL east", description: null }],
      multi_select: false, custom_option_index: null,
      host: { request_id: "req-1", question_id: "q-1", option_ids: ["opt-north", "opt-south", "opt-east"] },
    };
    return { session: SESSION, title: "FICTIONAL build chat", status: prompt ? "asks" : state.busy ? "working" : "idle", turns, cursor: state.older ? null : "c-older", prompt,
      model: state.model, agent: state.agent, busy: state.busy || prompt !== null, message_ids: ids,
      signature: JSON.stringify([state.answered, state.busy, state.sent, state.model, state.agent, state.older, state.pushed]) };
  };
  const push = (message) => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote", message }) }));
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
    if (machine === "remote" && path.startsWith("/api/host-chats/")) {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (init?.method === "POST") calls.posts.push({ path: url.pathname, body });
      if (path === "/api/host-chats/state") return json({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
      if (path === "/api/host-chats/chats") return json({ chats: [
        { session: SESSION, title: "FICTIONAL build chat", status: state.answered ? (state.busy ? "working" : "idle") : "asks", modified_at: at(2), cwd: "/tmp/fictional-repo" },
        { session: "fictional-session-0", title: "FICTIONAL docs chat", status: "idle", modified_at: at(60 * 30), cwd: "/tmp/fictional-docs" },
        ...state.created.map((chat) => ({ session: chat.session, title: "FICTIONAL new chat", status: "idle", modified_at: at(0), cwd: chat.cwd })),
      ] });
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
      if (path === "/api/host-chats/chat/answer") { state.answered = true; return json({ ok: true }); }
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

        // 1. the sidebar's group under the PC, still with the vscode mark (Task 6 drops it)
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.getByRole("heading", { name: "Copilot", exact: true }).first().waitFor();
        assert.equal(await page.getByRole("region", { name: "Copilot on Build PC", exact: true }).count(), 1, "the group's landmark names its PC");
        const row = page.locator(`.host-chat-item[data-machine="remote"][data-host-session="${SESSION}"]`).first();
        await row.waitFor();
        assert.equal(await row.locator('svg[aria-label="vscode"]').count(), 1, "the chat's row wears the vscode mark until the sidebar redraw (Task 6)");
        assert.equal(await page.locator('.host-chat-item[data-machine="local"]').count(), 0, "a PC whose bridge has the feature off has no chats");
        console.log("PASS the sidebar shows the remote PC's host chats under it, headed Copilot");

        // 2. the chat: the app's ChatView, with a user turn, an assistant's text and a folded tool row
        await row.locator(".agent-select").click();
        const view = page.locator(`.host-chat[data-host-session="${SESSION}"]`);
        await view.waitFor();
        await view.locator(".chat-view").first().waitFor();
        assert.equal(await page.locator(".vscode-chat").count(), 0, "no chat view of its own");
        assert.equal(await view.locator('.chat-view[aria-label="Copilot chat FICTIONAL build chat"]').count(), 1, "one transcript, the app's ChatView, named for the chat");
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL look at the build" }).waitFor();
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).waitFor();
        const block = view.locator(".work-block").first();
        await block.waitFor();
        assert.match(await block.getAttribute("class") ?? "", /is-folded/, "the finished turn's tool work is folded");
        assert.equal(await block.locator(".work-row").count(), 0, "a folded block draws no tool rows");
        await block.locator(".work-block-head").click();
        await block.locator(".work-row", { hasText: "FICTIONAL make test" }).waitFor();
        await page.waitForFunction(() => (window as unknown as { hostCalls: { posts: { path: string }[] } }).hostCalls.posts.some((post) => post.path.endsWith("/host-chats/chat/watch")));
        await fits("the chat");
        if (shots) await page.screenshot({ path: join(shots, "task-5-chat-390.png") });
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
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL pushed answer" }).waitFor({ timeout: 5_000 });
        assert.equal(await view.locator(".chat-turn-agent", { hasText: "FICTIONAL an earlier answer" }).count(), 1, "the earlier page stays");
        // no scrollback, terminal output, prompt state or skill list is read for it: it has no pane
        assert.deepEqual(await page.evaluate(() => (window as unknown as { hostCalls: { paneless?: string[] } }).hostCalls.paneless ?? []), [], "no pane request for a host chat");
        console.log("PASS a pushed change appears in the chat");

        // 3. the question card answers with option 2, and goes on the next read
        const card = page.locator(".prompt-card");
        await card.getByRole("button", { name: /FICTIONAL south/ }).click();
        await card.waitFor({ state: "detached" });
        const answers = await posts("/api/machines/remote/host-chats/chat/answer");
        assert.deepEqual(answers.map((post) => post.body), [{ session: SESSION, request_id: "req-1", question_id: "q-1", option_ids: ["opt-south"] }], "option 2 is answered by its host id, once");
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

        // 7. "+ New Copilot chat" on the remote PC: a folder chip, a model, the first message, Start chat
        const newChats = () => posts("/api/machines/remote/host-chats/chat/new");
        const openNewSheet = async () => {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.getByRole("button", { name: "New Copilot chat on Build PC", exact: true }).click();
          const form = page.getByRole("dialog", { name: "New Copilot chat · Build PC" });
          await form.waitFor();
          return form;
        };
        assert.equal(await page.getByRole("button", { name: "New Copilot chat on Laptop" }).count(), 0, "a PC without the feature has no new-chat button");
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
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
