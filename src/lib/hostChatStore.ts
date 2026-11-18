/**
 * The host chat reads this device keeps (ZAC-340): the last full read of each chat, so a chat seen
 * before shows at once, and its next read asks only for what changed since (`known`). Kept in
 * IndexedDB for the last STORED_CHATS chats opened or read; a read over STORED_READ_MAX_BYTES
 * serialized is not kept. The store is injected (setHostReadStore), so tests need no IndexedDB.
 */
import type { HostChatRead } from "../../shared/host-chats.ts";

export const STORED_CHATS = 40;
export const STORED_READ_MAX_BYTES = 25 * 1024 * 1024;

/** Reads by key (`<machine>\n<session>`), as their JSON. */
export interface HostReadStore {
  get(key: string): Promise<string | null>;
  put(key: string, json: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB = "ovis-host-chats";
const READS = "reads";
const LRU = "lru";

const finished = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
  tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
});

/**
 * The browser's IndexedDB as a HostReadStore, or null without one. Two stores: the reads by key
 * (a big string each, written only when a read changes), and each key's last use, so a use rewrites
 * a timestamp and not the read, and the least recently used past STORED_CHATS go.
 */
export function indexedDbReadStore(factory: IDBFactory | undefined = globalThis.indexedDB, limit = STORED_CHATS): HostReadStore | null {
  if (!factory) return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB, 1);
    request.onupgradeneeded = () => {
      const base = request.result;
      if (!base.objectStoreNames.contains(READS)) base.createObjectStore(READS);
      if (!base.objectStoreNames.contains(LRU)) base.createObjectStore(LRU).createIndex("at", "at");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error ?? new Error("indexedDB open failed")); };
  });
  // every step chains in its request's own callback: an await between two requests of one
  // transaction may let it commit first on some browsers
  return {
    async get(key) {
      const tx = (await db()).transaction([READS, LRU], "readwrite");
      let json: unknown = null;
      const read = tx.objectStore(READS).get(key);
      read.onsuccess = () => {
        json = read.result;
        if (typeof json === "string") tx.objectStore(LRU).put({ at: Date.now() }, key);
      };
      await finished(tx);
      return typeof json === "string" ? json : null;
    },
    async put(key, json) {
      const tx = (await db()).transaction([READS, LRU], "readwrite");
      tx.objectStore(READS).put(json, key);
      const lru = tx.objectStore(LRU);
      lru.put({ at: Date.now() }, key);
      const count = lru.count();
      count.onsuccess = () => {
        let extra = count.result - limit;
        if (extra <= 0) return;
        // oldest first; the read just written is the newest
        const cursor = lru.index("at").openKeyCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at || extra <= 0) return;
          if (at.primaryKey !== key) {
            tx.objectStore(READS).delete(at.primaryKey);
            lru.delete(at.primaryKey);
            extra -= 1;
          }
          at.continue();
        };
      };
      await finished(tx);
    },
    async delete(key) {
      const tx = (await db()).transaction([READS, LRU], "readwrite");
      tx.objectStore(READS).delete(key);
      tx.objectStore(LRU).delete(key);
      await finished(tx);
    },
  };
}

/** A stored read's JSON as a read, or null when it is not one this app wrote (the caller drops it). */
export function parseStoredRead(json: string): HostChatRead | null {
  try {
    const read = JSON.parse(json) as HostChatRead;
    const usable = typeof read === "object" && read !== null && Array.isArray(read.turns) && Array.isArray(read.commands)
      && typeof read.signature === "string" && typeof read.base?.n === "number" && typeof read.base.hash === "string"
      && read.base.n <= read.turns.length && read.delta === undefined && read.commands_same === undefined;
    return usable ? read : null;
  } catch { return null; }
}
