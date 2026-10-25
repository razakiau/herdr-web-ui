import { expect, it } from "bun:test";
import { StatusSince } from "./status-since.ts";

it("first note stamps now", () => {
  const since = new StatusSince();
  expect(since.note("p1", "working", 1000)).toBe(1000);
  expect(since.of("p1")).toBe(1000);
});

it("same status keeps since", () => {
  const since = new StatusSince();
  since.note("p1", "working", 1000);
  expect(since.note("p1", "working", 5000)).toBe(1000);
  expect(since.of("p1")).toBe(1000);
});

it("new status restamps", () => {
  const since = new StatusSince();
  since.note("p1", "working", 1000);
  expect(since.note("p1", "blocked", 5000)).toBe(5000);
});

it("forget drops it", () => {
  const since = new StatusSince();
  since.note("p1", "working", 1000);
  since.forget("p1");
  expect(since.of("p1")).toBeUndefined();
  expect(since.note("p1", "working", 7000)).toBe(7000);
});
