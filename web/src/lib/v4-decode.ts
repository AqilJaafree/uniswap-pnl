/**
 * Pure v4 decoders/assembly. No network — takes already-fetched log/state data
 * and produces engine LiquidityEvent[] (v3 shape) so computePnL is reused as-is.
 */
import { keccak256, encodeAbiParameters, getAddress } from "viem";
import { amountsFromLiquidity, type LiquidityEvent, type PriceFeed } from "./uniswap-v3-pnl";
import { numerairePricePoint } from "./numeraire";

export interface PoolKey {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}

/** poolId = keccak256(abi.encode(PoolKey)). Verified against on-chain ModifyLiquidity topic1. */
export function computeV4PoolId(k: PoolKey): string {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [getAddress(k.currency0), getAddress(k.currency1), k.fee, k.tickSpacing, getAddress(k.hooks)],
  ));
}

const signExtend24 = (v: bigint): number => {
  const masked = v & 0xffffffn;
  return masked >= 0x800000n ? Number(masked - 0x1000000n) : Number(masked);
};

/** PositionInfo packed uint256: tickLower at bits 8-31, tickUpper at bits 32-55. */
export function unpackPositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return { tickLower: signExtend24(info >> 8n), tickUpper: signExtend24(info >> 32n) };
}

/** One decoded ModifyLiquidity log already joined to a single tokenId. */
export interface V4RawEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  timestamp: number;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint; // signed
}

/**
 * Pool state snapshot at a block. `tick` comes from Swap logs (archive-free, always
 * present). `fg0`/`fg1` come from StateView and are `null` when that block's state is
 * pruned (>~14 days old) — the segment's fee is then treated as 0 and feesComplete=false.
 */
export interface BlockState {
  tick: number;
  fg0: bigint | null; // feeGrowthInside0X128, null = pruned
  fg1: bigint | null; // feeGrowthInside1X128, null = pruned
}

const absBig = (n: bigint) => (n < 0n ? -n : n);

/** Actual tokens the owner received in a tx (principal + fees), keyed by txHash. */
export type ActualReceivedByTx = Map<string, { amount0: bigint; amount1: bigint }>;

/**
 * Convert a position's raw ModifyLiquidity events into engine LiquidityEvent[]:
 *   • principal = amountsFromLiquidity(|Δ|, ticks, tickAtBlock)  (geometric, raw units)
 *   • On a removal (decrease) or a pure fee-claim, if the ACTUAL tokens received in
 *     that tx are supplied via `actualReceivedByTx`, the collect uses them exactly
 *     (fee = actual − geometric principal). This is GROUND TRUTH and is preferred:
 *     the fee-growth path below over/understates fees when a position was minted
 *     with the price outside its range (feeGrowthInside baseline is wrong) or when
 *     state is pruned. Ground-truth segments don't clear feesComplete.
 *   • Fallback fee for the segment ending at this event = liqHeld * (fgNow − fgLast)
 *     >> 128, but 0 (and feesComplete=false) if either endpoint's fee-growth is
 *     pruned (null).
 *   • increase → increase(principal) [+ collect(fee) if any accrued]
 *     decrease → decrease(principal) + collect(actual received, else principal + fee)
 *     delta==0 → collect(actual received, else fee)
 * Events must all belong to ONE tokenId. tickLower/tickUpper are constant per position.
 */
export function buildV4Events(
  raw: V4RawEvent[],
  stateByBlock: Map<bigint, BlockState>,
  _decimals0: number,
  _decimals1: number,
  tokenId: bigint = 0n,
  actualReceivedByTx?: ActualReceivedByTx,
): { events: LiquidityEvent[]; feesComplete: boolean } {
  const sorted = [...raw].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  const out: LiquidityEvent[] = [];
  if (sorted.length === 0) return { events: out, feesComplete: true };

  const tickLower = sorted[0].tickLower;
  const tickUpper = sorted[0].tickUpper;
  let curLiq = 0n;
  let fgLast0 = stateByBlock.get(sorted[0].blockNumber)!.fg0;
  let fgLast1 = stateByBlock.get(sorted[0].blockNumber)!.fg1;
  let feesComplete = true;

  for (const ev of sorted) {
    const st = stateByBlock.get(ev.blockNumber)!;
    const gt = actualReceivedByTx?.get(ev.txHash); // actual tokens received in this tx

    // fee-growth fallback for the segment ending at this event
    const fgOk = st.fg0 != null && st.fg1 != null && fgLast0 != null && fgLast1 != null;
    let fee0 = 0n, fee1 = 0n;
    if (fgOk) {
      fee0 = (curLiq * (st.fg0! - fgLast0!)) >> 128n;
      fee1 = (curLiq * (st.fg1! - fgLast1!)) >> 128n;
    }
    fgLast0 = st.fg0; fgLast1 = st.fg1;

    const L = absBig(ev.liquidityDelta);
    const principal = amountsFromLiquidity(L, tickLower, tickUpper, st.tick);
    const base = { tokenId, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp };

    if (ev.liquidityDelta > 0n) {
      // fees accrue while liquidity is held; a mint can't ground-truth its own fees
      if (!fgOk && curLiq > 0n) feesComplete = false;
      out.push({ ...base, kind: "increase", amount0: principal.amount0, amount1: principal.amount1, liquidity: L });
      if (fee0 > 0n || fee1 > 0n) out.push({ ...base, kind: "collect", amount0: fee0, amount1: fee1 });
      curLiq += L;
    } else if (ev.liquidityDelta < 0n) {
      out.push({ ...base, kind: "decrease", amount0: principal.amount0, amount1: principal.amount1, liquidity: L });
      if (gt) {
        out.push({ ...base, kind: "collect", amount0: gt.amount0, amount1: gt.amount1 });
      } else {
        if (!fgOk && curLiq > 0n) feesComplete = false;
        out.push({ ...base, kind: "collect", amount0: principal.amount0 + fee0, amount1: principal.amount1 + fee1 });
      }
      curLiq -= L;
    } else {
      if (gt) {
        out.push({ ...base, kind: "collect", amount0: gt.amount0, amount1: gt.amount1 });
      } else {
        if (!fgOk && curLiq > 0n) feesComplete = false;
        out.push({ ...base, kind: "collect", amount0: fee0, amount1: fee1 });
      }
    }
  }
  return { events: out, feesComplete };
}

/** Whole-token price token1-per-token0 at a tick, decimal-adjusted. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

/** A decoded v4 Swap: the pool's tick after the swap, keyed by block+logIndex. */
export interface V4SwapPoint { blockNumber: bigint; logIndex: number; tick: number; }

/** Pool tick at a block = tick of the last Swap at-or-before it; `initTick` if none prior. */
export function tickAtBlock(swaps: V4SwapPoint[], blockNumber: bigint, initTick: number): number {
  const sorted = [...swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  let t = initTick;
  for (const s of sorted) { if (s.blockNumber <= blockNumber) t = s.tick; else break; }
  return t;
}

/**
 * PriceFeed over the position's event timestamps. Each event block's tick →
 * numeraire PricePoint; a query returns the price at the nearest timestamp ≤ query
 * (computePnL only ever queries at event timestamps).
 */
export function buildV4PriceFeed(
  stateByBlock: Map<bigint, BlockState>,
  timestampByBlock: Map<bigint, number>,
  anchorIsToken0: boolean,
  decimals0: number,
  decimals1: number,
): PriceFeed {
  const points = [...stateByBlock.entries()]
    .map(([bn, st]) => ({ ts: timestampByBlock.get(bn)!, price: tickToPrice(st.tick, decimals0, decimals1) }))
    .filter((p) => p.ts != null)
    .sort((a, b) => a.ts - b.ts);

  return (ts: number) => {
    let chosen = points[0];
    for (const p of points) { if (p.ts <= ts) chosen = p; else break; }
    return numerairePricePoint(chosen.price, anchorIsToken0);
  };
}
