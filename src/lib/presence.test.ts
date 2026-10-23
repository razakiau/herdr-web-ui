import { afterEach, beforeEach, expect, it } from "bun:test";

import { PRESENCE_HEARTBEAT_MS, reportPageInUse } from "./presence.ts";

// a minimal page: visibility and focus the test sets, and the events presence.ts listens to
let visible = "visible";
let focused = true;
const target = new EventTarget();
const saved = { window: globalThis.window, document: globalThis.document };

beforeEach(() => {
  visible = "visible"; focused = true;
  (globalThis as { window?: unknown }).window = { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) };
  (globalThis as { document?: unknown }).document = {
    get visibilityState() { return visible; }, hasFocus: () => focused,
    addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target),
  };
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { document?: unknown }).document = saved.document;
});

it("tells the server the page is in use, renews it, says when it is not, and says it left", async () => {
  const told: [boolean, string][] = [];
  const stop = reportPageInUse((active, page) => told.push([active, page]));
  expect(told.map(([active]) => active)).toEqual([true]);
  const page = told[0]![1];
  expect(page).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(PRESENCE_HEARTBEAT_MS).toBeLessThan(45_000 / 2);
  focused = false;
  target.dispatchEvent(new Event("blur"));
  expect(told.map(([active]) => active)).toEqual([true, false]);
  // the same state twice is said once
  target.dispatchEvent(new Event("blur"));
  expect(told).toHaveLength(2);
  focused = true;
  target.dispatchEvent(new Event("focus"));
  stop();
  expect(told.map(([active]) => active)).toEqual([true, false, true, false]);
  expect(new Set(told.map(([, id]) => id))).toEqual(new Set([page]));
});
