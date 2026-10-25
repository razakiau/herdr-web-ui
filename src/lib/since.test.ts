import { expect, it } from "bun:test";
import { formatSince } from "./since.ts";

const now = 10_000_000_000;
const ago = (ms: number) => now - ms;

it("says nothing without a stamp (an older bridge)", () => expect(formatSince(undefined, now)).toBeNull());
it("under a minute is now", () => expect(formatSince(ago(30_000), now)).toBe("now"));
it("minutes", () => {
  expect(formatSince(ago(4 * 60_000), now)).toBe("4m");
  expect(formatSince(ago(59 * 60_000), now)).toBe("59m");
});
it("hours, rounded down", () => expect(formatSince(ago(125 * 60_000), now)).toBe("2h"));
it("days", () => expect(formatSince(ago(3 * 86_400_000), now)).toBe("3d"));
it("a stamp from the future (clock skew) is now", () => expect(formatSince(now + 60_000, now)).toBe("now"));
