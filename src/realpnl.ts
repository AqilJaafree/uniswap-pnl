import { computePnL, formatCard, type LiquidityEvent, type PairMeta, type PriceFeed } from "./uniswap-v3-pnl";

// ── Position 107675 (0x01a69b), pool 0x191ae9…fe6d, WETH/WORTH, 1% fee ──
const WETH = 18, WORTH = 18;
const tickLower = 136600, tickUpper = 141200;

// Raw on-chain amounts decoded from the multicall traces:
const mintWeth = 0x2032ddb15df413n;                 // WETH deposited (tx2)
const decWeth  = 0x038c4585896988n,  decWorth = 0x01c99e52be9ce22fa216n; // principal out (tx3 decrease)
const colWeth  = 0x08529e5d478bcfn,  colWorth = 0x021c6643902239a92af0n; // principal+fees (tx3 collect)
const feeWeth  = colWeth - decWeth,  feeWorth = colWorth - decWorth;

const L      = 0x2362fd9521f436e39n;                // position liquidity
const T_mint = 0x6a553425;                          // tx2 timestamp (deadline proxy)
const T_exit = 0x6a5611af;                          // tx3 timestamp

// ── Derive EXIT price from the burn amounts (v3 in-range math) ──
//   y = L(√P − √pa)  ⇒  √P = √pa + y/L   (raw units; both tokens 18 dec)
const sqrtPa = Math.pow(1.0001, tickLower / 2);
const sqrtPb = Math.pow(1.0001, tickUpper / 2);
const sqrtPexit = sqrtPa + Number(decWorth) / Number(L);
const Pexit = sqrtPexit * sqrtPexit;                // WORTH per WETH at exit
// consistency check: x = L(1/√P − 1/√pb) should equal decWeth
const xCheck = Number(L) * (1 / sqrtPexit - 1 / sqrtPb);
console.log(`exit price: 1 WETH = ${Pexit.toFixed(0)} WORTH  (1 WORTH = ${(1 / Pexit).toExponential(3)} WETH)`);
console.log(`x-check: predicted WETH principal ${(xCheck / 1e18).toFixed(8)} vs actual ${(Number(decWeth) / 1e18).toFixed(8)}\n`);

// ── Value everything with WETH as the numeraire (p0=WETH=1, p1=WORTH in WETH) ──
const price: PriceFeed = (_t) => ({ p0: 1, p1: 1 / Pexit });

const pair: PairMeta = {
  symbol0: "WETH", symbol1: "WORTH", decimals0: WETH, decimals1: WORTH,
  feeUnits: 10000, rangeLower: Math.round(Pexit), rangeUpper: undefined as any,
};

const events: LiquidityEvent[] = [
  { kind: "increase", tokenId: 107675n, txHash: "0xmint", blockNumber: 1n, timestamp: T_mint, amount0: mintWeth, amount1: 0n, liquidity: L },
  { kind: "decrease", tokenId: 107675n, txHash: "0xexit", blockNumber: 2n, timestamp: T_exit, amount0: decWeth, amount1: decWorth, liquidity: L },
  { kind: "collect",  tokenId: 107675n, txHash: "0xexit", blockNumber: 2n, timestamp: T_exit, amount0: colWeth, amount1: colWorth },
];

const gasWeth = (0x19da205ed210n - 0x4b6a5bd3700n) + (0x105b6a582570n - 0x5141b0a1390n); // tx2+tx3 net gas
const r = computePnL(events, pair, price, { gasUsd: Number(gasWeth) / 1e18 });

const ETHUSD = 3000; // assumed — swap for the real block price
const E = (w: number) => `Ξ${w.toFixed(6)}`;
const U = (w: number) => `${w < 0 ? "-" : "+"}$${Math.abs(w * ETHUSD).toFixed(2)}`;

console.log("Position 107675  WETH/WORTH 1%  •  held ~16h");
console.log("──────────────────────────────────────────────────────────");
console.log(`Deposited   ${r.deposited0.toFixed(6)} WETH                         ${E(r.depositedUsd)}   $${(r.depositedUsd * ETHUSD).toFixed(2)}`);
console.log(`Withdrawn   ${r.withdrawn0.toFixed(6)} WETH + ${r.withdrawn1.toFixed(0)} WORTH   ${E(r.withdrawnUsd)}`);
console.log(`Fees        ${r.fees0.toFixed(6)} WETH + ${r.fees1.toFixed(0)} WORTH   ${E(r.feesUsd)}`);
console.log(`Gas         ${r.gasUsd.toFixed(6)} WETH (mint+exit)`);
console.log("──────────────────────────────────────────────────────────");
console.log(`Net PnL     ${E(r.netPnlUsd)}   (${(r.pnlPct * 100).toFixed(2)}%)     ${U(r.netPnlUsd)}  @ ETH=$${ETHUSD}`);
console.log(`  ├ Fee PnL       ${E(r.feesUsd)}   ${U(r.feesUsd)}`);
console.log(`  ├ Price / HODL  ${E(r.pricePnlUsd)}   ${U(r.pricePnlUsd)}   (held WETH baseline)`);
console.log(`  └ IL            ${E(r.ilUsd)}   ${U(r.ilUsd)}`);
console.log(`APR (naive)  ${(r.aprPct * 100).toFixed(0)}%`);
