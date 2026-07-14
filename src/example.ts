import { computePnL, formatCard, type LiquidityEvent, type PairMeta, type PriceFeed } from "./uniswap-v3-pnl";

// WETH = token0 (18 dec), USDC = token1 (6 dec) for this illustration.
const pair: PairMeta = {
  symbol0: "WETH", symbol1: "USDC", decimals0: 18, decimals1: 6,
  feeUnits: 3000, rangeLower: 2500, rangeUpper: 3500,
};

const wei = (n: number) => BigInt(Math.round(n * 1e18));
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

const T0 = 1_700_000_000;      // entry
const T1 = T0 + 15 * 86_400;   // mid-life fee claim
const T2 = T0 + 30 * 86_400;   // exit

const events: LiquidityEvent[] = [
  { kind: "increase", tokenId: 1n, txHash: "0xopen", blockNumber: 1n, timestamp: T0, amount0: wei(1.0),  amount1: usdc(3000) },
  // mid-life Collect, no Decrease → pure fee claim
  { kind: "collect",  tokenId: 1n, txHash: "0xclaim", blockNumber: 2n, timestamp: T1, amount0: wei(0.05), amount1: usdc(40) },
  // exit multicall: Decrease (principal) + Collect (principal + fees)
  { kind: "decrease", tokenId: 1n, txHash: "0xexit", blockNumber: 3n, timestamp: T2, amount0: wei(0.60), amount1: usdc(4000) },
  { kind: "collect",  tokenId: 1n, txHash: "0xexit", blockNumber: 3n, timestamp: T2, amount0: wei(0.68), amount1: usdc(4090) },
];

const price: PriceFeed = (t) => {
  if (t <= T0) return { p0: 3000, p1: 1 }; // ETH $3000 at entry
  return { p0: 3300, p1: 1 };              // ETH $3300 for claim + exit
};

const r = computePnL(events, pair, price);
console.log(formatCard(r));
console.log("\nidentity check  price + IL + fees =",
  (r.pricePnlUsd + r.ilUsd + r.feesUsd).toFixed(2), " netPnL =", r.netPnlUsd.toFixed(2));
