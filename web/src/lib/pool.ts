/**
 * Run an async job over many items with a bounded number in flight.
 *
 * analyzeWallet used to await one position at a time, so a 112-position wallet paid the
 * full latency of every position end to end — and the transport's concurrency gate, which
 * exists to keep the RPC from being swamped, never had more than one position's worth of
 * work to bound. The gate limits REQUESTS; this limits POSITIONS, and the two compose:
 * raising the gate does nothing while the caller is serial.
 *
 * Order-preserving: results come back in the order the items were given, not the order
 * they finished, because the caller pairs them with its own list. Pure and timer-free so
 * it can be unit-tested — see pool.test.ts.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("pool limit must be at least 1");
  const results = new Array<R>(items.length);
  let next = 0;
  // One worker per slot, each pulling the next index until the list is exhausted. A
  // shared cursor rather than a chunked split, so one slow item cannot leave a whole
  // slice of the work waiting behind it.
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
