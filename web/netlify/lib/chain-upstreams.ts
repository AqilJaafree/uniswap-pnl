/**
 * Which chain's env vars a /rpc request reads, and the "not configured" sentinel.
 *
 * Pure and framework-free so it can be unit-tested with a plain object standing in for
 * Netlify's env — see chain-upstreams.test.ts. Lives beside lane-order.ts (which decides
 * the ORDER once the URLs are known) for the same reason lane-order.ts isn't inline in
 * rpc.ts: a file in netlify/edge-functions/ is deployed as its own function, so shared
 * decision logic and its tests belong here instead.
 */
import { orderUpstreams, type Upstream } from "./lane-order.ts";

export type EnvLookup = Record<string, string | undefined>;

/**
 * Robinhood (chain is null or anything other than "arc"): its EXACT existing env-var
 * names and default — zero behavior change for the live path.
 *
 * Arc: separate env vars, NO default. Arc mainnet opened 2026-09-16 and no scraped
 * public RPC URL is trustworthy enough to hardcode (see the design doc's "Background /
 * on-chain facts"). An unset ARC_RPC_URL returns `null` — the caller (rpc.ts) responds
 * with a distinct, recognizable error instead of guessing an endpoint.
 */
export function resolveChainUpstreams(
  chain: string | null,
  env: EnvLookup,
  lane: string | null,
  robinhoodDefaultPublicRpc: string,
): Upstream[] | null {
  if (chain === "arc") {
    const publicRpc = env.ARC_RPC_URL || "";
    if (!publicRpc) return null;
    return orderUpstreams({
      publicRpc,
      paidRpc: env.ARC_PAID_RPC_URL || "",
      walletRpc: env.ARC_WALLET_RPC_URL || "",
      lane,
    });
  }
  return orderUpstreams({
    publicRpc: env.PUBLIC_RPC_URL || robinhoodDefaultPublicRpc,
    paidRpc: env.PAID_RPC_URL || "",
    walletRpc: env.WALLET_RPC_URL || "",
    lane,
  });
}
