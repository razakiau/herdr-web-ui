import { describe, expect, it } from "bun:test";

import type { DigestSnapshot } from "../../shared/digest.ts";
import { createWeekDigest, digestFromSearch } from "./weekDigest.ts";

const week = (name: string): DigestSnapshot => ({ week: name } as DigestSnapshot);
const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); };

describe("the weekly digest in the page", () => {
  it("reads the week a digest's link names, and nothing else", () => {
    expect(digestFromSearch("?digest=2026-10-26")).toBe("2026-10-26");
    expect(digestFromSearch("?machine=mac&chat=s1")).toBeNull();
    expect(digestFromSearch("?digest=next")).toBeNull();
    expect(digestFromSearch("?digest=")).toBeNull();
  });

  it("opens on a week, reads the saved weeks, and closes", async () => {
    let asked = 0;
    const store = createWeekDigest(async () => { asked += 1; return [week("2026-10-26"), week("2026-10-19")]; });
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.read()));
    store.open("2026-10-19");
    expect(store.read()).toEqual({ digests: null, open: { week: "2026-10-19" } });
    await settle();
    expect(asked).toBe(1);
    expect(store.read().digests?.map((each) => each.week)).toEqual(["2026-10-26", "2026-10-19"]);
    store.close();
    expect(store.read().open).toBeNull();
    expect(seen).toHaveLength(3);
  });

  it("asks once while a read is in flight", async () => {
    let asked = 0;
    const store = createWeekDigest(async () => { asked += 1; return []; });
    void store.load(); void store.load();
    await settle();
    expect(asked).toBe(1);
  });

  it("has no weeks when the server cannot say (a server before the digest)", async () => {
    const store = createWeekDigest(() => Promise.reject(new Error("404")));
    await store.load();
    expect(store.read().digests).toEqual([]);
  });
});
