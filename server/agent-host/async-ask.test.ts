import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncAskStore } from "./async-ask.ts";

const SESSION = "ahp-chat://fictional-chat/c2Vzc2lvbg";
const OPTIONS = [{ label: "A", description: "the first way" }, { label: "B" }];

let dir: string;
let file: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "async-ask-"));
  file = join(dir, "async-asks.json");
  clock = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ask = (store: AsyncAskStore, extra: { kind?: "optional" | "blocking"; recommended?: number | null } = {}) =>
  store.add({ session: SESSION, question: "FICTIONAL: which way?", options: OPTIONS, recommended: extra.recommended === undefined ? 0 : extra.recommended, kind: extra.kind ?? "optional" });

describe("AsyncAskStore", () => {
  test("due() is empty while a page is in use", () => {
    const store = new AsyncAskStore(file, now);
    ask(store);
    store.setInUse(true);
    clock = 10 * 60_000;
    expect(store.due()).toEqual([]);
  });

  test("due() counts from when Ovis closed", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    store.setInUse(true);
    clock = 120_000;
    store.setInUse(false);
    clock = 170_000;
    expect(store.due()).toEqual([]);
    clock = 180_000;
    expect(store.due().map((d) => d.id)).toEqual([q.id]);
  });

  test("a fresh store counts as away from the start, and a repeated setInUse(false) keeps the first close", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    clock = 30_000;
    store.setInUse(false);
    clock = 60_000;
    expect(store.due().map((d) => d.id)).toEqual([q.id]);
    store.setInUse(true);
    clock = 100_000;
    store.setInUse(false);
    clock = 140_000;
    store.setInUse(false);
    expect(store.due()).toEqual([]);
    clock = 160_000;
    expect(store.due().map((d) => d.id)).toEqual([q.id]);
  });

  test("blocking and no-recommendation questions are never due", () => {
    const store = new AsyncAskStore(file, now);
    ask(store, { kind: "blocking" });
    ask(store, { recommended: null });
    clock = 60 * 60_000;
    expect(store.due()).toEqual([]);
  });

  test("answer is once", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    clock = 5_000;
    const answered = store.answer(q.id, "A", false);
    expect(answered?.answer).toEqual({ label: "A", assumed: false, at: 5_000 });
    expect(store.answer(q.id, "B", true)).toBeNull();
    expect(store.answer("ask-00000000", "A", false)).toBeNull();
    expect(store.pending(SESSION)).toEqual([]);
    expect(store.get(q.id)?.answer?.label).toBe("A");
  });

  test("survives a restart", () => {
    const store = new AsyncAskStore(file, now);
    clock = 1_000;
    const q = ask(store);
    expect(q.id).toMatch(/^ask-[0-9a-f]{8}$/);
    const again = new AsyncAskStore(file, now);
    expect(again.pending(SESSION)).toEqual([q]);
  });

  test("pending lists oldest first, only the session's own", () => {
    const store = new AsyncAskStore(file, now);
    const first = ask(store);
    clock = 1_000;
    const second = ask(store);
    store.add({ session: "other", question: "FICTIONAL", options: OPTIONS, recommended: null, kind: "optional" });
    expect(store.pending(SESSION).map((q) => q.id)).toEqual([first.id, second.id]);
  });

  test("answered questions are kept 7 days, then dropped on load", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    store.answer(q.id, "A", false);
    clock = 7 * 24 * 60 * 60_000 - 1;
    expect(new AsyncAskStore(file, now).get(q.id)).not.toBeNull();
    clock = 7 * 24 * 60 * 60_000 + 1;
    expect(new AsyncAskStore(file, now).get(q.id)).toBeNull();
  });

  test("a missing or broken file starts empty", () => {
    expect(new AsyncAskStore(join(dir, "nope", "x.json"), now).pending(SESSION)).toEqual([]);
    writeFileSync(file, "{not json");
    expect(new AsyncAskStore(file, now).pending(SESSION)).toEqual([]);
  });
});
