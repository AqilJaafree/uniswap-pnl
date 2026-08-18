/**
 * Remember each token's decimals and symbol for the life of the page.
 *
 * Measured on a 232-position wallet: ~9.5 of the ~13 JSON-RPC requests a position makes
 * are eth_call, and four of them are decimals/symbol for its two tokens. Across a whole
 * wallet that is ~900 calls describing a few dozen distinct addresses, re-asked once per
 * position — the single largest block of traffic in a scan.
 *
 * Safe to cache indefinitely because ERC-20 `decimals` and `symbol` are immutable in
 * every implementation this app reads: they are compile-time constants or set once in the
 * constructor. This is NOT a general-purpose contract cache and must not become one —
 * balances, liquidity, ticks and fees all change per block and none of them belong here.
 *
 * The MAP HOLDS PROMISES, not values, and that is the point: a scan asks for the same
 * token from several positions at once, and caching the resolved value would let all of
 * them miss and issue duplicate calls before the first one returns. Caching the in-flight
 * promise collapses them into one request.
 *
 * A rejected lookup is EVICTED, so a transient RPC failure does not poison a token for
 * the rest of the session — the next position that needs it retries.
 */

export interface TokenMeta {
  dec: number;
  sym: string;
}

const cache = new Map<string, Promise<TokenMeta>>();

/** Address identity, case-insensitive: the same token must not occupy two slots. */
const keyOf = (address: string) => address.toLowerCase();

export function cachedTokenMeta(
  address: string,
  fetcher: (address: string) => Promise<TokenMeta>,
): Promise<TokenMeta> {
  const key = keyOf(address);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = fetcher(address).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

/** Test seam. Not called by the app — a page load starts with an empty cache anyway. */
export function clearTokenMetaCache(): void {
  cache.clear();
}

export function tokenMetaCacheSize(): number {
  return cache.size;
}
