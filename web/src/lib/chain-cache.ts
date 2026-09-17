/**
 * The persistent half of the scan cache: what may be written down, under what key, and
 * for how long. One instance per chain — see `createChainCache` at the bottom.
 *
 * A wallet scan is latency-bound. Measured on a 232-position wallet, cutting the number
 * of requests by 47% bought only 11% of the clock -- what is left is round trips, and the
 * only way to remove a round trip is to already know the answer. Everything cached here
 * is a fact about a settled block, so a second visit to the same wallet can know almost
 * all of them before it starts.
 *
 * TWO LAYERS, and both are needed:
 *
 *   in-flight promise (promise-cache.ts)   collapses duplicates WITHIN one scan
 *   IndexedDB (idb.ts)                     carries answers ACROSS page loads
 *
 * Without the first, several positions asking for the same pool at once all miss and all
 * query. Without the second, every reload starts from nothing.
 *
 * FINALITY is the one safety rule: nothing is written down until it is `REORG_DEPTH`
 * blocks behind the head, so the cache can never hold a log or a receipt the chain has
 * since disowned. The two kinds of entry learn where the head is DIFFERENTLY, and it is
 * worth being clear about which:
 *
 *   ranges  from the request's own upper bound. A log query already names the block it
 *           reads up to, so `nextPersistTo` measures against that and needs nothing
 *           global -- this path is self-contained, and `noteHead` does not affect it.
 *   points  from `noteHead`. A block timestamp or a receipt is asked for by id, and the
 *           call site has no idea how old it is, so the head has to come from the scan.
 *           Until `noteHead` is called nothing is final and no point persists -- the safe
 *           default, not an oversight: a path that forgets it is slow, not wrong.
 *
 * `observedHead` is per-instance (a closure variable), not module-level: two chains in
 * the same running page must not share one reorg-finality clock — see the design note in
 * docs/superpowers/plans/2026-09-16-arc-chain-support.md, Task 3.
 *
 * ESCAPE HATCH: load the page with `?nocache=1` to run against the null store, i.e. the
 * exact behaviour this module did not exist. Anything that looks wrong should be checked
 * that way first. (Global, not per-chain — it disables the underlying IndexedDB store
 * entirely, for every chain's instance.)
 */
import { cachedByKey, clearPromiseCache } from "./promise-cache";
import { cachedTokenMeta, clearTokenMetaCache, type TokenMeta } from "./token-meta";
import { getStore, nullStore, setStore, type PersistentStore } from "./idb";
import {
  groupByCachedTo, mergeLogs, nextPersistTo, planRangeFetch, upTo, type RangeRecord,
} from "./log-cache";
import type { ChainConfig } from "./uniswap-v3-pnl";

/**
 * How far behind the head a block must be before its logs, timestamp or receipt are
 * written to disk.
 *
 * ~512 blocks is on the order of ten minutes on Robinhood Chain, the chain this depth was
 * measured against. The positions this app reads are hours to months old, so in practice
 * nothing a scan cares about is inside the window and the depth costs nothing; it exists
 * so that a scan run seconds after a mint does not bake the tip into a cache that outlives
 * it. Raising it is cheap (one narrow tail query per key per visit); lowering it below a
 * chain's real reorg depth is not. Arc's real block time is unmeasured at design time (see
 * the design doc) — this constant is shared across chains for now as the conservative
 * choice; if Arc turns out to reorg deeper than ~512 blocks, raise it per-chain here.
 */
export const REORG_DEPTH = 512n;

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("nocache")) {
  setStore(nullStore);
}

export interface ChainCache {
  noteHead(head: bigint): void;
  isFinal(blockNumber: bigint): boolean;
  cachedPoint<T>(key: string, fetcher: () => Promise<T>, finalityOf: (value: T) => boolean, usable?: (value: T) => boolean): Promise<T>;
  cachedBlockTimestamp(blockNumber: bigint, fetcher: (blockNumber: bigint) => Promise<number>): Promise<number>;
  cachedReceipt<T extends { blockNumber: bigint }>(hash: string, fetcher: (hash: string) => Promise<T>): Promise<T>;
  cachedTokenMetaPersistent(address: string, fetcher: (address: string) => Promise<TokenMeta>): Promise<TokenMeta>;
  cachedLogRange<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    key: string, from: bigint, to: bigint, fetchRange: (from: bigint, to: bigint) => Promise<L[]>,
  ): Promise<L[]>;
  cachedLogsById<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    keyPrefix: string, ids: readonly bigint[], from: bigint, to: bigint,
    fetchIds: (ids: bigint[], from: bigint, to: bigint) => Promise<L[]>, idOf: (log: L) => bigint,
  ): Promise<Map<bigint, L[]>>;
  resetCaches(): Promise<void>;
  resetHead(): void;
}

/**
 * Build a cache scoped to one chain.
 *
 * `NS` keeps two chains from sharing an entry on disk (they share the SAME IndexedDB
 * database — `resetCaches` on either instance still clears the whole store; see the note
 * on `resetCaches` below). The `v1` is the SEMANTIC version -- bump it when the meaning of
 * a stored value changes without its shape changing, which the IndexedDB version bump in
 * idb.ts would not catch.
 */
export function createChainCache(chain: ChainConfig): ChainCache {
  const NS = `v1:${chain.chainId}`;
  let observedHead = 0n;

  function noteHead(head: bigint): void {
    if (head > observedHead) observedHead = head;
  }

  function isFinal(blockNumber: bigint): boolean {
    return observedHead > 0n && blockNumber + REORG_DEPTH <= observedHead;
  }

  function cachedPoint<T>(
    key: string,
    fetcher: () => Promise<T>,
    finalityOf: (value: T) => boolean,
    usable: (value: T) => boolean = () => true,
  ): Promise<T> {
    return cachedByKey(`${NS}:point:${key}`, async () => {
      const store = await getStore();
      const hit = await store.get<T>("points", `${NS}:${key}`);
      if (hit !== undefined && usable(hit)) return hit;
      const value = await fetcher();
      if (finalityOf(value)) void store.put("points", `${NS}:${key}`, value);
      return value;
    });
  }

  function cachedBlockTimestamp(blockNumber: bigint, fetcher: (blockNumber: bigint) => Promise<number>): Promise<number> {
    return cachedPoint(`blockts:${blockNumber}`, () => fetcher(blockNumber), () => isFinal(blockNumber));
  }

  function cachedReceipt<T extends { blockNumber: bigint }>(hash: string, fetcher: (hash: string) => Promise<T>): Promise<T> {
    return cachedPoint(`receipt:${hash.toLowerCase()}`, () => fetcher(hash), (r) => isFinal(r.blockNumber));
  }

  function cachedTokenMetaPersistent(address: string, fetcher: (address: string) => Promise<TokenMeta>): Promise<TokenMeta> {
    return cachedTokenMeta(address, (a) => cachedPoint(`tokenmeta:${a.toLowerCase()}`, () => fetcher(a), () => true));
  }

  function cachedLogRange<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    key: string, from: bigint, to: bigint, fetchRange: (from: bigint, to: bigint) => Promise<L[]>,
  ): Promise<L[]> {
    return cachedByKey(`${NS}:range:${key}:${from}:${to}`, async () => {
      const store = await getStore();
      const storeKey = `${NS}:${key}`;
      const cached = await store.get<RangeRecord<L>>("ranges", storeKey);
      const plan = planRangeFetch(cached, from, to);
      if (plan.kind === "hit") return upTo(cached!.logs, to);

      const fetched = await fetchRange(plan.from, plan.to);
      const logs = plan.kind === "extend" ? mergeLogs(cached!.logs, fetched) : mergeLogs([], fetched);
      writeRange(store, storeKey, cached?.to ?? null, from, to, logs);
      return logs;
    });
  }

  function writeRange<L extends { blockNumber: bigint | null }>(
    store: PersistentStore, storeKey: string, cachedTo: bigint | null, from: bigint, to: bigint, logs: readonly L[],
  ): void {
    const persistTo = nextPersistTo(cachedTo, from, to, REORG_DEPTH);
    if (persistTo === null) return;
    void store.put("ranges", storeKey, { from, to: persistTo, logs: upTo(logs, persistTo) });
  }

  async function cachedLogsById<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    keyPrefix: string, ids: readonly bigint[], from: bigint, to: bigint,
    fetchIds: (ids: bigint[], from: bigint, to: bigint) => Promise<L[]>, idOf: (log: L) => bigint,
  ): Promise<Map<bigint, L[]>> {
    const out = new Map<bigint, L[]>();
    if (!ids.length) return out;

    const store = await getStore();
    const keyFor = (id: bigint) => `${NS}:${keyPrefix}:${id}`;
    const records = await store.getMany<RangeRecord<L>>("ranges", ids.map(keyFor));

    const cachedOf = new Map<bigint, RangeRecord<L> | undefined>();
    ids.forEach((id, i) => {
      const rec = records[i];
      cachedOf.set(id, rec && rec.from === from ? rec : undefined);
    });

    const buckets = groupByCachedTo(ids.map((id) => ({ id, to: cachedOf.get(id)?.to ?? null })));
    const fetchedOf = new Map<bigint, L[]>();
    for (const id of ids) fetchedOf.set(id, []);

    await Promise.all([...buckets.values()].map(async ({ to: cachedTo, ids: bucketIds }) => {
      const fetchFrom = cachedTo === null ? from : cachedTo + 1n;
      if (fetchFrom > to) return;
      for (const log of await fetchIds(bucketIds, fetchFrom, to)) {
        fetchedOf.get(idOf(log))?.push(log);
      }
    }));

    const writes: { key: string; value: unknown }[] = [];
    for (const id of ids) {
      const cached = cachedOf.get(id);
      const fetched = fetchedOf.get(id)!;
      const merged = mergeLogs(cached?.logs ?? [], fetched);
      out.set(id, upTo(merged, to));
      const persistTo = nextPersistTo(cached?.to ?? null, from, to, REORG_DEPTH);
      const unchanged = cached && !fetched.length && persistTo === cached.to;
      if (persistTo !== null && !unchanged) {
        writes.push({ key: keyFor(id), value: { from, to: persistTo, logs: upTo(merged, persistTo) } });
      }
    }
    void store.putMany("ranges", writes);
    return out;
  }

  /**
   * Forget everything, in memory and on disk, so the next scan reads the chain from
   * scratch. Wired to the UI's "Rescan from chain".
   *
   * NOTE: `store.clear()` clears the WHOLE underlying IndexedDB store — both chains'
   * instances share one physical database (there is no per-namespace clear in idb.ts).
   * Calling this on either chain's instance wipes BOTH chains' on-disk caches. This
   * matches the button's existing "forget everything, start clean" semantics and is left
   * as-is deliberately: a selective per-chain clear is unneeded precision for a rare,
   * user-initiated, already-destructive action.
   */
  async function resetCaches(): Promise<void> {
    clearPromiseCache();
    clearTokenMetaCache();
    await (await getStore()).clear();
  }

  function resetHead(): void {
    observedHead = 0n;
  }

  return {
    noteHead, isFinal, cachedPoint, cachedBlockTimestamp, cachedReceipt,
    cachedTokenMetaPersistent, cachedLogRange, cachedLogsById, resetCaches, resetHead,
  };
}
