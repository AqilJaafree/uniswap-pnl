/**
 * Persistent key/value storage for chain history, in the browser, via IndexedDB.
 *
 * Everything this app reads from the chain about a CLOSED block is immutable: a block's
 * timestamp, a transaction's receipt, the logs a contract emitted in a range that has
 * already been mined. A wallet scan spends most of its clock re-asking the same node for
 * exactly those, once per page load, and the answers can never have changed. Keeping them
 * on disk turns a repeat scan of a wallet from minutes into a handful of tail queries.
 *
 * This module is ONLY the storage. It knows nothing about blocks, logs or reorgs -- what
 * is safe to write, and under what key, is chain-cache.ts's problem.
 *
 * THREE RULES, all of them load-bearing:
 *
 * 1. A cache miss and a broken cache must be indistinguishable to the caller. Private
 *    browsing, a disabled IndexedDB, a full quota and a Node smoke test all resolve to
 *    the null store, where every read misses and every write is dropped. A scan that
 *    cannot cache is slow; a scan that THROWS because it could not cache is broken.
 * 2. Writes are fire-and-forget. Nothing awaits them for correctness, and a rejected
 *    write is swallowed here rather than surfacing halfway up a position's analysis.
 * 3. Values are stored by structured clone, which handles the bigints viem puts in every
 *    log and receipt. Do not JSON-stringify on the way in -- that is what would silently
 *    turn a bigint block number into a crash or, worse, a string.
 */

export type StoreName = "points" | "ranges";
export const STORE_NAMES: StoreName[] = ["points", "ranges"];

export interface PersistentStore {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  /**
   * One transaction, many keys, answers positionally aligned with `keys`.
   *
   * A wallet scan looks up a few hundred keys at once before it issues a single RPC. Done
   * as individual `get`s that is a few hundred IndexedDB transactions, each with its own
   * setup and commit, on the main thread -- enough to be visible next to the network time
   * it exists to save. Batched, it is one.
   */
  getMany<T>(store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  putMany(store: StoreName, entries: readonly { key: string; value: unknown }[]): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "rh-lp-pnl";
/**
 * Bump this when the SHAPE of what is stored changes. `onupgradeneeded` deletes and
 * recreates every store, so a bump is also the way to throw away entries written by a
 * version of the app that decoded them differently -- a cache that outlives a decoding
 * fix would serve the bug back forever.
 */
const DB_VERSION = 1;

/** Reads miss, writes vanish. What every unsupported or broken environment gets. */
export const nullStore: PersistentStore = {
  async get() { return undefined; },
  async getMany(_store, keys) { return keys.map(() => undefined); },
  async put() { /* dropped */ },
  async putMany() { /* dropped */ },
  async clear() { /* nothing to clear */ },
};

/** In-memory, for tests: same contract, no browser. Not used by the app. */
export function memoryStore(): PersistentStore & { size(): number; reads: number; writes: number } {
  const data = new Map<string, unknown>();
  const k = (s: StoreName, key: string) => `${s} ${key}`;
  const self = {
    reads: 0,
    writes: 0,
    async get<T>(s: StoreName, key: string) { self.reads++; return data.get(k(s, key)) as T | undefined; },
    async getMany<T>(s: StoreName, keys: readonly string[]) {
      self.reads += keys.length;
      return keys.map((key) => data.get(k(s, key)) as T | undefined);
    },
    async put(s: StoreName, key: string, value: unknown) { self.writes++; data.set(k(s, key), value); },
    async putMany(s: StoreName, entries: readonly { key: string; value: unknown }[]) {
      for (const e of entries) { self.writes++; data.set(k(s, e.key), e.value); }
    },
    async clear() { data.clear(); },
    size() { return data.size; },
  };
  return self;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop and recreate rather than migrate: every entry is a cache of something the
      // chain will hand back again, so the cheapest correct migration is no migration.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      for (const name of STORE_NAMES) db.createObjectStore(name);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opening a NEWER version blocks on this connection. Close rather than
      // hold it hostage; subsequent calls miss, which is the degraded-but-correct path.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexeddb blocked"));
  });
}

function idbStore(db: IDBDatabase): PersistentStore {
  return {
    async get<T>(store: StoreName, key: string): Promise<T | undefined> {
      try {
        const tx = db.transaction(store, "readonly");
        return (await promisify(tx.objectStore(store).get(key))) as T | undefined;
      } catch { return undefined; }
    },
    async getMany<T>(store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]> {
      if (!keys.length) return [];
      try {
        const os = db.transaction(store, "readonly").objectStore(store);
        return (await Promise.all(keys.map((k) => promisify(os.get(k))))) as (T | undefined)[];
      } catch { return keys.map(() => undefined); }
    },
    async put(store: StoreName, key: string, value: unknown): Promise<void> {
      try {
        const tx = db.transaction(store, "readwrite");
        await promisify(tx.objectStore(store).put(value, key));
      } catch { /* quota, closed db, unclonable value -- a dropped write is not an error */ }
    },
    async putMany(store: StoreName, entries: readonly { key: string; value: unknown }[]): Promise<void> {
      if (!entries.length) return;
      try {
        const os = db.transaction(store, "readwrite").objectStore(store);
        await Promise.all(entries.map((e) => promisify(os.put(e.value, e.key))));
      } catch { /* same as put: a dropped write costs speed, never correctness */ }
    },
    async clear(): Promise<void> {
      try {
        const tx = db.transaction(STORE_NAMES, "readwrite");
        await Promise.all(STORE_NAMES.map((s) => promisify(tx.objectStore(s).clear())));
      } catch { /* nothing the caller can do about it */ }
    },
  };
}

let opening: Promise<PersistentStore> | null = null;

/**
 * The store for this page, opened once.
 *
 * Resolves to `nullStore` -- never rejects -- when IndexedDB is absent (Node, the tsx
 * smoke scripts) or refuses to open (private browsing in some engines, a corrupt
 * database). Callers therefore never need a fallback path of their own.
 */
export function getStore(): Promise<PersistentStore> {
  if (opening) return opening;
  opening = (async () => {
    if (typeof indexedDB === "undefined") return nullStore;
    try { return idbStore(await openDb()); } catch { return nullStore; }
  })();
  return opening;
}

/** Test/escape-hatch seam: force a specific backend (or `nullStore` to disable caching). */
export function setStore(store: PersistentStore): void {
  opening = Promise.resolve(store);
}
