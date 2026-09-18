/**
 * One-off check, run manually before flipping the Arc toggle on for real users:
 * confirms the v4 addresses ARC_CHAIN assumes (copied from Robinhood on the strength of
 * CREATE2 determinism — see uniswap-v3-pnl.ts's ARC_CHAIN comment) actually have code
 * deployed at them on Arc. Requires a real ARC_RPC_URL — pass it as an env var, since
 * this script talks to the RPC directly (no /rpc proxy, no Netlify).
 *
 * Usage: ARC_RPC_URL=https://... npx tsx web/scripts/verify-arc-addresses.ts
 */
import { createPublicClient, http } from "viem";
import { ARC_CHAIN } from "../src/lib/uniswap-v3-pnl";

async function main() {
  const rpcUrl = process.env.ARC_RPC_URL;
  if (!rpcUrl) {
    console.error("Set ARC_RPC_URL to a real Arc RPC endpoint before running this script.");
    process.exit(1);
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const checks: [string, string][] = [
    ["PositionManager", ARC_CHAIN.uniswapV4.positionManager],
    ["PoolManager", ARC_CHAIN.uniswapV4.poolManager],
    ["StateView", ARC_CHAIN.uniswapV4.stateView],
  ];
  let ok = true;
  for (const [name, address] of checks) {
    const code = await client.getCode({ address: address as `0x${string}` });
    const hasCode = !!code && code !== "0x";
    console.log(`${hasCode ? "OK  " : "FAIL"}  ${name.padEnd(16)} ${address}`);
    if (!hasCode) ok = false;
  }
  if (!ok) {
    console.error("\nOne or more assumed v4 addresses have NO CODE on Arc. Do not enable the Arc toggle for real users until this is resolved — see ARC_CHAIN's comment in uniswap-v3-pnl.ts.");
    process.exit(1);
  }
  console.log("\nAll assumed v4 addresses have code on Arc.");
}

main();
