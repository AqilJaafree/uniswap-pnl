/**
 * When a 200 is not an answer — the two bodies that must make /rpc try the next upstream.
 *
 * The spillover chain reads as if a failed upstream always announces itself at the
 * transport layer (429, 5xx, a dead socket). Two do not, and both arrive as HTTP 200 with
 * a JSON-RPC error inside:
 *
 *   RATE LIMIT       "come back later" — some providers signal it in the body, not the
 *                    status. Already handled; moved here so both live together.
 *   UNSERVICEABLE    "not me, ever" — the upstream is structurally unable to serve this
 *                    request. On this chain that is the public node meeting an archive
 *                    read: it answers every `eth_call` pinned outside its ~14-day window
 *                    with `-32000 metadata is not found`, at HTTP 200.
 *
 * The second one is why this module exists. Because the status was 200 and the body did
 * not look like a rate limit, the proxy returned it as the FINAL answer and never tried
 * the archive upstream sitting behind it in the chain. The browser then saw a hard
 * JSON-RPC error from a read it had every right to expect, and chain-v4.ts read that
 * error as a fact about the chain ("this block is pruned") rather than about the route.
 * Downstream that is a position's fees silently booked as 0, or its tick falling through
 * to the pool's genesis — see feeGrowthAt / slot0TickAt.
 *
 * Kept separate from lane-order.ts but for the same reason it lives in netlify/lib/ and
 * not beside rpc.ts: Netlify deploys every top-level file in netlify/edge-functions/ AS
 * its own edge function, so shared code and its tests must sit outside that directory.
 *
 * server.mjs (the Railway rollback path) mirrors these two rules inline. Change them here
 * and change them there too.
 */

/** Every `error` object in a response body, whether it is a single call or a batch. */
function errorsIn(text: string): { code?: unknown; message?: unknown }[] {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : [j];
    return list.filter((x) => x && typeof x === "object" && x.error).map((x) => x.error);
  } catch {
    // A non-JSON body (an HTML error page, an empty response) is not a JSON-RPC refusal.
    // It is either already a non-200 — handled by the status check — or genuinely
    // unparseable, and guessing at it is how a proxy starts retrying real answers.
    return [];
  }
}

/**
 * Cheap reject before any parsing.
 *
 * A successful JSON-RPC response has no `error` member at all, and the bodies flowing
 * through this proxy are `eth_getLogs` output — megabytes of it. Parsing every one of
 * them to discover it is fine would spend the edge function's 50ms CPU budget on the
 * common case. A substring test settles it; the parse happens only for the bodies that
 * could actually carry a refusal.
 */
export function mightHoldError(text: string): boolean {
  return text.includes('"error"');
}

/** A rate limit: "come back later". Some providers signal it in the body, not the status. */
function isRateLimitError(err: { code?: unknown; message?: unknown }): boolean {
  if (err.code === -32005 || err.code === -32097) return true; // limit exceeded
  return /rate.?limit|too many|exceeded|quota/i.test(String(err.message || ""));
}

/**
 * "Not me, ever" — a RETENTION or ROUTING fact. The node does not hold the state the
 * request names, and a different upstream may well hold it, which is the whole point of
 * spilling. Anchored on the phrase rather than the code because `-32000` is a catch-all:
 * this chain's load balancer uses it for a dead backend and geth uses it for pruned state.
 *
 * Deliberately NOT here: `execution reverted`. A revert IS an answer — the next upstream
 * reverts identically, so spilling on it would triple the cost of learning the same thing
 * and would mask a contract-level failure as a routing problem. Same for malformed
 * requests: no upstream can fix those.
 *
 * `state (?:\S+ )?(?:is )?not available` was `state (?:is )?not available` — measured
 * live against the deployed public RPC, its CURRENT wording is "historical state
 * <64-char-hash> is not available", with a state-root hash sitting between "state" and
 * "is not available" that the old pattern had no room for. This node has changed its
 * wording before (the module header already lists two other forms); the extra `(?:\S+ )?`
 * tolerates one arbitrary token there without loosening the match elsewhere — "state not
 * available" and "state is not available" both still match via backtracking to zero
 * occurrences. Found because EVERY archive read has been silently returning this refusal
 * as if it were the final answer, never reaching the paid endpoint that could serve it —
 * exactly the failure this file exists to prevent, undetected because nothing was
 * asserting against the node's actual current wording.
 */
const UNSERVICEABLE =
  /metadata is not found|missing trie node|header not found|block not found|no state available|state (?:\S+ )?(?:is )?not available|state at block \S+ not found|pruned/i;

function isUnserviceableError(err: { message?: unknown }): boolean {
  return UNSERVICEABLE.test(String(err.message || ""));
}

/**
 * Why this response must not be treated as the final answer — from ONE parse.
 *
 * The handler asks both questions of every upstream response, and asking them as two
 * independent predicates parsed the body twice. Returning the REASON rather than a
 * boolean also keeps the log line specific: "body rate-limit" and "cannot serve this
 * request" are different facts, and the distinction matters most exactly when the logs
 * are being read to work out why a scan came back wrong.
 *
 * A rate limit wins when both match, because it is the more recoverable reading: the same
 * upstream may answer this very request a moment later.
 */
export function spillReason(text: string): "rate-limit" | "unserviceable" | null {
  if (!mightHoldError(text)) return null;
  const errs = errorsIn(text);
  if (!errs.length) return null;
  if (errs.some(isRateLimitError)) return "rate-limit";
  // In a BATCH, one unserviceable call condemns the whole response: the caller cannot use
  // a partial batch, and re-sending is safe because every method here is a read.
  if (errs.some(isUnserviceableError)) return "unserviceable";
  return null;
}

/**
 * The two reasons as standalone predicates.
 *
 * These are what the tests assert against and what server.mjs mirrors; the handler itself
 * uses spillReason so it parses once.
 */
export function isRateLimitBody(text: string): boolean {
  return spillReason(text) === "rate-limit";
}

export function isUnserviceableBody(text: string): boolean {
  return spillReason(text) === "unserviceable";
}
