/**
 * The range arithmetic behind a persistent `eth_getLogs` cache.
 *
 * Every log query this app makes runs from a fixed start block to the CURRENT head. The
 * start never moves (genesis, or a position's mint block); the head does, by a few
 * thousand blocks between one visit and the next. So the second scan of a wallet does not
 * need the query again -- it needs the sliver of it that was not mined yet last time.
 *
 * Pure, and chain-free, so the part that is easy to get subtly wrong is the part that can
 * be unit-tested without an RPC. The storage lives in idb.ts and the wiring in
 * chain-cache.ts.
 *
 * REORGS are the reason a cached range stops short of the head. A log read at the tip can
 * still be un-mined; a log 500 blocks back cannot, on any chain this app runs on. So the
 * tail is fetched fresh every time and only the settled prefix is ever written down. That
 * costs one narrow query per key per visit and buys a cache that cannot serve a log the
 * chain has since disowned.
 */

/** What a cached range covers. `logs` are every matching log in [from, to] inclusive. */
export interface RangeRecord<L> {
  from: bigint;
  to: bigint;
  logs: L[];
}

export type RangePlan =
  /** The cache already covers the request; issue nothing. */
  | { kind: "hit" }
  /** Fetch only this sub-range and append it to what is cached. */
  | { kind: "extend"; from: bigint; to: bigint }
  /** Nothing reusable; fetch the whole request. */
  | { kind: "full"; from: bigint; to: bigint };

/**
 * Decide what still has to be asked of the chain.
 *
 * A cached record is only reused when its start block is EXACTLY the requested one. A
 * cached range that starts later is missing logs the caller asked for; one that starts
 * earlier is a superset and could in principle be filtered down, but every caller here
 * queries from a start that is a property of the thing being queried (genesis, or a
 * position's mint block), so a mismatch means the caller changed its mind about what it
 * is asking -- and quietly serving it a differently-scoped answer is exactly the class of
 * bug this whole module has to not have.
 */
export function planRangeFetch<L>(
  cached: RangeRecord<L> | undefined,
  from: bigint,
  to: bigint,
): RangePlan {
  if (!cached || cached.from !== from) return { kind: "full", from, to };
  if (cached.to >= to) return { kind: "hit" };
  return { kind: "extend", from: cached.to + 1n, to };
}

/**
 * The highest block that may be written to the cache, or null when the whole request sits
 * inside the reorg window and nothing may be.
 *
 * Never moves BACKWARDS past what is already stored: a block that was settled when it was
 * written is still settled now, so shrinking a record because the head barely advanced
 * would throw away good history and re-fetch it forever. `cachedTo` is the record's
 * current end, or null if there is no record.
 */
export function nextPersistTo(
  cachedTo: bigint | null,
  from: bigint,
  to: bigint,
  reorgDepth: bigint,
): bigint | null {
  const settled = to - reorgDepth;
  const best = cachedTo !== null && cachedTo > settled ? cachedTo : settled;
  return best >= from ? best : null;
}

/**
 * Combine a cached prefix with freshly fetched logs.
 *
 * Deduplicates on (blockNumber, logIndex), which is unique within one cache key because
 * the key pins the address and topics -- two logs from the same query cannot share a
 * block and a log index. The overlap should be empty by construction; the dedupe is here
 * so that an off-by-one in a range boundary shows up as no change rather than as a
 * double-counted deposit.
 *
 * Sorted by (blockNumber, logIndex): callers walk these in chain order, and a fetched
 * tail concatenated onto a cached prefix is only accidentally in that order.
 */
export function mergeLogs<L extends { blockNumber: bigint | null; logIndex: number | null }>(
  cached: readonly L[],
  fetched: readonly L[],
): L[] {
  const seen = new Set<string>();
  const out: L[] = [];
  for (const l of [...cached, ...fetched]) {
    const id = `${l.blockNumber}:${l.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(l);
  }
  out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
      : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1);
  return out;
}

/** Everything at or below `to`. Used to trim a merged set down to the settled prefix. */
export function upTo<L extends { blockNumber: bigint | null }>(logs: readonly L[], to: bigint): L[] {
  return logs.filter((l) => l.blockNumber !== null && l.blockNumber <= to);
}

/**
 * Bucket ids by how far their cache already reaches, so one query can serve every id that
 * needs the same block range.
 *
 * This is what makes the batched prefetches cheap on a revisit. A wallet's positions were
 * all cached by the same earlier scan, so they land in ONE bucket and the whole wallet's
 * ownership history costs a single narrow query instead of a full-range one per chunk. A
 * position minted since that scan has no record at all and joins the `null` bucket, which
 * is fetched from the start.
 *
 * Keyed by the string form of the end block because a Map keyed on bigint compares by
 * identity for boxed values in some engines; the string is unambiguous and orders nothing.
 */
export function groupByCachedTo(
  entries: readonly { id: bigint; to: bigint | null }[],
): Map<string, { to: bigint | null; ids: bigint[] }> {
  const out = new Map<string, { to: bigint | null; ids: bigint[] }>();
  for (const { id, to } of entries) {
    const key = to === null ? "none" : to.toString();
    let bucket = out.get(key);
    if (!bucket) { bucket = { to, ids: [] }; out.set(key, bucket); }
    bucket.ids.push(id);
  }
  return out;
}
