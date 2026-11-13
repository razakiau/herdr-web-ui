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

  test("a fresh store counts as away from its start, and a repeated setInUse(false) keeps the first close", () => {
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

  test("a restart counts as seen now: an old question is due 60 s after it, not at once", () => {
    ask(new AsyncAskStore(file, now));
    clock = 10 * 60_000;
    const restarted = new AsyncAskStore(file, now);
    clock = 10 * 60_000 + 59_000;
    expect(restarted.due()).toEqual([]);
    clock = 10 * 60_000 + 60_000;
    expect(restarted.due()).toHaveLength(1);
  });

  test("add refuses a recommended option that is not there", () => {
    const store = new AsyncAskStore(file, now);
    expect(() => ask(store, { recommended: 5 })).toThrow();
    expect(() => ask(store, { recommended: -1 })).toThrow();
    expect(() => ask(store, { recommended: 0.5 })).toThrow();
    expect(store.pending(SESSION)).toEqual([]);
  });

  test("a stored row whose recommended option is not there is skipped on load", () => {
    const row = { id: "ask-0000000a", session: SESSION, question: "FICTIONAL", options: OPTIONS, recommended: 2, kind: "optional", askedAt: 0, answer: null };
    writeFileSync(file, JSON.stringify([row, { ...row, id: "ask-0000000b", recommended: 1 }]));
    expect(new AsyncAskStore(file, now).pending(SESSION).map((q) => q.id)).toEqual(["ask-0000000b"]);
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

  test("an unanswered question never expires: a blocking one 8 days old survives the load", () => {
    const store = new AsyncAskStore(file, now);
    const blocking = ask(store, { kind: "blocking", recommended: null });
    const optional = ask(store);
    clock = 8 * 24 * 60 * 60_000;
    const loaded = new AsyncAskStore(file, now);
    expect(loaded.pending(SESSION).map((q) => q.id)).toEqual([blocking.id, optional.id]);
    expect(loaded.unanswered().map((q) => q.id)).toEqual([blocking.id, optional.id]);
  });

  test("drop forgets a question and saves it; an unknown id is false", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    const kept = ask(store);
    expect(store.drop(q.id)).toBe(true);
    expect(store.get(q.id)).toBeNull();
    expect(new AsyncAskStore(file, now).pending(SESSION).map((each) => each.id)).toEqual([kept.id]);
    expect(store.drop(q.id)).toBe(false);
  });

  test("reopen makes an answered question pending again, and saves it", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    store.answer(q.id, "A", false);
    expect(store.pending(SESSION)).toEqual([]);
    expect(store.reopen(q.id)).toBe(true);
    expect(store.pending(SESSION).map((each) => each.id)).toEqual([q.id]);
    expect(store.get(q.id)?.answer).toBeNull();
    expect(new AsyncAskStore(file, now).pending(SESSION).map((each) => each.id)).toEqual([q.id]);
    // it can be answered again; an unknown id is false
    expect(store.answer(q.id, "B", false)?.answer?.label).toBe("B");
    expect(store.reopen("ask-00000000")).toBe(false);
  });

  test("a correction replaces an assumed answer with the user's, once; revert puts the assumed one back", () => {
    const store = new AsyncAskStore(file, now);
    const q = ask(store);
    // unanswered, or answered by the user: nothing to correct
    expect(store.correct(q.id, "B")).toBeNull();
    store.answer(q.id, "A", false);
    expect(store.correct(q.id, "B")).toBeNull();
    store.reopen(q.id);
    clock = 5;
    store.answer(q.id, "A", true);
    clock = 9;
    const corrected = store.correct(q.id, "B");
    expect(corrected?.question.answer).toEqual({ label: "B", assumed: false, at: 9 });
    expect(corrected?.previous).toEqual({ label: "A", assumed: true, at: 5 });
    // saved, and not pending again; a second correction finds it the user's
    expect(new AsyncAskStore(file, now).get(q.id)?.answer).toEqual({ label: "B", assumed: false, at: 9 });
    expect(store.pending(SESSION)).toEqual([]);
    expect(store.correct(q.id, "A")).toBeNull();
    // a correction that never reached the chat: the assumed answer is back, and correctable again
    store.revert(q.id, corrected!.previous);
    expect(store.get(q.id)?.answer).toEqual({ label: "A", assumed: true, at: 5 });
    expect(new AsyncAskStore(file, now).get(q.id)?.answer).toEqual({ label: "A", assumed: true, at: 5 });
    expect(store.correct("ask-00000000", "B")).toBeNull();
  });

  test("a missing or broken file starts empty", () => {
    expect(new AsyncAskStore(join(dir, "nope", "x.json"), now).pending(SESSION)).toEqual([]);
    writeFileSync(file, "{not json");
    expect(new AsyncAskStore(file, now).pending(SESSION)).toEqual([]);
  });
});
