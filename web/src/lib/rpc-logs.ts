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

/**
 * The load balancer in front of this RPC sometimes routes to a backend that is not there.
 *
 * It reports that as `-32000` with a body like `Post "http://10.31.64.244:8547/rpc": dial
 * tcp ...: connect: no route to host` — and viem maps `-32000` to InvalidInputRpcError,
 * i.e. "Missing or invalid parameters", which is exactly what it is not. Nothing retries
 * it: viem's own retry skips that class, and the splitter below deliberately propagates
 * anything that is not a width complaint. So one dead backend, for one instant, either
 * kills an entire wallet scan or drops a position into `skipped` as if the chain had no
 * answer for it.
 *
 * Matched on the transport symptom rather than the code, because the code lies here. A
 * genuine bad request does not mention a socket.
 */
const TRANSIENT = /no route to host|dial tcp|connection refused|connection reset|broken pipe|EOF|socket hang up|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|bad gateway|service unavailable|\b50[234]\b/i;

function messageOf(e: unknown): string {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return String(err?.details ?? (e as Error)?.message ?? "");
}

/** Exported for the tests, which are the only thing that should care how this is decided. */
export const isTransient = (e: unknown): boolean => {
  const msg = messageOf(e);
  // Width first: a timeout on a wide range is fixed by splitting it, not by asking again.
  return !TOO_WIDE.test(msg) && TRANSIENT.test(msg);
};

/**
 * getLogs over [fromBlock, toBlock] that survives the RPC's 10k-results-per-query cap
 * by recursively halving the block range on that error. Normal pools resolve in one
 * call; only hot pools (e.g. an active memecoin/USDG pair) split.
 *
 * A TRANSIENT transport failure (see `isTransient`) is retried in place first — this
 * chain's load balancer intermittently answers with a dead backend, and treating that as
 * a permanent error is what makes a position unreadable.
 *
 * Any other error that is NOT a width complaint propagates untouched — halving a range
 * will not fix a bad address, and retrying it would just multiply the load.
 */
export async function getLogsChunked<TLog>(
  makeCall: (fromBlock: bigint, toBlock: bigint) => Promise<TLog[]>,
  fromBlock: bigint,
  toBlock: bigint,
  opts: { transientAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TLog[]> {
  const attempts = opts.transientAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    // Backoff is linear and short: a flapping backend is usually gone by the next request,
    // and this RPC rate-limits, so a long tail of retries costs more than it recovers.
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return await makeCall(fromBlock, toBlock); } catch (e) {
        if (!isTransient(e)) throw e;
        last = e;
        if (i < attempts - 1) await sleep(400 * (i + 1));
      }
    }
    throw last;
  } catch (e) {
    if (!TOO_WIDE.test(messageOf(e)) || toBlock - fromBlock < 1n) throw e;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [a, b] = await Promise.all([
      getLogsChunked(makeCall, fromBlock, mid, opts),
      getLogsChunked(makeCall, mid + 1n, toBlock, opts),
    ]);
    return [...a, ...b];
  }
}
