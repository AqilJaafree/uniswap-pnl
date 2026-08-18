/**
 * Remember an in-flight or completed async result under a key, for the life of the page.
 *
 * The v4 path asks the chain for things keyed by POOL, not by position: a pool's
 * ModifyLiquidity history, its Swap history, its Initialize event. A wallet holding many
 * positions in the same pool re-issued each of those once per position — the same query,
 * the same answer, over and over.
 *
 * Caching the PROMISE rather than the value is what collapses concurrent duplicates: with
 * several positions computed at once, a value cache would let all of them miss and fire
 * the same query before the first one returned.
 *
 * A rejected entry is EVICTED so a transient RPC failure does not poison a pool for the
 * rest of the session.
 *
 * KEYS MUST PIN EVERYTHING THE ANSWER DEPENDS ON — for log queries that means the block
 * range as well as the pool, or a later scan against a newer head would be served a stale
 * answer from an earlier one. Callers build keys accordingly; this module cannot check it
 * for them.
 */
const cache = new Map<string, Promise<unknown>>();

export function cachedByKey<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = fetcher().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

/** Test seam. */
export function clearPromiseCache(): void {
  cache.clear();
}

export function promiseCacheSize(): number {
  return cache.size;
}
