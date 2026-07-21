/**
 * Uniswap v3 LP PnL tracker — "paste exit tx → trace → PnL" flow.
 *
 * Layers:
 *   1. Pure core (no deps): types + PnL math + Metlex-style card.  ← the testable value
 *   2. Optional decoder (viem): raw tx receipt → LiquidityEvent[].
 *
 * Key mechanic: on the NonfungiblePositionManager, `Collect` pays out
 * principal + fees together. `DecreaseLiquidity` only *credits* principal.
 * So within one tx:  fees = Collect.amount − DecreaseLiquidity.amount.
 * A `Collect` with no paired `DecreaseLiquidity` is a pure fee claim.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. DOMAIN TYPES (dependency-free)
// ─────────────────────────────────────────────────────────────────────────

export type EventKind = "increase" | "decrease" | "collect";

/** One decoded NonfungiblePositionManager event, keyed by the NFT tokenId. */
export interface LiquidityEvent {
  kind: EventKind;
  tokenId: bigint;
  txHash: string;
  blockNumber: bigint;
  timestamp: number; // unix seconds
  amount0: bigint; // raw base units (token0)
  amount1: bigint; // raw base units (token1)
  liquidity?: bigint; // present on increase/decrease
}

/** Static metadata for the pool's two tokens (order = Uniswap address order). */
export interface PairMeta {
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  feeUnits?: number; // Uniswap fee in millionths: 500=0.05%, 3000=0.30%, 10000=1%
  rangeLower?: number; // display only, in price(token1/token0)
  rangeUpper?: number;
}

/** USD price of one *whole* token0 and token1 at a point in time. */
export interface PricePoint {
  p0: number;
  p1: number;
}

/** Supply prices at arbitrary timestamps (subgraph, oracle, CEX klines, …). */
export type PriceFeed = (timestampSec: number) => PricePoint;

export interface PnLResult {
  pair: PairMeta;
  openedAt: number;
  closedAt: number;
  durationDays: number;

  // token totals (whole units)
  deposited0: number;
  deposited1: number;
  withdrawn0: number;
  withdrawn1: number;
  fees0: number;
  fees1: number;

  // USD figures
  depositedUsd: number;
  withdrawnUsd: number;
  feesUsd: number;
  hodlUsd: number;

  // PnL decomposition — identity: netPnlUsd = pricePnlUsd + ilUsd + feesUsd
  pricePnlUsd: number; // HODL appreciation of the deposited tokens
  ilUsd: number; // impermanent loss (≤ 0)
  netPnlUsd: number;
  pnlPct: number;
  aprPct: number;

  gasUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. PURE CORE
// ─────────────────────────────────────────────────────────────────────────

const toWhole = (raw: bigint, decimals: number): number =>
  Number(raw) / 10 ** decimals;

/**
 * Group raw events by tx and resolve each into deposits / principal-out / fees.
 * This is where the Collect-minus-Decrease trick lives.
 */
function resolveActions(events: LiquidityEvent[]) {
  const deposits: LiquidityEvent[] = [];
  const withdrawals: { amount0: bigint; amount1: bigint; timestamp: number }[] = [];
  const feeClaims: { amount0: bigint; amount1: bigint; timestamp: number }[] = [];

  const byTx = new Map<string, LiquidityEvent[]>();
  for (const e of events) {
    const g = byTx.get(e.txHash) ?? [];
    g.push(e);
    byTx.set(e.txHash, g);
  }

  for (const group of byTx.values()) {
    const inc = group.find((e) => e.kind === "increase");
    const dec = group.find((e) => e.kind === "decrease");
    const col = group.find((e) => e.kind === "collect");

    if (inc) deposits.push(inc);

    if (dec) {
      withdrawals.push({ amount0: dec.amount0, amount1: dec.amount1, timestamp: dec.timestamp });
    }

    if (col) {
      // Fees = collected − principal removed in the same tx (0 if no decrease).
      const fee0 = col.amount0 - (dec?.amount0 ?? 0n);
      const fee1 = col.amount1 - (dec?.amount1 ?? 0n);
      if (fee0 > 0n || fee1 > 0n) {
        feeClaims.push({ amount0: fee0, amount1: fee1, timestamp: col.timestamp });
      }
    }
  }

  return { deposits, withdrawals, feeClaims };
}

export interface ComputeOptions {
  /** Value each fee at its claim-time price (default) vs. at exit price. */
  feeValuation?: "claim-time" | "exit";
  /** Total gas spent across the position's txs, already converted to USD. */
  gasUsd?: number;
}

export function computePnL(
  events: LiquidityEvent[],
  pair: PairMeta,
  price: PriceFeed,
  opts: ComputeOptions = {},
): PnLResult {
  if (events.length === 0) throw new Error("no events for position");

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const openedAt = sorted[0].timestamp;
  const closedAt = sorted[sorted.length - 1].timestamp;
  const exitPx = price(closedAt);

  const { deposits, withdrawals, feeClaims } = resolveActions(sorted);

  // Token totals
  const sum = (arr: { amount0: bigint; amount1: bigint }[], k: "amount0" | "amount1") =>
    arr.reduce((acc, x) => acc + x[k], 0n);

  const dep0 = toWhole(sum(deposits, "amount0"), pair.decimals0);
  const dep1 = toWhole(sum(deposits, "amount1"), pair.decimals1);
  const wd0 = toWhole(sum(withdrawals, "amount0"), pair.decimals0);
  const wd1 = toWhole(sum(withdrawals, "amount1"), pair.decimals1);
  const fee0 = toWhole(sum(feeClaims, "amount0"), pair.decimals0);
  const fee1 = toWhole(sum(feeClaims, "amount1"), pair.decimals1);

  // USD valuations — each cashflow at the right timestamp.
  const depositedUsd = deposits.reduce((acc, e) => {
    const px = price(e.timestamp);
    return acc + toWhole(e.amount0, pair.decimals0) * px.p0 + toWhole(e.amount1, pair.decimals1) * px.p1;
  }, 0);

  const withdrawnUsd = withdrawals.reduce((acc, w) => {
    const px = price(w.timestamp); // == exit for a single-close position
    return acc + toWhole(w.amount0, pair.decimals0) * px.p0 + toWhole(w.amount1, pair.decimals1) * px.p1;
  }, 0);

  const feesUsd = feeClaims.reduce((acc, f) => {
    const px = opts.feeValuation === "exit" ? exitPx : price(f.timestamp);
    return acc + toWhole(f.amount0, pair.decimals0) * px.p0 + toWhole(f.amount1, pair.decimals1) * px.p1;
  }, 0);

  // HODL = the deposited tokens valued at exit price.
  const hodlUsd = dep0 * exitPx.p0 + dep1 * exitPx.p1;

  const gasUsd = opts.gasUsd ?? 0;
  const pricePnlUsd = hodlUsd - depositedUsd;
  const ilUsd = withdrawnUsd - hodlUsd; // ≤ 0 for in-range concentrated positions
  const netPnlUsd = withdrawnUsd + feesUsd - depositedUsd - gasUsd;
  const pnlPct = depositedUsd > 0 ? netPnlUsd / depositedUsd : 0;

  const durationDays = Math.max((closedAt - openedAt) / 86_400, 1 / 24);
  const aprPct = pnlPct * (365 / durationDays);

  return {
    pair,
    openedAt,
    closedAt,
    durationDays,
    deposited0: dep0,
    deposited1: dep1,
    withdrawn0: wd0,
    withdrawn1: wd1,
    fees0: fee0,
    fees1: fee1,
    depositedUsd,
    withdrawnUsd,
    feesUsd,
    hodlUsd,
    pricePnlUsd,
    ilUsd,
    netPnlUsd,
    pnlPct,
    aprPct,
    gasUsd,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. METLEX-STYLE OUTPUT CARD
// ─────────────────────────────────────────────────────────────────────────

const usd = (n: number) =>
  `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdPlain = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatCard(r: PnLResult): string {
  const p = r.pair;
  const tier = p.feeUnits != null ? `  (${(p.feeUnits / 10_000).toFixed(2)}% pool)` : "";
  const range =
    p.rangeLower != null && p.rangeUpper != null
      ? `$${p.rangeLower.toLocaleString()} – $${p.rangeUpper.toLocaleString()}`
      : "n/a";
  const line = "─".repeat(48);

  return [
    `Pair            ${p.symbol0} / ${p.symbol1}${tier}`,
    `Range           ${range}          status: closed`,
    `Duration        ${r.durationDays.toFixed(0)} days`,
    line,
    `Deposited       ${r.deposited0} ${p.symbol0} + ${r.deposited1} ${p.symbol1}   = ${usdPlain(r.depositedUsd)}`,
    `Withdrawn       ${r.withdrawn0} ${p.symbol0} + ${r.withdrawn1} ${p.symbol1}   = ${usdPlain(r.withdrawnUsd)}`,
    `Fees claimed    ${r.fees0} ${p.symbol0} + ${r.fees1} ${p.symbol1}   = ${usdPlain(r.feesUsd)}`,
    r.gasUsd ? `Gas             ${usdPlain(r.gasUsd)}` : null,
    line,
    `Net PnL         ${usd(r.netPnlUsd)}   (${(r.pnlPct * 100).toFixed(2)}%)`,
    `  ├ Fee PnL       ${usd(r.feesUsd)}`,
    `  ├ Price / HODL  ${usd(r.pricePnlUsd)}      (HODL value ${usdPlain(r.hodlUsd)})`,
    `  └ IL            ${usd(r.ilUsd)}`,
    `APR             ${(r.aprPct * 100).toFixed(0)}%`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// 4. ROBINHOOD CHAIN CONFIG  (this tracker targets Robinhood Chain ONLY)
// ─────────────────────────────────────────────────────────────────────────
//
// Robinhood Chain = Arbitrum Orbit L2, chainId 4663, native gas = ETH.
// Uniswap v3 is deployed with FRESH addresses (NOT the mainnet 0xC364…).
// Explorer is Blockscout (not Etherscan) — decode via RPC getLogs, which is
// explorer-agnostic, rather than the Etherscan-style log API.

export const ROBINHOOD_CHAIN = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  uniswapV3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    nonfungiblePositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    multicall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3",
    tickLens: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────
// 4b. MULTICALL TRACE DECODER  (dependency-free)
// ─────────────────────────────────────────────────────────────────────────
//
// Paste a Blockscout debug/trace object (the JSON with `input`/`output`/
// `beforeEVMTransfers`/`afterEVMTransfers`) and get LiquidityEvent[] back.
// We decode the TOP-LEVEL multicall calldata + return data rather than walking
// the nested call tree — amounts come from the function *outputs*, which is the
// source of truth (mint/decrease/collect all return their realized amounts).

/** Minimal shape of a Blockscout / debug_traceTransaction result we rely on. */
export interface RawTrace {
  to?: string;
  input: string;
  output: string;
  beforeEVMTransfers?: { purpose: string; value: string }[];
  afterEVMTransfers?: { purpose: string; value: string }[];
}

export interface TraceDecodeResult {
  events: LiquidityEvent[];
  pool?: { token0: string; token1: string; fee: number; tickLower: number; tickUpper: number };
  gasWei: bigint;
}

const SELECTOR = {
  multicall: "0xac9650d8", // multicall(bytes[])
  mint: "0x88316456", // mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
  increase: "0x219f5d17", // increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
  decrease: "0x0c49ccbe", // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
  collect: "0xfc6f7865", // collect((uint256,address,uint128,uint128))
} as const;

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);
const wordAt = (buf: string, i: number) => buf.slice(i * 64, i * 64 + 64);
const u256 = (w: string) => BigInt("0x" + (w || "0"));
const asAddr = (w: string) => "0x" + w.slice(24);
const asInt24 = (w: string) => {
  let v = BigInt("0x" + w);
  if (v >= 1n << 255n) v -= 1n << 256n; // ABI sign-extends int24 to 256 bits
  return Number(v);
};
const subWord = (elem: string, j: number) => elem.slice(8 + j * 64, 8 + j * 64 + 64); // after 4-byte selector
const selectorOf = (elem: string) => "0x" + elem.slice(0, 8);

/** Decode an ABI-encoded `bytes[]` (hex WITHOUT the leading offset stripped). */
function decodeBytesArray(hexNo0x: string): string[] {
  const arrOffWord = Number(u256(wordAt(hexNo0x, 0))) / 32; // = 1
  const n = Number(u256(wordAt(hexNo0x, arrOffWord)));
  const startWord = arrOffWord + 1; // first element-offset word
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const offBytes = Number(u256(wordAt(hexNo0x, startWord + i)));
    const lenWord = startWord + offBytes / 32;
    const byteLen = Number(u256(wordAt(hexNo0x, lenWord)));
    const start = (lenWord + 1) * 64;
    out.push(hexNo0x.slice(start, start + byteLen * 2));
  }
  return out;
}

export interface TraceOptions {
  timestampSec: number;
  txHash?: string;
  npm?: string;
}

export function fromMulticallTrace(trace: RawTrace, opts: TraceOptions): TraceDecodeResult {
  const npm = (opts.npm ?? ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager).toLowerCase();
  if (trace.to && trace.to.toLowerCase() !== npm) {
    throw new Error(`trace.to ${trace.to} is not the Robinhood Chain NPM ${npm}`);
  }

  // Split into per-call (input, output) pairs. Handle bare (non-multicall) txs too.
  let inputs: string[];
  let outputs: string[];
  if (selectorOf(strip(trace.input)) === SELECTOR.multicall) {
    inputs = decodeBytesArray(strip(trace.input).slice(8)); // args after the multicall selector
    outputs = decodeBytesArray(strip(trace.output));
  } else {
    inputs = [strip(trace.input)];
    outputs = [strip(trace.output)];
  }

  const txHash = opts.txHash ?? "0xtrace";
  const base = { txHash, blockNumber: 0n, timestamp: opts.timestampSec };
  const events: LiquidityEvent[] = [];
  let pool: TraceDecodeResult["pool"];

  for (let i = 0; i < inputs.length; i++) {
    const inEl = inputs[i];
    const outEl = outputs[i] ?? "";
    switch (selectorOf(inEl)) {
      case SELECTOR.mint: // amounts + tokenId come from the OUTPUT
        pool = {
          token0: asAddr(subWord(inEl, 0)), token1: asAddr(subWord(inEl, 1)),
          fee: Number(u256(subWord(inEl, 2))), tickLower: asInt24(subWord(inEl, 3)), tickUpper: asInt24(subWord(inEl, 4)),
        };
        events.push({ ...base, kind: "increase", tokenId: u256(wordAt(outEl, 0)), liquidity: u256(wordAt(outEl, 1)), amount0: u256(wordAt(outEl, 2)), amount1: u256(wordAt(outEl, 3)) });
        break;
      case SELECTOR.increase:
        events.push({ ...base, kind: "increase", tokenId: u256(subWord(inEl, 0)), liquidity: u256(wordAt(outEl, 0)), amount0: u256(wordAt(outEl, 1)), amount1: u256(wordAt(outEl, 2)) });
        break;
      case SELECTOR.decrease:
        events.push({ ...base, kind: "decrease", tokenId: u256(subWord(inEl, 0)), amount0: u256(wordAt(outEl, 0)), amount1: u256(wordAt(outEl, 1)) });
        break;
      case SELECTOR.collect:
        events.push({ ...base, kind: "collect", tokenId: u256(subWord(inEl, 0)), amount0: u256(wordAt(outEl, 0)), amount1: u256(wordAt(outEl, 1)) });
        break;
      // unwrapWETH9 / sweepToken / refundETH: token routing only, no PnL effect.
    }
  }

  const sumBy = (list: { purpose: string; value: string }[] | undefined, purpose: string) =>
    (list ?? []).filter((t) => t.purpose === purpose).reduce((a, t) => a + BigInt(t.value), 0n);
  const gasWei = sumBy(trace.beforeEVMTransfers, "feePayment") - sumBy(trace.afterEVMTransfers, "gasRefund");

  return { events, pool, gasWei };
}

/** Merge several traces (entry + mid-life claims + exit) into one event list. */
export function eventsFromTraces(traces: { trace: RawTrace; timestampSec: number; txHash?: string }[], npm?: string): LiquidityEvent[] {
  return traces
    .sort((a, b) => a.timestampSec - b.timestampSec)
    .flatMap((t) => fromMulticallTrace(t.trace, { timestampSec: t.timestampSec, txHash: t.txHash, npm }).events);
}

/**
 * Derive the in-range pool price (token1 per token0) at the moment a position
 * was burned, from the decrease amounts + liquidity + range. Only valid when the
 * burn returned BOTH tokens (price strictly inside [tickLower, tickUpper]).
 *   √P = √pa + amount1 / L   ⇒   price = (√P)^2   (assumes equal token decimals)
 */
export function impliedInRangePrice(amount1Raw: bigint, liquidity: bigint, tickLower: number, decimals0 = 18, decimals1 = 18): number {
  const sqrtPa = Math.pow(1.0001, tickLower / 2);
  const sqrtP = sqrtPa + Number(amount1Raw) / Number(liquidity);
  const rawPrice = sqrtP * sqrtP; // token1/token0 in base units
  return rawPrice * 10 ** (decimals0 - decimals1); // convert to whole-token price
}

/** Whole-token price (token1 per token0) at an exact tick — the boundary price of a range. */
export function priceAtTick(tick: number, decimals0 = 18, decimals1 = 18): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

export type ExitPriceBasis = "in-range" | "lower-boundary" | "upper-boundary" | "none";

/**
 * Exit price (token1/token0) for a CLOSED position, derived archive-free from
 * its final liquidity-bearing burn:
 *   • in-range burn (both tokens out) → exact price from geometry (impliedInRangePrice)
 *   • all token0 out → price fell through the LOWER bound → value at price(tickLower)
 *   • all token1 out → price rose through the UPPER bound → value at price(tickUpper)
 *   • no burn found  → basis "none"; caller supplies its own fallback (e.g. live price)
 *
 * The boundary cases are the tightest known bound on an out-of-range exit and,
 * unlike the live pool price, do NOT drift as the token moves after the position
 * closed — so a token that later collapses no longer inflates impermanent loss.
 */
export function closedExitPrice(
  events: LiquidityEvent[],
  tickLower: number,
  tickUpper: number,
  decimals0 = 18,
  decimals1 = 18,
): { price: number; basis: ExitPriceBasis } {
  const burn = [...events].reverse().find((e) => e.kind === "decrease" && e.liquidity && e.liquidity > 0n);
  if (!burn) return { price: NaN, basis: "none" };
  if (burn.amount0 > 0n && burn.amount1 > 0n) {
    return { price: impliedInRangePrice(burn.amount1, burn.liquidity!, tickLower, decimals0, decimals1), basis: "in-range" };
  }
  if (burn.amount0 > 0n && burn.amount1 === 0n) {
    return { price: priceAtTick(tickLower, decimals0, decimals1), basis: "lower-boundary" };
  }
  if (burn.amount0 === 0n && burn.amount1 > 0n) {
    return { price: priceAtTick(tickUpper, decimals0, decimals1), basis: "upper-boundary" };
  }
  return { price: NaN, basis: "none" };
}

/**
 * Real token amounts (raw base units) held by a liquidity position at a given
 * tick — used to mark-to-market a STILL-OPEN position. Piecewise per v3:
 *   tick ≤ lower → all token0 ; tick ≥ upper → all token1 ; else both.
 */
export function amountsFromLiquidity(liquidity: bigint, tickLower: number, tickUpper: number, tick: number): { amount0: bigint; amount1: bigint } {
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  const L = Number(liquidity);
  let x = 0, y = 0;
  if (tick <= tickLower) x = L * (1 / sa - 1 / sb);
  else if (tick >= tickUpper) y = L * (sb - sa);
  else { const sp = Math.pow(1.0001, tick / 2); x = L * (1 / sp - 1 / sb); y = L * (sp - sa); }
  return { amount0: BigInt(Math.max(0, Math.round(x))), amount1: BigInt(Math.max(0, Math.round(y))) };
}

// ─────────────────────────────────────────────────────────────────────────
// 4c. OPTIONAL viem DECODER LAYER  (requires: pnpm add viem)
// ─────────────────────────────────────────────────────────────────────────
//
// Turns a raw transaction receipt into LiquidityEvent[]. Kept separate so the
// core above stays dependency-free and unit-testable with hand-built events.
//
// import { createPublicClient, http, defineChain, decodeEventLog, type TransactionReceipt } from "viem";
//
// // Robinhood Chain isn't in viem/chains — define it once.
// export const robinhoodChain = defineChain({
//   id: ROBINHOOD_CHAIN.chainId,
//   name: "Robinhood Chain",
//   nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
//   rpcUrls: { default: { http: [ROBINHOOD_CHAIN.rpcUrl] } },
//   blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
// });
// export const client = createPublicClient({ chain: robinhoodChain, transport: http() });
//
// export const NPM_ADDRESS = ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager;
//
// const NPM_ABI = [
//   { type: "event", name: "IncreaseLiquidity", inputs: [
//     { name: "tokenId", type: "uint256", indexed: true },
//     { name: "liquidity", type: "uint128" }, { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] },
//   { type: "event", name: "DecreaseLiquidity", inputs: [
//     { name: "tokenId", type: "uint256", indexed: true },
//     { name: "liquidity", type: "uint128" }, { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] },
//   { type: "event", name: "Collect", inputs: [
//     { name: "tokenId", type: "uint256", indexed: true },
//     { name: "recipient", type: "address" }, { name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] },
// ] as const;
//
// export function eventsFromReceipt(
//   receipt: TransactionReceipt,
//   timestampSec: number,
//   npm = NPM_ADDRESS,
// ): LiquidityEvent[] {
//   const out: LiquidityEvent[] = [];
//   for (const log of receipt.logs) {
//     if (log.address.toLowerCase() !== npm.toLowerCase()) continue;
//     let decoded;
//     try {
//       decoded = decodeEventLog({ abi: NPM_ABI, data: log.data, topics: log.topics });
//     } catch { continue; } // not one of our 3 events
//     const kind =
//       decoded.eventName === "IncreaseLiquidity" ? "increase" :
//       decoded.eventName === "DecreaseLiquidity" ? "decrease" : "collect";
//     const a = decoded.args as { tokenId: bigint; amount0: bigint; amount1: bigint; liquidity?: bigint };
//     out.push({
//       kind, tokenId: a.tokenId, txHash: log.transactionHash!, blockNumber: log.blockNumber!,
//       timestamp: timestampSec, amount0: a.amount0, amount1: a.amount1, liquidity: a.liquidity,
//     });
//   }
//   return out;
// }
//
// To trace the FULL position history (entry + mid-life claims + exit), fetch every
// log for the tokenId across its life instead of a single receipt:
//   const logs = await client.getLogs({ address: npm, event: <IncreaseLiquidity ABI item>,
//     args: { tokenId }, fromBlock: mintBlock, toBlock: "latest" });  // repeat per event, merge.
