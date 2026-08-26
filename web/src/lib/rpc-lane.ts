/**
 * Two upstream lanes behind one viem client.
 *
 * A wallet scan is dominated by `eth_getLogs`: `restrictToOwner` alone issues a
 * full-range query per position, and `getLogsChunked` turns any one of those into a
 * cascade of halved ranges when the 10k-result cap bites. Those are the calls that
 * exhaust a free endpoint's budget, and they are the reason the paid endpoint exists.
 * Everything else the app does — `readContract`, receipts, block timestamps — is small,
 * cheap and bursty, and has no business competing with them.
 *
 * So requests are split by METHOD, at the transport, rather than by call site. One rule
 * in one place: it cannot be forgotten by a new caller, it survives refactors of the
 * analysis code, and — because the lane is a query parameter on the same-origin `/rpc`
 * proxy — the endpoint it actually resolves to stays SERVER-SIDE. That last part is the
 * whole security argument: an Alchemy URL's path is an API key, and anything the browser
 * can read is public. The browser learns only the word "wallet".
 *
 * Pure and viem-shaped so it can be unit-tested with fake transports — see
 * rpc-lane.test.ts.
 */
import type { Transport } from "viem";

/** The JSON-RPC methods worth their own upstream. */
export const LANE_METHODS = new Set(["eth_getLogs"]);

export function isLaneMethod(method: unknown): boolean {
  return typeof method === "string" && LANE_METHODS.has(method);
}

/**
 * Is this block tag a specific PAST block, rather than the chain head?
 *
 * viem sends a pinned block as a hex quantity and the head as one of the named tags, so
 * the two are trivially separable. Anything unrecognised is treated as "not historical":
 * the lane is an optimisation, and the cost of guessing wrong in that direction is one
 * ordinary request, while guessing wrong in the other spends a paid one on nothing.
 */
export function isHistoricalBlockTag(tag: unknown): boolean {
  return typeof tag === "string" && tag.startsWith("0x") && tag.length > 2;
}

/**
 * Which REQUESTS take the wallet lane.
 *
 * `eth_getLogs` always does — see above. `eth_call` splits on its block tag, because the
 * two kinds are different products: a call pinned to a past block is an ARCHIVE read, and
 * this chain's public node answers every one of them with `-32000 metadata is not found`
 * once the block leaves its ~14-day window. That is not a slow path, it is a missing one:
 * `feeGrowthInside` at a position's mint and exit blocks is the ONLY way a closed
 * position's fees can be measured when the explorer has no trace for its exit, so losing
 * it reports a real position as flat (`~ fees partial`) rather than as what it earned —
 * live, v4 #892396's entire +10.04%.
 *
 * A call at the head is not an archive read, and those are the great majority: every
 * token symbol and decimals, every current tick, every liquidity read. They stay on the
 * ordinary endpoint, which answers them perfectly well and for free.
 */
export function isLaneRequest(request: unknown): boolean {
  const { method, params } = (request ?? {}) as { method?: unknown; params?: unknown };
  if (typeof method !== "string") return false;
  if (LANE_METHODS.has(method)) return true;
  return method === "eth_call" && Array.isArray(params) && isHistoricalBlockTag(params[1]);
}

/**
 * The same endpoint, tagged for the wallet lane.
 *
 * `searchParams.set` rather than string concatenation, so a base URL that already carries
 * a query keeps it and gains one more. An unparseable base is returned untouched: the
 * fallback is "use the ordinary lane", never "throw while building a client".
 */
export function laneUrl(base: string, lane = "wallet"): string {
  try {
    const u = new URL(base);
    u.searchParams.set("lane", lane);
    return u.toString();
  } catch {
    return base;
  }
}

/**
 * Route each request to one of two transports by its method.
 *
 * Both are instantiated once, at client construction, because a viem transport carries
 * per-instance state (its retry bookkeeping) that building one per request would discard.
 * Everything other than `request` is taken from the default transport, so the client's
 * view of `config`/`value` is unchanged.
 */
export function laned(
  defaultTransport: Transport,
  laneTransport: Transport,
  onLane: (request: unknown) => boolean = isLaneRequest,
): Transport {
  return (params) => {
    const base = defaultTransport(params);
    const lane = laneTransport(params);
    // The whole request, not just its method: `eth_call` is routed on its block tag.
    const request: typeof base.request = async (...args) =>
      (onLane(args[0]) ? lane : base).request(...args);
    return { ...base, request };
  };
}
