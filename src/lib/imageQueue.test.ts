import { expect, it } from "bun:test";
import { createImageQueue, needsTurn } from "./imageQueue.ts";

it("starts two pictures at a time, the next one as a turn is given back", () => {
  const queue = createImageQueue(2);
  const started: number[] = [];
  const done = [0, 1, 2, 3].map((n) => queue.take(() => started.push(n)));
  expect(started).toEqual([0, 1]);
  done[1]!();
  expect(started).toEqual([0, 1, 2]);
  done[1]!();
  expect(started).toEqual([0, 1, 2]);
  expect(queue.active()).toBe(2);
});

it("a picture that leaves the line before its turn never starts nor holds one", () => {
  const queue = createImageQueue(1);
  const started: number[] = [];
  const first = queue.take(() => started.push(0));
  const second = queue.take(() => started.push(1));
  queue.take(() => started.push(2));
  second();
  first();
  expect(started).toEqual([0, 2]);
  expect(queue.active()).toBe(1);
});

it("lets a picture the browser holds already skip the line", () => {
  expect(needsTurn("data:image/png;base64,AA")).toBe(false);
  expect(needsTurn("blob:https://ovis/1")).toBe(false);
  expect(needsTurn("/api/machines/x/host-chats/image?ref=1")).toBe(true);
});
