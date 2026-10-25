import { expect, it } from "bun:test";
import { sinceOf } from "./since.ts";

const now = 10_000_000_000;
const ago = (ms: number) => now - ms;

it("says nothing without a stamp (an older bridge)", () => expect(sinceOf(undefined, now)).toBeNull());
it("under a minute is now", () => expect(sinceOf(ago(30_000), now)).toEqual({ unit: "now" }));
it("minutes", () => {
  expect(sinceOf(ago(4 * 60_000), now)).toEqual({ unit: "m", n: 4 });
  expect(sinceOf(ago(59 * 60_000), now)).toEqual({ unit: "m", n: 59 });
});
it("hours, rounded down", () => expect(sinceOf(ago(125 * 60_000), now)).toEqual({ unit: "h", n: 2 }));
it("days", () => expect(sinceOf(ago(3 * 86_400_000), now)).toEqual({ unit: "d", n: 3 }));
it("a stamp from the future (clock skew) is now", () => expect(sinceOf(now + 60_000, now)).toEqual({ unit: "now" }));
