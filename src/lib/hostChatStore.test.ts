import { describe, expect, it } from "bun:test";
import { indexedDbReadStore } from "./hostChatStore.ts";

/**
 * Just enough of IndexedDB for a get: each transaction is recorded with its stores and mode, and a
 * read-write one can be held open (a big put in progress) to show a get does not wait for it.
 */
function fakeIndexedDb(rows: Map<string, string>, holdWrites: boolean) {
  const transactions: { stores: string[]; mode: string; done: boolean }[] = [];
  const later = (run: () => void) => { setTimeout(run, 0); };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => undefined }),
    transaction(names: string | string[], mode = "readonly") {
      const entry = { stores: Array.isArray(names) ? names : [names], mode, done: false };
      transactions.push(entry);
      const tx: Record<string, unknown> = {};
      let pending = 0;
      const settle = () => {
        if (pending > 0 || (mode === "readwrite" && holdWrites)) return;
        later(() => { entry.done = true; (tx["oncomplete"] as (() => void) | undefined)?.(); });
      };
      const request = (result: unknown) => {
        const req: Record<string, unknown> = { result };
        pending += 1;
        later(() => { pending -= 1; (req["onsuccess"] as (() => void) | undefined)?.(); settle(); });
        return req;
      };
      tx["objectStore"] = (name: string) => ({
        get: (key: string) => request(name === "reads" ? rows.get(key) : undefined),
        put: () => request(undefined),
        delete: () => request(undefined),
      });
      return tx;
    },
  };
  const factory = {
    open() {
      const req: Record<string, unknown> = { result: db };
      later(() => { (req["onsuccess"] as () => void)(); });
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, transactions };
}

describe("the device's store of host chat reads (ZAC-340)", () => {
  it("a get reads in a read-only transaction and notes the use apart, never waiting behind a write", async () => {
    const { factory, transactions } = fakeIndexedDb(new Map([["desk\ns1", "{\"FICTIONAL\":1}"]]), true);
    const store = indexedDbReadStore(factory)!;
    expect(await store.get("desk\ns1")).toBe("{\"FICTIONAL\":1}");
    expect(transactions.map(({ stores, mode }) => ({ stores, mode }))).toEqual([
      { stores: ["reads"], mode: "readonly" },
      { stores: ["lru"], mode: "readwrite" },
    ]);
    // the use's write is still open (held) and the get answered all the same
    expect(transactions[1]!.done).toBe(false);
  });

  it("a key with nothing stored is null, and notes no use", async () => {
    const { factory, transactions } = fakeIndexedDb(new Map(), true);
    expect(await indexedDbReadStore(factory)!.get("desk\nnone")).toBeNull();
    expect(transactions.map(({ mode }) => mode)).toEqual(["readonly"]);
  });
});
