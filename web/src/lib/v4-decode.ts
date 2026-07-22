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
