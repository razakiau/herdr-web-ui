import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// One fictional VS Code chat on a remote demo PC, at 390 px: the sidebar group, the chat's rows,
// the question card, the model · effort and agent pills with their sheet, and a send that queues.
// The roster's `remote` is the fixture's `local` cloned; this patched fetch answers that PC's
// /api/vscode routes itself and records what the app posts. No live session or VS Code is read.
// VSCODE_SHOTS=<dir> also saves the chat and the open sheet as screenshots.
const SESSION = "fictional-session-1";
const REPORT = "file:///tmp/fictional/agents/Report.agent.md";
const app = mkdtempSync(join(tmpdir(), "herdr-vscode-chats-"));
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const SESSION = ${JSON.stringify(SESSION)}, REPORT = ${JSON.stringify(REPORT)};
  const calls = window.vscodeCalls = { posts: [] };
  const state = window.vscodeState = { answered: false, busy: false, model: { id: "fictional/model-a", effort: null }, agent: null, sent: [] };
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
  const read = () => {
    const turns = [
      { role: "user", ts: at(9), parts: [{ kind: "text", text: "FICTIONAL look at the build" }] },
      { role: "assistant", ts: at(9), end_ts: at(8), parts: [
        { kind: "tool", name: "runInTerminal", summary: "FICTIONAL make test", input: "{}", output: "FICTIONAL ok" },
        { kind: "text", text: "FICTIONAL the build passes." },
      ] },
      { role: "user", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL what next" }] },
      { role: "assistant", ts: at(2), parts: [{ kind: "text", text: "FICTIONAL which way should I go?" }] },
    ];
    for (const text of state.sent) turns.push({ role: "user", ts: at(0), parts: [{ kind: "text", text }] }, { role: "assistant", ts: at(0), parts: [] });
    const prompt = state.answered ? null : {
      id: "req-1:q-1", agent: "vscode", kind: "question", title: "FICTIONAL direction", question: "FICTIONAL pick a direction",
      body: null, options: [{ label: "FICTIONAL north", description: null }, { label: "FICTIONAL south", description: null }, { label: "FICTIONAL east", description: null }],
      multi_select: false, custom_option_index: null,
      vscode: { request_id: "req-1", question_id: "q-1", option_ids: ["opt-north", "opt-south", "opt-east"] },
    };
    return { session: SESSION, title: "FICTIONAL build chat", status: prompt ? "asks" : state.busy ? "working" : "idle", turns, cursor: null, prompt,
      model: state.model, agent: state.agent, busy: state.busy || prompt !== null, signature: JSON.stringify([state.answered, state.busy, state.sent, state.model, state.agent]) };
  };
  const push = (message) => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "remote", message }) }));
  };
  window.setVscodeBusy = (busy) => { state.busy = busy; push({ type: "vscode-chat-changed", session: SESSION }); };
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
    if (machine === "remote" && path.startsWith("/api/vscode/")) {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (init?.method === "POST") calls.posts.push({ path: url.pathname, body });
      if (path === "/api/vscode/state") return json({ host: { state: "connected", signed_in: true, protocol: "1.0.0" } });
      if (path === "/api/vscode/chats") return json({ chats: [{ session: SESSION, title: "FICTIONAL build chat", status: state.answered ? (state.busy ? "working" : "idle") : "asks", modified_at: at(2), cwd: "/tmp/fictional-repo" }] });
      if (path === "/api/vscode/chat") return json(read());
      if (path === "/api/vscode/models") return json({
        models: [
          { id: "fictional-own", name: "FICTIONAL Own", efforts: null },
          { id: "fictional/model-a", name: "FICTIONAL Model A", efforts: null },
          { id: "fictional/model-b", name: "FICTIONAL Model B", efforts: { key: "thinkingLevel", values: ["low", "medium", "high"] } },
        ],
        agents: [{ uri: REPORT, name: "Report", description: "FICTIONAL writes a report" }],
      });
      if (path === "/api/vscode/chat/watch" || path === "/api/vscode/chat/draft" || path === "/api/vscode/chat/confirm") return json({ ok: true });
      if (path === "/api/vscode/chat/answer") { state.answered = true; return json({ ok: true }); }
      if (path === "/api/vscode/chat/send") {
        const queued = state.busy;
        state.sent.push(body.text);
        if (body.model) state.model = { id: body.model.id, effort: body.model.effort ?? null };
        if ("agent" in body) state.agent = body.agent;
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

const shots = process.env["VSCODE_SHOTS"];
try {
  await buildDemoApp(app);
  writeFileSync(join(app, "vscode-chats.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./vscode-chats.js"></script><script type="module"'));
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
        const posts = async (path: string): Promise<Post[]> => (await page.evaluate(() => (window as unknown as { vscodeCalls: { posts: Post[] } }).vscodeCalls.posts)).filter((post) => post.path === path);
        const fits = async (what: string) => {
          const width = await page.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(width <= 390, `${what}: no horizontal overflow at 390 px (scrollWidth ${width})`);
        };
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.locator(".conn-live").waitFor({ state: "attached" });

        // 1. the sidebar's group under the PC, with VS Code's mark
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.getByRole("heading", { name: "VS Code chats", exact: true }).first().waitFor();
        const row = page.locator(`.vscode-chat-item[data-machine="remote"][data-vscode-session="${SESSION}"]`).first();
        await row.waitFor();
        assert.equal(await row.locator('svg[aria-label="vscode"]').count(), 1, "the chat's row wears VS Code's mark");
        assert.equal(await page.locator('.vscode-chat-item[data-machine="local"]').count(), 0, "a PC whose bridge has the feature off has no chats");
        console.log("PASS the sidebar shows VS Code chats under the remote PC, with the VS Code mark");

        // 2. the chat: a user turn, an assistant's text and a folded tool row
        await row.locator(".agent-select").click();
        const view = page.locator(`.vscode-chat[data-vscode-session="${SESSION}"]`);
        await view.waitFor();
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL look at the build" }).waitFor();
        await view.locator(".chat-turn-agent", { hasText: "FICTIONAL the build passes." }).waitFor();
        const block = view.locator(".work-block").first();
        await block.waitFor();
        assert.match(await block.getAttribute("class") ?? "", /is-folded/, "the finished turn's tool work is folded");
        assert.equal(await block.locator(".work-row").count(), 0, "a folded block draws no tool rows");
        await block.locator(".work-block-head").click();
        await block.locator(".work-row", { hasText: "FICTIONAL make test" }).waitFor();
        await page.waitForFunction(() => (window as unknown as { vscodeCalls: { posts: { path: string }[] } }).vscodeCalls.posts.some((post) => post.path.endsWith("/vscode/chat/watch")));
        await fits("the chat");
        if (shots) await page.screenshot({ path: join(shots, "task-5-chat-390.png") });
        console.log("PASS the chat shows a user turn, an assistant text and a folded tool row, and is watched");

        // 3. the question card answers with option 2, and goes on the next read
        const card = page.locator(".prompt-card");
        await card.getByRole("button", { name: /FICTIONAL south/ }).click();
        await card.waitFor({ state: "detached" });
        const answers = await posts("/api/machines/remote/vscode/chat/answer");
        assert.deepEqual(answers.map((post) => post.body), [{ session: SESSION, request_id: "req-1", question_id: "q-1", option_ids: ["opt-south"] }], "option 2 is answered by its host id, once");
        console.log("PASS the question card answers option 2 with its option id and goes away");

        // 4. model · effort and agent picks, then Send
        const modelPill = view.locator(".vscode-chat-model");
        await modelPill.waitFor();
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model A/);
        await modelPill.click();
        const sheet = page.getByRole("dialog", { name: "Model and agent" });
        await sheet.waitFor();
        await sheet.locator('[data-model="fictional/model-b"]').waitFor();
        assert.deepEqual(await sheet.locator(".vscode-picker-group .vscode-picker-provider").allTextContents(), ["Copilot", "fictional"], "the host's own models (no provider in the id) stand first, as Copilot");
        await sheet.locator('[data-model="fictional/model-b"]').click();
        await sheet.locator('[data-effort="high"]').click();
        await sheet.waitFor({ state: "detached" });
        assert.match(await modelPill.textContent() ?? "", /FICTIONAL Model B.*high/, "the pill says the model and its effort");
        await view.locator(".vscode-chat-agent").click();
        await sheet.waitFor();
        assert.equal(await sheet.locator(".vscode-picker-option[data-agent]").first().textContent(), "Agent", '"Agent" comes first');
        await sheet.getByText("VS Code's agent picker does not follow this choice; a message typed in VS Code uses VS Code's agent.", { exact: true }).waitFor();
        // the sheet slides up from the bottom edge: measured and drawn once it has settled
        await page.waitForFunction(() => {
          const surface = document.querySelector(".vscode-picker");
          return surface !== null && surface.getBoundingClientRect().bottom <= window.innerHeight + 1 && surface.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        });
        await fits("the open sheet");
        if (shots) await page.screenshot({ path: join(shots, "task-5-sheet-390.png") });
        await sheet.locator(`[data-agent="${REPORT}"]`).click();
        await sheet.waitFor({ state: "detached" });
        assert.match(await view.locator(".vscode-chat-agent").textContent() ?? "", /Report/);
        const drafts = await posts("/api/machines/remote/vscode/chat/draft");
        assert.deepEqual(drafts.at(-1)?.body, { session: SESSION, model: { id: "fictional/model-b", effort: "high" } }, "the model pick is written to the chat's draft");
        const box = view.getByRole("textbox", { name: "Message" });
        await box.fill("FICTIONAL next");
        await view.getByRole("button", { name: "Send message" }).click();
        await view.locator(".chat-turn-user", { hasText: "FICTIONAL next" }).waitFor();
        const sends = await posts("/api/machines/remote/vscode/chat/send");
        assert.deepEqual(sends.map((post) => post.body), [{ session: SESSION, text: "FICTIONAL next", model: { id: "fictional/model-b", effort: "high" }, agent: REPORT }], "the send carries the model, its effort and the agent, once");
        assert.equal(await box.inputValue(), "", "a sent message leaves the box");
        console.log("PASS the pills pick model-b · high and Report; the send carries both and the draft the model");

        // 5. a busy chat: the composer says it works, and Send queues
        await page.evaluate(() => (window as unknown as { setVscodeBusy(busy: boolean): void }).setVscodeBusy(true));
        await view.locator(".vscode-chat-status", { hasText: "VS Code is working on this chat" }).waitFor();
        await box.fill("FICTIONAL later");
        await view.getByRole("button", { name: "Queue message" }).click();
        await view.locator(".vscode-chat-status", { hasText: "Queued" }).waitFor();
        const queued = await posts("/api/machines/remote/vscode/chat/send");
        assert.equal(queued.length, 2);
        assert.deepEqual(queued[1]?.body, { session: SESSION, text: "FICTIONAL later" }, "a send with nothing new picked carries no choice");
        console.log("PASS a busy chat says it is working, and Send queues the message");

        // 6. nothing wider than the phone
        await fits("the busy chat");
        assert.deepEqual(errors, [], "no render errors");
        console.log("PASS no horizontal overflow at 390 px");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
