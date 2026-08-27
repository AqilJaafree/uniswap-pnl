/**
 * Did this read fail because the CHAIN has no answer, or because the ROUTE to it broke?
 *
 * The two archive reads a v4 position depends on — `feeGrowthAt` and `slot0TickAt` — both
 * used to answer that question the same way for every failure: `catch { return null }`,
 * commented "pruned (>~14 days)". Null is then consumed as a FACT about the chain. It
 * makes a position's unclaimed fees exactly 0 and sends its tick down the fallback chain
 * to the pool's genesis, which chain-v4.ts's own comment calls "frequently WRONG".
 *
 * A rate limit, a dead socket, or a proxy that ran out of upstreams produces the very
 * same null — and unlike a pruned block, those recover. That is what made two scans of
 * one wallet disagree: `cachedPoint` persists a successful read and not a failed one, so
 * each scan re-rolled the dice on whatever had failed last time, and the headline moved
 * with it. Nothing on screen said the number was provisional.
 *
 * So classify, and let the default protect the number. The two outcomes are NOT
 * symmetric:
 *
 *   guess "transient" wrongly   costs a retry, then the honest null
 *   guess "permanent" wrongly   writes a fabricated figure into a headline that never
 *                               admits to being unsure
 *
 * Anything unrecognised is therefore transient. Callers turn that into a rethrow, which
 * `analyzeWallet`'s per-position `retry` absorbs; if it still fails, the position lands in
 * `skipped` and is BANNERED rather than silently mispriced.
 */

/** viem buries the upstream's own wording in `details` and puts its own gloss in `message`. */
function messageOf(e: unknown): string {
  const err = e as { details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown };
  if (!err || typeof err !== "object") return typeof e === "string" ? e : "";
  const parts = [err.details, err.shortMessage, err.message].filter((x) => typeof x === "string");
  // One level of cause: viem nests the transport error under the contract error, and the
  // socket wording that identifies a transient failure only exists down there.
  if (err.cause) parts.push(messageOf(err.cause));
  return parts.join(" | ");
}

/**
 * The state genuinely is not available, from any upstream, and a retry will not change
 * that. Same vocabulary as netlify/lib/spill.ts's UNSERVICEABLE — deliberately: after the
 * proxy learned to spill on those bodies, one reaching the browser means EVERY upstream
 * refused it, which is exactly when "pruned" becomes the honest reading.
 *
 * A REVERT and an empty return belong here too, and they must be matched on VIEM's
 * wording, not the node's: viem raises its own ContractFunctionExecutionError reading
 * "The contract function ... reverted." and never passes "execution reverted" through.
 * Matching only the node's phrasing left every real revert looking transient — three
 * retries, then a skipped position, for a question the chain had already answered.
 */
const PERMANENT =
  /metadata is not found|missing trie node|header not found|block not found|no state available|state (?:is )?not available|state at block \S+ not found|pruned|revert(?:ed|s)?\b|returned no data/i;

/**
 * A statement about the route rather than the chain. Checked FIRST, because some of these
 * carry wording that overlaps the permanent set once a proxy wraps them — "all RPC
 * upstreams failed" is the proxy's own summary of a chain that included a pruned node,
 * and it must not be mistaken for the pruned node's own answer.
 */
const TRANSIENT =
  /rate.?limit|too many requests|\b429\b|all RPC upstreams failed|no route to host|dial tcp|connection refused|connection reset|broken pipe|socket hang up|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out|timeout|took too long|bad gateway|service unavailable|\b50[234]\b/i;

export function isPermanentReadFailure(e: unknown): boolean {
  const msg = messageOf(e);
  if (!msg) return false;
  if (TRANSIENT.test(msg)) return false;
  return PERMANENT.test(msg);
}
