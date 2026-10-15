import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InteractivePrompt } from "../shared/protocol.ts";
import { answerKeys, handlePromptRequest, parseInteractivePrompt } from "./prompt.ts";

// Copilot CLI 1.0.88's ask_user form, read off a live herdr pane (fictional question, loopback model)
const screen = (name: string): string => readFileSync(new URL(`./fixtures/copilot/ask-${name}-1.0.88.txt`, import.meta.url), "utf8");

describe("Copilot's ask_user form", () => {
  it("reads a question's choices and answers one by moving the cursor", () => {
    const prompt = parseInteractivePrompt("copilot", screen("choice"))!;
    expect(prompt).toMatchObject({ kind: "question", question: "FICTIONAL_LIVE_QUESTION?", title: "Pick", multi_select: false });
    expect(prompt.options.map((option) => option.label)).toEqual(["FICTIONAL_ONE", "FICTIONAL_TWO"]);
    expect(prompt.fallback).toBeUndefined();
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("types an answer of one's own on the Other row's line", () => {
    const prompt = parseInteractivePrompt("copilot", screen("choice"))!;
    expect(prompt.custom_option_index).toBe(2);
    // Other opens its line as soon as the cursor reaches it; Enter then sends the text
    expect(answerKeys(prompt, { custom_text: "FICTIONAL TYPED ANSWER" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { text: "FICTIONAL TYPED ANSWER" }, { keys: ["enter"] },
    ]);
  });

  it("reads the cursor where the screen puts it, the Other line open or not", () => {
    // the cursor on Other: its line is open and the card types there
    const other = parseInteractivePrompt("copilot", screen("other"))!;
    expect(other.options.map((option) => option.label)).toEqual(["FICTIONAL_ONE", "FICTIONAL_TWO"]);
    expect(answerKeys(other, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(other, { custom_text: "x" })).toEqual([{ text: "x" }, { keys: ["enter"] }]);
  });

  it("refuses a line someone already started typing on, which the card would add to", () => {
    expect(parseInteractivePrompt("copilot", screen("typing"))).toBeNull();
  });

  it("reads a question with no choices as one the user types", () => {
    const prompt = parseInteractivePrompt("copilot", screen("free"))!;
    expect(prompt).toMatchObject({ kind: "question", question: "FICTIONAL_FREE_QUESTION?", title: "Note", custom_option_index: 0 });
    expect(answerKeys(prompt, { custom_text: "FICTIONAL FREE ANSWER" })).toEqual([{ text: "FICTIONAL FREE ANSWER" }, { keys: ["enter"] }]);
  });

  it("leaves a form of several fields to the terminal: its tabs cannot be answered one card at a time", () => {
    expect(parseInteractivePrompt("copilot", screen("form"))).toBeNull();
    expect(parseInteractivePrompt("copilot", screen("form-tab2"))).toBeNull();
  });

  it("reads no question once the form has closed", () => {
    const lines = screen("choice").split("\n");
    const hint = lines.findIndex((line) => line.includes("enter accept"));
    expect(parseInteractivePrompt("copilot", lines.slice(0, hint).join("\n"))).toBeNull();
  });
});

describe("a Copilot pane's question card", () => {
  /** a herdr with one blocked Copilot pane showing `shown`; every RPC is recorded, the keys and text it is sent too */
  async function copilotHerdr(shown: () => string, run: (calls: { method: string; params: Record<string, unknown> }[]) => Promise<void>, onKeys: (keys: string[]) => void = () => undefined): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-copilot-prompt-"));
    const path = join(root, "herdr.sock");
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: Record<string, unknown> };
        calls.push({ method: request.method, params: request.params });
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "copilot", agent_status: "blocked", cwd: root }], layouts: [] } });
        if (request.method === "pane.read") return answer({ read: { text: shown() } });
        if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1", agent: "copilot", agent_status: "blocked", cwd: root, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 } } });
        if (request.method === "pane.send_keys") onKeys(request.params["keys"] as string[]);
        return answer({ type: "ok" });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(calls); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("is Copilot's own card, not the terminal's fallback, and its answer is the keys the form takes", async () => {
    let current = screen("choice");
    // Copilot redraws its cursor on the next row with each Down, as the pane did live
    const down = (text: string) => text.replace(" ❯ FICTIONAL_ONE\n   FICTIONAL_TWO", "   FICTIONAL_ONE\n ❯ FICTIONAL_TWO");
    await copilotHerdr(() => current, async (calls) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
      const { prompt } = await (await handlePromptRequest(new Request(url), url))!.json() as { prompt: InteractivePrompt };
      expect(prompt).toMatchObject({ agent: "copilot", kind: "question", question: "FICTIONAL_LIVE_QUESTION?" });
      expect(prompt.fallback).toBeUndefined();
      calls.length = 0;
      const answerUrl = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const answered = await handlePromptRequest(new Request(answerUrl, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: prompt.id, option_index: 1 }) }), answerUrl);
      expect(answered!.status).toBe(200);
      const sent = calls.filter((call) => call.method === "pane.send_keys" || call.method === "pane.send_text").map((call) => call.params["keys"] ?? call.params["text"]);
      expect(sent.flat()).toEqual(["down", "enter"]);
      current = "";
    }, (keys) => { if (keys.includes("down")) current = down(current); });
  });
});
