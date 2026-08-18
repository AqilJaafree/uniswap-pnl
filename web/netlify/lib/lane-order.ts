/**
 * Which upstreams a /rpc request is tried against, and in what order.
 *
 * Extracted from rpc.ts and kept free of Netlify types so it can be unit-tested with tsx
 * — see lane-order.test.ts. This is the function that decides which endpoint receives a
 * request, and therefore which one an API key is spent on, so it is the part that most
 * deserves a test and the least deserves to live inline in a handler.
 *
 * It lives in netlify/lib/ rather than beside rpc.ts, and that is NOT a style choice:
 * Netlify deploys every top-level file in netlify/edge-functions/ AS its own edge
 * function. A shared module there is deployed as a function with no handler, and a test
 * file there is deployed as one too — which is how this first shipped, and it failed the
 * build. Shared code and its tests belong outside that directory.
 *
 * Note `vite build` does not bundle edge functions, so only `netlify build` catches this
 * class of error.
 *
 * server.mjs (the Railway original, kept as a rollback path) mirrors this rule inline. If
 * you change the order here, change it there too.
 */

export interface Upstream {
  url: string;
  label: "wallet" | "public" | "paid";
}

export interface LaneConfig {
  publicRpc: string;
  paidRpc?: string;
  walletRpc?: string;
  lane?: string | null;
}

/**
 * Ordinary traffic: public first (free), paid last (spillover only).
 *
 * The wallet lane: the dedicated endpoint FIRST, then the ordinary chain as backup.
 * Putting it last instead would defeat the point — a wallet scan would still spend the
 * free endpoint's budget and pay a failed round trip before every heavy query.
 *
 * An unset walletRpc, or any lane value other than "wallet", degrades to the ordinary
 * order rather than failing: the lane is a preference, never a requirement.
 */
export function orderUpstreams(cfg: LaneConfig): Upstream[] {
  const list: Upstream[] = [];
  if (cfg.lane === "wallet" && cfg.walletRpc) {
    list.push({ url: cfg.walletRpc, label: "wallet" });
  }
  list.push({ url: cfg.publicRpc, label: "public" });
  if (cfg.paidRpc) list.push({ url: cfg.paidRpc, label: "paid" });
  return list;
}
