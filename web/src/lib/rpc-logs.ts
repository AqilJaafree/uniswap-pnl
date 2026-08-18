/**
 * Block-range splitting for `eth_getLogs`.
 *
 * Lives on its own rather than inside chain.ts / chain-v4.ts because BOTH need it and
 * those two already import from each other; a third module keeps the cycle from
 * deepening. Being callback-shaped (no viem, no client) also makes it unit-testable
 * without a chain — see rpc-logs.test.ts.
 */

/** The two ways this RPC refuses an over-wide query: the result-count cap, and a timeout. */
const TOO_WIDE = /exceeds limit|10000|too many|range too|timed out|timeout/i;

function messageOf(e: unknown): string {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return String(err?.details ?? (e as Error)?.message ?? "");
}

/**
 * getLogs over [fromBlock, toBlock] that survives the RPC's 10k-results-per-query cap
 * by recursively halving the block range on that error. Normal pools resolve in one
 * call; only hot pools (e.g. an active memecoin/USDG pair) split.
 *
 * Any error that is NOT a width complaint propagates untouched — halving a range will
 * not fix a bad address or a dead upstream, and retrying it would just multiply the load.
 */
export async function getLogsChunked<TLog>(
  makeCall: (fromBlock: bigint, toBlock: bigint) => Promise<TLog[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TLog[]> {
  try {
    return await makeCall(fromBlock, toBlock);
  } catch (e) {
    if (!TOO_WIDE.test(messageOf(e)) || toBlock - fromBlock < 1n) throw e;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [a, b] = await Promise.all([
      getLogsChunked(makeCall, fromBlock, mid),
      getLogsChunked(makeCall, mid + 1n, toBlock),
    ]);
    return [...a, ...b];
  }
}
