import { computeV4PoolId, unpackPositionInfo } from "./v4-decode";
import { buildV4Events, type V4RawEvent, type BlockState } from "./v4-decode";
import { buildV4PriceFeed, tickToPrice, tickAtBlock, type V4SwapPoint } from "./v4-decode";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};
const approx = (name: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want≈${want}`);
  ok ? pass++ : fail++;
};

// Verified live: PositionManager #1 poolKey → this poolId (matches ModifyLiquidity topic1).
eq("poolId #1", computeV4PoolId({
  currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  currency1: "0x42bcDF8d4116545d04dd5b76F48b614450f18B1B",
  fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000",
}), "0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d33cbd7249413a5");

// PositionInfo packing: tickLower at bits 8-31, tickUpper at bits 32-55 (signed 24-bit).
{
  const u24 = (n: number) => BigInt(n & 0xffffff);
  const info = (u24(887220) << 32n) | (u24(-887220) << 8n);
  const r = unpackPositionInfo(info);
  eq("tickLower", r.tickLower, -887220);
  eq("tickUpper", r.tickUpper, 887220);
}

// Scenario: mint (add L=1e12 in-range), then full burn one segment later, with fees.
{
  const L = 1_000_000_000_000n;
  const raw: V4RawEvent[] = [
    { blockNumber: 100n, logIndex: 0, txHash: "0xa".padEnd(66, "0"), timestamp: 1000, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 200n, logIndex: 0, txHash: "0xb".padEnd(66, "0"), timestamp: 2000, tickLower: -60, tickUpper: 60, liquidityDelta: -L },
  ];
  const oneToken = (1n << 128n); // >>128 of L*this = L
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 0, fg0: oneToken, fg1: 2n * oneToken }],
  ]);
  const { events, feesComplete } = buildV4Events(raw, state, 18, 18);
  const kinds = events.map((e) => e.kind).join(",");
  eq("event kinds", kinds, "increase,decrease,collect");
  eq("feesComplete when all fg present", feesComplete, true);
  const dec = events.find((e) => e.kind === "decrease")!;
  const col = events.find((e) => e.kind === "collect")!;
  eq("collect0 = principal + feeL", col.amount0, dec.amount0 + L);
  eq("collect1 = principal + fee2L", col.amount1, dec.amount1 + 2n * L);
  eq("decrease same tx as collect", dec.txHash, col.txHash);
}

// Scenario: exit block's fee-growth pruned (null) → feesComplete false, fee=principal only.
{
  const L = 1_000_000_000_000n;
  const raw: V4RawEvent[] = [
    { blockNumber: 100n, logIndex: 0, txHash: "0xe".padEnd(66, "0"), timestamp: 1000, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 200n, logIndex: 0, txHash: "0xf".padEnd(66, "0"), timestamp: 2000, tickLower: -60, tickUpper: 60, liquidityDelta: -L },
  ];
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 0, fg0: null, fg1: null }], // pruned
  ]);
  const { events, feesComplete } = buildV4Events(raw, state, 18, 18);
  eq("feesComplete false when pruned", feesComplete, false);
  const dec = events.find((e) => e.kind === "decrease")!;
  const col = events.find((e) => e.kind === "collect")!;
  eq("collect0 = principal only (fee=0)", col.amount0, dec.amount0);
}

// Scenario: pure fee claim (liquidityDelta == 0) after a mint.
{
  const L = 1_000_000_000_000n;
  const oneToken = (1n << 128n);
  const raw: V4RawEvent[] = [
    { blockNumber: 10n, logIndex: 0, txHash: "0xc".padEnd(66, "0"), timestamp: 100, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 20n, logIndex: 0, txHash: "0xd".padEnd(66, "0"), timestamp: 200, tickLower: -60, tickUpper: 60, liquidityDelta: 0n },
  ];
  const state = new Map<bigint, BlockState>([
    [10n, { tick: 0, fg0: 0n, fg1: 0n }],
    [20n, { tick: 0, fg0: oneToken, fg1: 0n }],
  ]);
  const { events } = buildV4Events(raw, state, 18, 18);
  const claim = events.filter((e) => e.kind === "collect");
  eq("one fee-claim collect", claim.length, 1);
  eq("fee-claim amount0 = L", claim[0].amount0, L);
  eq("fee-claim has no decrease in tx", events.some((e) => e.kind === "decrease"), false);
}

{
  // anchor token1 (e.g. USDG=token1). price at tick t = 1.0001^t (dec0==dec1).
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 6932, fg0: 0n, fg1: 0n }], // ~2x
  ]);
  const tsByBlock = new Map<bigint, number>([[100n, 1000], [200n, 2000]]);
  const feed = buildV4PriceFeed(state, tsByBlock, /*anchorIsToken0*/ false, 18, 18);
  approx("price@1000 p0≈1", feed(1000).p0, 1);
  approx("price@2000 p0≈2", feed(2000).p0, tickToPrice(6932, 18, 18), 1e-6);
  approx("price@2000 p1==1", feed(2000).p1, 1);
  approx("price@1500 uses 1000", feed(1500).p0, 1);
  approx("price@9999 uses 2000", feed(9999).p0, tickToPrice(6932, 18, 18), 1e-6);
}

// tickAtBlock: last Swap at-or-before the block; Initialize tick before any swap.
{
  const swaps: V4SwapPoint[] = [
    { blockNumber: 150n, logIndex: 2, tick: 10 },
    { blockNumber: 150n, logIndex: 5, tick: 11 },
    { blockNumber: 300n, logIndex: 0, tick: 20 },
  ];
  eq("tick before any swap = init", tickAtBlock(swaps, 100n, -7), -7);
  eq("tick at 150 = last in-block", tickAtBlock(swaps, 150n, -7), 11);
  eq("tick at 250 = 150's", tickAtBlock(swaps, 250n, -7), 11);
  eq("tick at 999 = 300's", tickAtBlock(swaps, 999n, -7), 20);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
