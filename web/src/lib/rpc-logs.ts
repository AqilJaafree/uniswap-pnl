/**
 * Block-range splitting for `eth_getLogs`.
 *
 * Lives on its own rather than inside chain.ts / chain-v4.ts because BOTH need it and
 * those two already import from each other; a third module keeps the cycle from
 * deepening. Being callback-shaped (no viem, no client) also makes it unit-testable
 * without a chain — see rpc-logs.test.ts.
 */

/**
 * How an RPC refuses an over-wide query -- and it is worth listing BOTH nodes, because
 * they word it differently and the difference silently broke every v4 position.
 *
 *   public   `logs matched by query exceeds limit of 10000`
 *   Alchemy  `Log response size exceeded. You can make eth_getLogs requests with up to a
 *             10,000 block range ... this block range should work: [0x…, 0x…]`
 *
 * The original pattern was written against the public node and matched on "exceeds limit"
 * and the bare "10000". Alchemy says "exceeded", and writes the number with a comma, so
 * NOTHING matched: the range was never split, the error propagated, and the position was
 * reported unreadable. It only surfaced once wallet-lane `eth_getLogs` started going to
 * Alchemy -- the same query had been splitting correctly against the public node for
 * months. A v4 position needs a pool-wide ModifyLiquidity query over its whole lifetime,
 * so v4 took essentially all of the damage: 63 positions in one wallet.
 *
 * Match on both wordings, and keep them specific. "exceeded" on its own would also catch
 * "rate limit exceeded", which must NOT be treated as width -- see RATE_LIMITED.
 *
 * Anchor on the PHRASE, never on the number: Alchemy's documented example of this same
 * error says "up to a 2K block range" where this endpoint says "10,000". The block figure
 * varies by chain and tier, so `response size exceeded` is the only stable part of it.
 */
const TOO_WIDE = /exceeds limit|response size exceeded|10000|10,000|too many|range too|too large|timed out|timeout/i;

/**
 * Both big providers name the range they WOULD have answered. Take it.
 *
 *   Alchemy (-32602)  `… this block range should work: [0x0, 0xd043b8]`
 *   Infura  (-32005)  `… Try with this block range [0xBDE5F8, 0x102DBCC].`
 *
 * Worth honouring rather than halving blindly. The query that exposed this spans
 * 11.1M-42.9M blocks and the usable upper bound was 27.0M — not a midpoint, and blind
 * halving needs several full round trips to find it. This scan is latency-bound, so
 * round trips are the thing actually worth saving. Alchemy's own guidance is to parse
 * the suggestion rather than wait out repeated failures.
 *
 * Trusted only when it starts where we asked and ends strictly inside our own range; a
 * hint that fails either test is ignored, not clamped. If the suggestion is still too
 * wide the recursion handles it, exactly as a midpoint would.
 */
const SUGGESTED_RANGE =
  /(?:should work|try with this block range)[:\s]*\[\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\]/i;

export function suggestedSplit(msg: string, fromBlock: bigint, toBlock: bigint): bigint | null {
  const m = SUGGESTED_RANGE.exec(msg);
  if (!m) return null;
  const lo = BigInt(m[1]), hi = BigInt(m[2]);
  if (lo !== fromBlock || hi <= fromBlock || hi >= toBlock) return null;
  return hi;
}

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
 * A rate limit is NOT a width complaint, however much it reads like one.
 *
 * `TOO_WIDE` matches "too many" — and the rate-limited form of this endpoint's refusal is
 * "too many requests". Left alone, a 429 would halve the range and issue TWO queries
 * against an endpoint that just said stop, then four, then eight. The transport gate in
 * chain.ts is what actually waits it out; this only makes sure the splitter hands it back
 * intact instead of multiplying it.
 */
const RATE_LIMITED = /\brate.?limit|too many requests|\b429\b/i;

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
    const msg = messageOf(e);
    if (RATE_LIMITED.test(msg) || !TOO_WIDE.test(msg) || toBlock - fromBlock < 1n) throw e;
    const mid = suggestedSplit(msg, fromBlock, toBlock) ?? fromBlock + (toBlock - fromBlock) / 2n;
    const [a, b] = await Promise.all([
      getLogsChunked(makeCall, fromBlock, mid, opts),
      getLogsChunked(makeCall, mid + 1n, toBlock, opts),
    ]);
    return [...a, ...b];
  }
}

/**
 * "I do not hold blocks this old" — a RETENTION refusal, not a width one. Distinct from
 * TOO_WIDE on purpose: a wide-but-recent range is fixed by narrowing its WIDTH; a range
 * that predates retention is not fixed by narrowing it AT ALL, only by asking for blocks
 * the provider still has. Folding this into TOO_WIDE's blind halving would recurse a
 * genesis-to-head query down toward single-block chunks across the entire unreadable
 * history — millions of doomed calls — before ever reaching the much narrower readable
 * tail. See `getLogsFromGenesis`, which handles it with a bounded floor search instead.
 */
const PRUNED = /pruned|history unavailable|no state available|missing trie node/i;

/** Exported for the tests and for callers deciding whether a failure is retention-shaped. */
export const isPruned = (e: unknown): boolean => PRUNED.test(messageOf(e));

/**
 * Binary-searches for the oldest block a "from genesis" query can currently reach, when a
 * provider prunes state older than some retention window it does not name up front.
 *
 * `probe(from)` must answer the RETENTION question only — true for a `from` the provider
 * will still serve, false for one it refuses as pruned — for a FIXED, narrow width chosen
 * by the caller, so a width refusal can never be misread as a retention one here.
 *
 * `probe(high)` is assumed true (the tip is never pruned). The search stops once the
 * boundary is known to within `tolerance` blocks, always erring on the HIGH (more
 * conservative, further-forward) side, so a caller never mistakes an unreadable block for
 * a readable one.
 */
export async function findLogFloor(
  probe: (from: bigint) => Promise<boolean>,
  low: bigint,
  high: bigint,
  tolerance = 200n,
): Promise<bigint> {
  let lo = low, hi = high;
  while (hi - lo > tolerance) {
    const mid = lo + (hi - lo) / 2n;
    if (await probe(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/**
 * getLogs from genesis, for a caller that would otherwise fix `fromBlock` at `0n` and get
 * refused outright the moment ANY part of that range predates the provider's retention —
 * this is what broke `analyzeTx`'s v4 mint search on Arc: the mint itself was only ~18k
 * blocks old, well inside the provider's own ~500k-block window, but the query still named
 * `fromBlock: 0` over a 21M-block-tall chain and was refused before it ever got to look.
 *
 * Tries the honest genesis-to-head query first via `getLogsChunked` (width-splitting still
 * applies normally) and only pays for a floor search on an actual retention refusal.
 *
 * `truncatedAt` is non-null exactly when part of the requested range could not be read.
 * The caller MUST treat that as "unknown," never as "there is nothing here": an empty
 * `logs` with `truncatedAt: null` means the range was read in full and genuinely had no
 * matches, while an empty `logs` with `truncatedAt` set means the true answer may be
 * sitting in blocks this provider no longer serves.
 */
export async function getLogsFromGenesis<TLog>(
  makeCall: (fromBlock: bigint, toBlock: bigint) => Promise<TLog[]>,
  toBlock: bigint,
  opts: { transientAttempts?: number; sleep?: (ms: number) => Promise<void>; probeWidth?: bigint } = {},
): Promise<{ logs: TLog[]; truncatedAt: bigint | null }> {
  try {
    return { logs: await getLogsChunked(makeCall, 0n, toBlock, opts), truncatedAt: null };
  } catch (e) {
    if (!isPruned(e)) throw e;
    const probeWidth = opts.probeWidth ?? 100n;
    const floor = await findLogFloor(async (from) => {
      try {
        await makeCall(from, from + probeWidth);
        return true;
      } catch (e2) {
        if (isPruned(e2)) return false;
        throw e2;
      }
    }, 0n, toBlock);
    return { logs: await getLogsChunked(makeCall, floor, toBlock, opts), truncatedAt: floor };
  }
}
