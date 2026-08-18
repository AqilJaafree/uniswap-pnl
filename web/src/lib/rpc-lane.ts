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
  onLane: (method: unknown) => boolean = isLaneMethod,
): Transport {
  return (params) => {
    const base = defaultTransport(params);
    const lane = laneTransport(params);
    const request: typeof base.request = async (...args) => {
      const method = (args[0] as { method?: unknown } | undefined)?.method;
      return onLane(method) ? lane.request(...args) : base.request(...args);
    };
    return { ...base, request };
  };
}
