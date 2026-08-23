/**
 * Pure v4 decoders/assembly. No network — takes already-fetched log/state data
 * and produces engine LiquidityEvent[] (v3 shape) so computePnL is reused as-is.
 */
import { keccak256, encodeAbiParameters, getAddress } from "viem";
import { amountsFromLiquidity, isPriceableTick, type LiquidityEvent, type PriceFeed } from "./uniswap-v3-pnl";
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
  /**
   * Tick to PRICE this block at, when `tick` itself is not a price — set by
   * `resolvePriceTicks` for a pool sitting at the AMM's numerical limit. Absent
   * (the normal case) means `tick` is both the geometry and the price.
   */
  priceTick?: number;
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

/**
 * Give every block whose pool tick is the AMM's limit a usable PRICE tick, in order of
 * trust, and report how many needed one (0 = every tick was already a real price).
 *
 *   1. The last real trade at-or-before the block — the pool's own last quoted price.
 *   2. The last real price already established for an earlier block of this position.
 *   3. The raw tick clamped into the position's own range — bounded by construction,
 *      and the LP's own statement of where the price lived.
 *
 * The raw `tick` is never touched; it is what the withdrawal geometry is reconstructed
 * from, and at the limit that reconstruction is correct.
 */
export function resolvePriceTicks(
  stateByBlock: Map<bigint, BlockState>,
  swaps: V4SwapPoint[],
  tickLower: number,
  tickUpper: number,
): number {
  const traded = swaps.filter((s) => isPriceableTick(s.tick));
  const blocks = [...stateByBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let lastGood: number | null = null;
  let fixed = 0;
  for (const bn of blocks) {
    const st = stateByBlock.get(bn)!;
    if (isPriceableTick(st.tick)) { lastGood = st.tick; continue; }
    st.priceTick = tickAtBlockOrNull(traded, bn)
      ?? lastGood
      ?? Math.min(tickUpper, Math.max(tickLower, st.tick));
    fixed++;
  }
  return fixed;
}

/** A decoded v4 Swap: the pool's tick after the swap, keyed by block+logIndex. */
export interface V4SwapPoint { blockNumber: bigint; logIndex: number; tick: number; }

/** Pool tick at a block = tick of the last Swap at-or-before it; `initTick` if none prior. */
export function tickAtBlock(swaps: V4SwapPoint[], blockNumber: bigint, initTick: number): number {
  return tickAtBlockOrNull(swaps, blockNumber) ?? initTick;
}

/**
 * Like `tickAtBlock`, but returns null when NO swap precedes the block instead of
 * substituting the pool's genesis tick. Callers need that distinction: the genesis
 * tick is the pool's launch price and can sit on the opposite side of a position's
 * range from the real price, which silently reconstructs a deposit in the wrong
 * token. "Unknown" must stay unknown so a better source can be tried.
 */
export function tickAtBlockOrNull(swaps: V4SwapPoint[], blockNumber: bigint): number | null {
  const sorted = [...swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  let t: number | null = null;
  for (const s of sorted) { if (s.blockNumber <= blockNumber) t = s.tick; else break; }
  return t;
}

/**
 * Recover the pool tick from the tokens a liquidity event ACTUALLY moved.
 *
 * Archive-free and self-evidencing: the amounts come from the tx's own ERC20
 * transfers, so — unlike a pruned StateView read or a genesis-tick guess — this can
 * never place the position on the wrong side of its range.
 *   • both tokens moved → in-range; invert  amount1 = L·(√P − √Pa)  for the exact tick
 *   • only token0       → price at/below the lower bound → tickLower
 *   • only token1       → price at/above the upper bound → tickUpper
 * Boundary results are the tightest known bound and reproduce the amounts exactly,
 * because `amountsFromLiquidity` is flat outside the range. Returns null when the
 * event carries no liquidity or no tokens (nothing to infer from).
 */
export function tickFromAmounts(
  amount0: bigint,
  amount1: bigint,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
): number | null {
  if (liquidity <= 0n) return null;
  if (amount0 > 0n && amount1 > 0n) {
    const sqrtPa = Math.pow(1.0001, tickLower / 2);
    const sqrtP = sqrtPa + Number(amount1) / Number(liquidity);
    const tick = Math.log(sqrtP * sqrtP) / Math.log(1.0001);
    if (!Number.isFinite(tick)) return null;
    return Math.min(tickUpper, Math.max(tickLower, Math.round(tick)));
  }
  if (amount0 > 0n) return tickLower;
  if (amount1 > 0n) return tickUpper;
  return null;
}

/** One call frame from a tx's execution trace (Blockscout's internal-transactions shape). */
export interface TraceCall {
  type: string;            // "call" | "delegatecall" | "staticcall" | "create" | …
  from: string;
  to: string | null;       // null for a contract creation
  value: bigint;
  success: boolean;
}

/**
 * Frame types that actually move native value. `delegatecall`/`staticcall` report the
 * *inherited* call value in a trace but transfer nothing — counting them multiplies a
 * deposit by however many proxy hops it took. Unknown types are treated as moving
 * nothing, which degrades to the pre-existing fee-growth path rather than inventing
 * a transfer.
 */
const VALUE_MOVING = new Set(["call", "callcode", "create", "create2", "selfdestruct"]);

/**
 * Net native-ETH movement for one address in one tx (positive = received).
 *
 * A native currency leg emits no ERC20 Transfer, so the only record of it is the tx's
 * own trace. Two terms, because an explorer's internal-transaction list omits the
 * top-level call (Blockscout indexes them from 1): the tx's `value` if the owner sent
 * it, plus every value-moving frame that credits or debits the owner. Gas is not a
 * position flow and is accounted separately.
 */
export function nativeFlowForOwner(
  owner: string,
  tx: { from: string; value: bigint },
  calls: TraceCall[],
): bigint {
  const me = owner.toLowerCase();
  let net = tx.from.toLowerCase() === me ? -tx.value : 0n;
  for (const c of calls) {
    if (!c.success || c.value === 0n || !VALUE_MOVING.has(c.type.toLowerCase())) continue;
    if (c.to?.toLowerCase() === me) net += c.value;
    if (c.from.toLowerCase() === me) net -= c.value;
  }
  return net;
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
    // `priceTick` when the block's own tick is the AMM's limit rather than a price.
    .map(([bn, st]) => ({ ts: timestampByBlock.get(bn)!, price: tickToPrice(st.priceTick ?? st.tick, decimals0, decimals1) }))
    .filter((p) => p.ts != null)
    .sort((a, b) => a.ts - b.ts);

  return (ts: number) => {
    let chosen = points[0];
    for (const p of points) { if (p.ts <= ts) chosen = p; else break; }
    return numerairePricePoint(chosen.price, anchorIsToken0);
  };
}
