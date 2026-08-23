import { computeV4PoolId, unpackPositionInfo } from "./v4-decode";
import { buildV4Events, type V4RawEvent, type BlockState } from "./v4-decode";
import { buildV4PriceFeed, tickToPrice, tickAtBlock, tickAtBlockOrNull, tickFromAmounts, type V4SwapPoint } from "./v4-decode";
import { resolvePriceTicks } from "./v4-decode";
import { MIN_TICK, MAX_TICK, isPriceableTick } from "./uniswap-v3-pnl";
import { nativeFlowForOwner, type TraceCall } from "./v4-decode";
import { amountsFromLiquidity } from "./uniswap-v3-pnl";

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

// Scenario: GROUND-TRUTH fees — when the actual tokens received in a decrease's
// tx are supplied, the collect uses them exactly (fee = actual − geometric
// principal), overriding fee-growth reconstruction AND surviving pruned state.
// This is the fix for over-range mints where feeGrowthInside baseline is wrong.
{
  const L = 1_000_000_000_000n;
  const burnTx = "0xbb".padEnd(66, "0");
  const raw: V4RawEvent[] = [
    { blockNumber: 100n, logIndex: 0, txHash: "0xaa".padEnd(66, "0"), timestamp: 1000, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 200n, logIndex: 0, txHash: burnTx, timestamp: 2000, tickLower: -60, tickUpper: 60, liquidityDelta: -L },
  ];
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 0, fg0: null, fg1: null }], // pruned — fee-growth alone would give 0 fee
  ]);
  const actual = new Map<string, { amount0: bigint; amount1: bigint }>([
    [burnTx, { amount0: 999_999n, amount1: 1_234_567n }],
  ]);
  const { events, feesComplete } = buildV4Events(raw, state, 18, 18, 0n, actual);
  const dec = events.find((e) => e.kind === "decrease")!;
  const col = events.find((e) => e.kind === "collect")!;
  eq("ground-truth collect0 = actual received", col.amount0, 999_999n);
  eq("ground-truth collect1 = actual received", col.amount1, 1_234_567n);
  eq("decrease stays geometric principal", dec.amount0 > 0n && dec.amount1 > 0n, true);
  eq("feesComplete true with ground truth despite pruning", feesComplete, true);
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

// tickAtBlockOrNull: same as tickAtBlock but reports "unknown" instead of inventing
// a genesis tick — the caller must not silently price an event at the pool's launch.
{
  const swaps: V4SwapPoint[] = [{ blockNumber: 150n, logIndex: 2, tick: 10 }];
  eq("no swap at-or-before → null", tickAtBlockOrNull(swaps, 100n), null);
  eq("swap at-or-before → its tick", tickAtBlockOrNull(swaps, 150n), 10);
  eq("empty swaps → null", tickAtBlockOrNull([], 999n), null);
}

// tickFromAmounts: recover the pool tick from the tokens a liquidity event actually
// moved. This is the archive-free replacement for the pruned StateView read — and,
// unlike the genesis-tick fallback, it can never place the deposit on the wrong side.
{
  const [lo, hi] = [-315560, -309120];
  const L = 10n ** 15n;

  // All token0 → price is at/below the lower bound.
  const only0 = amountsFromLiquidity(L, lo, hi, lo);
  eq("all token0 → tickLower", tickFromAmounts(only0.amount0, 0n, L, lo, hi), lo);

  // All token1 → price is at/above the upper bound.
  const only1 = amountsFromLiquidity(L, lo, hi, hi);
  eq("all token1 → tickUpper", tickFromAmounts(0n, only1.amount1, L, lo, hi), hi);

  // Two-sided (in-range) → recovers the original tick.
  const mid = Math.round((lo + hi) / 2);
  const both = amountsFromLiquidity(L, lo, hi, mid);
  const got = tickFromAmounts(both.amount0, both.amount1, L, lo, hi)!;
  const near = Math.abs(got - mid) <= 2;
  console.log(`${near ? "PASS" : "FAIL"}  in-range recovers tick  got=${got} want≈${mid}`);
  near ? pass++ : fail++;

  eq("zero liquidity → null", tickFromAmounts(1n, 1n, 0n, lo, hi), null);
  eq("no amounts → null", tickFromAmounts(0n, 0n, L, lo, hi), null);

  // Result must round-trip: geometry at the recovered tick reproduces the amounts.
  const rt = amountsFromLiquidity(L, lo, hi, tickFromAmounts(only0.amount0, 0n, L, lo, hi)!);
  eq("round-trip all-token0 amount0", rt.amount0, only0.amount0);
  eq("round-trip all-token0 amount1", rt.amount1, 0n);
}

// REGRESSION (the USDG overstatement): a mint whose block state is pruned and which
// has no swap in its own block used to be priced at the pool's genesis tick. When
// genesis sits on the OPPOSITE side of the range from the true price, the deposit was
// reconstructed in the wrong token entirely — e.g. #303574 (USDG/GME) recorded a
// 917,411 GME deposit for what was really 100 USDG, turning -$83 into +$63.
{
  const [lo, hi] = [364140, 371000];        // #303574's real range
  const genesisTick = 381526;               // above hi → geometry says "all token1 (GME)"
  const L = 10n ** 14n;

  const wrong = amountsFromLiquidity(L, lo, hi, genesisTick);
  const wrongSideIsToken1 = wrong.amount0 === 0n && wrong.amount1 > 0n;
  console.log(`${wrongSideIsToken1 ? "PASS" : "FAIL"}  genesis tick puts deposit in token1 (the bug)`);
  wrongSideIsToken1 ? pass++ : fail++;

  // Ground truth: the wallet actually spent token0 (USDG) only.
  const truth = amountsFromLiquidity(L, lo, hi, lo);
  const recovered = tickFromAmounts(truth.amount0, 0n, L, lo, hi)!;
  const fixed = amountsFromLiquidity(L, lo, hi, recovered);
  eq("recovered tick puts deposit in token0", fixed.amount1, 0n);
  eq("recovered deposit equals ground truth", fixed.amount0, truth.amount0);
}

// --- native-ETH leg: net flow for the position owner in one tx -----------------
// A native leg emits no ERC20 Transfer, so it has to come from the tx's own trace.
// Blockscout's internal-transactions list starts at index 1 — the top-level call is
// NOT in it — so the tx's own `value` is a separate term.
{
  const OWNER = "0x7e995decc404633CF2889968537D723c55ffEA2C";
  const POSM = "0x58daec3116aae6D93017bAAea7749052E8a04fA7";
  const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
  const call = (from: string, to: string | null, value: bigint, type = "call", success = true): TraceCall =>
    ({ type, from, to, value, success });

  // #660267's mint: 0.05 ETH in, nothing back. The two delegatecalls carry the same
  // `value` in Blockscout's output but move nothing — counting them would treble it.
  eq("mint: owner spends the tx value",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 50_000_000_000_000_000n }, [
      call(POSM, POSM, 50_000_000_000_000_000n, "delegatecall"),
      call(POSM, PM, 50_000_000_000_000_000n),
    ]),
    -50_000_000_000_000_000n);

  // #660267's exit: no tx value, PoolManager pays the owner directly.
  eq("exit: owner receives an internal call",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 0n }, [
      call(PM, OWNER, 31_569_740_431_650_379n),
      call(PM, "0x0145AcbcceFbEd6F303C420bEeaaAc72E905430b", 0n),
    ]),
    31_569_740_431_650_379n);

  eq("a refund nets against the tx value",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 50_000_000_000_000_000n }, [
      call(POSM, OWNER, 10_000_000_000_000_000n),
    ]),
    -40_000_000_000_000_000n);

  eq("staticcall moves nothing",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 0n }, [call(PM, OWNER, 5n, "staticcall")]), 0n);
  eq("a reverted call moves nothing",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 0n }, [call(PM, OWNER, 5n, "call", false)]), 0n);
  eq("tx value is ignored when the owner did not send the tx",
    nativeFlowForOwner(OWNER, { from: POSM, value: 50n }, [call(PM, OWNER, 5n)]), 5n);
  eq("owner address casing is irrelevant",
    nativeFlowForOwner(OWNER.toLowerCase(), { from: OWNER.toUpperCase(), value: 0n }, [call(PM, OWNER, 7n)]), 7n);
  eq("selfdestruct pays the beneficiary",
    nativeFlowForOwner(OWNER, { from: OWNER, value: 0n }, [call(PM, OWNER, 9n, "selfdestruct")]), 9n);
}

// REGRESSION (#660267 ETH/PACK, tx 0xcd323425…5e08): the same genesis-tick bug as
// above, but on a NATIVE-ETH pair, where it also zeroed the fees. Ground truth was
// discarded wholesale for these pairs, so a mint of 0.05 ETH was reconstructed as
// 0.0393 ETH + 8,071 PACK at the pool's genesis tick, and `fee = collect − decrease`
// came out 0 because pruned fee-growth made collect == decrease. Reported −11.76%
// on a position that returned +52%.
{
  const [lo, hi] = [134750, 141250];
  const L = 151_943_100_050_440_715_017n;
  const genesisTick = 135972;   // inside the range → splits a single-sided deposit in two
  const exitTick = 138940;
  const mintTx = "0x3ba2".padEnd(66, "0");
  const exitTx = "0xcd32".padEnd(66, "0");
  const recvEth = 31_569_740_431_650_379n;
  const recvPack = 47_915_701_427_572_998_357_554n;

  const raw: V4RawEvent[] = [
    { blockNumber: 35540996n, logIndex: 0, txHash: mintTx, timestamp: 1786639205, tickLower: lo, tickUpper: hi, liquidityDelta: L },
    { blockNumber: 36055653n, logIndex: 0, txHash: exitTx, timestamp: 1786690749, tickLower: lo, tickUpper: hi, liquidityDelta: -L },
  ];
  // Both blocks are far outside the RPC's ~5k-block archive window: fee growth is null.
  const pruned = (tick: number): BlockState => ({ tick, fg0: null, fg1: null });

  // The mint moved only ETH, so the recovered tick is the lower bound — and the whole
  // 0.05 ETH deposit stays in token0.
  const spentEth = 50_000_000_000_000_000n;
  const mintTick = tickFromAmounts(spentEth, 0n, L, lo, hi)!;
  eq("native mint recovers the lower bound", mintTick, lo);
  const dep = amountsFromLiquidity(L, lo, hi, mintTick);
  eq("native mint deposits no token1", dep.amount1, 0n);
  // Relative, not exact: amountsFromLiquidity is float geometry, so it lands within a
  // few 1e4 wei of 0.05 ETH. The claim is "0.05 ETH, not the genesis tick's 0.0393".
  approx("native mint deposits the ETH actually spent", Number(dep.amount0) / 1e18, Number(spentEth) / 1e18, 1e-9);

  const state = new Map<bigint, BlockState>([
    [35540996n, pruned(mintTick)],
    [36055653n, pruned(exitTick)],
  ]);

  // Without ground truth (today): collect == decrease, so the fee is exactly zero.
  const blind = buildV4Events(raw, new Map<bigint, BlockState>([
    [35540996n, pruned(genesisTick)], [36055653n, pruned(exitTick)],
  ]), 18, 18, 660267n);
  const blindCollect = blind.events.find((e) => e.kind === "collect" && e.txHash === exitTx)!;
  const blindDecrease = blind.events.find((e) => e.kind === "decrease")!;
  eq("the bug: fee0 is zero", blindCollect.amount0 - blindDecrease.amount0, 0n);
  eq("the bug: fee1 is zero", blindCollect.amount1 - blindDecrease.amount1, 0n);
  eq("the bug: feesComplete is false", blind.feesComplete, false);

  // With ground truth: the collect is what the owner actually received, so the fee is
  // the excess over the geometric principal — and pruned state no longer matters.
  const truth = buildV4Events(raw, state, 18, 18, 660267n,
    new Map([[exitTx, { amount0: recvEth, amount1: recvPack }]]));
  const gtCollect = truth.events.find((e) => e.kind === "collect" && e.txHash === exitTx)!;
  const gtDecrease = truth.events.find((e) => e.kind === "decrease")!;
  const principal = amountsFromLiquidity(L, lo, hi, exitTick);
  eq("ground truth fee0", gtCollect.amount0 - gtDecrease.amount0, recvEth - principal.amount0);
  eq("ground truth fee1", gtCollect.amount1 - gtDecrease.amount1, recvPack - principal.amount1);
  eq("ground truth keeps feesComplete", truth.feesComplete, true);

  const feesPositive = gtCollect.amount0 > gtDecrease.amount0 && gtCollect.amount1 > gtDecrease.amount1;
  console.log(`${feesPositive ? "PASS" : "FAIL"}  ground truth recovers fees in both tokens`);
  feesPositive ? pass++ : fail++;

  // The whole point: valued at the exit price, the position is a WIN, not an 11.76% loss.
  const pxPackPerEth = tickToPrice(exitTick, 18, 18);
  const outEth = Number(recvEth) / 1e18 + Number(recvPack) / 1e18 / pxPackPerEth;
  const inEth = Number(spentEth) / 1e18;
  const profitable = outEth > inEth;
  console.log(`${profitable ? "PASS" : "FAIL"}  #660267 nets positive  out=${outEth.toFixed(6)}Ξ in=${inEth.toFixed(6)}Ξ`);
  profitable ? pass++ : fail++;
}


// ---------------------------------------------------------------------------
// A pool drained to the AMM's price limit is not a price.
//
// LIVE: v4 #537173, ETH/WOOF pool 0x70a3072f…97db, range [197400, 204000].
// Block 30244938 swapped the pool's last liquidity out and left it at tick
// -887272 (MIN_TICK, liquidity 0); nothing swapped it back before the position
// closed at block 30281242. Taking that as the exit price valued the position's
// 32,595 WOOF of fees at 1/1.0001^-887272 ETH each — a headline net of
// 1.1e43 Ξ on a 0.086 Ξ position.
// ---------------------------------------------------------------------------
{
  eq("MIN_TICK is not a price", isPriceableTick(MIN_TICK), false);
  eq("MAX_TICK is not a price", isPriceableTick(MAX_TICK), false);
  // v4 clamps an upward swap to MAX_SQRT_PRICE - 1, which reads back as MAX_TICK - 1.
  eq("MAX_TICK-1 is not a price", isPriceableTick(MAX_TICK - 1), false);
  eq("MIN_TICK+1 is a price", isPriceableTick(MIN_TICK + 1), true);
  eq("MAX_TICK-2 is a price", isPriceableTick(MAX_TICK - 2), true);
  eq("an ordinary tick is a price", isPriceableTick(196800), true);

  const lo = 197400, hi = 204000;
  const mintBn = 30212796n, exitBn = 30281242n;
  const state = new Map<bigint, BlockState>([
    [mintBn, { tick: lo, fg0: null, fg1: null }],
    [exitBn, { tick: MIN_TICK, fg0: null, fg1: null }],
  ]);
  const swaps: V4SwapPoint[] = [
    { blockNumber: 30244937n, logIndex: 3, tick: 196800 },
    { blockNumber: 30244938n, logIndex: 0, tick: MIN_TICK },
  ];
  eq("one block needed a price tick", resolvePriceTicks(state, swaps, lo, hi), 1);
  eq("geometry tick is left alone", state.get(exitBn)!.tick, MIN_TICK);
  eq("price tick is the last real trade", state.get(exitBn)!.priceTick, 196800);
  eq("a priceable block gains no override", state.get(mintBn)!.priceTick, undefined);

  const ts = new Map<bigint, number>([[mintBn, 1786105882], [exitBn, 1786112740]]);
  const feed = buildV4PriceFeed(state, ts, /* anchorIsToken0 */ true, 18, 18);
  const feesWoof = 32595.488330588683;
  const feesEth = feesWoof * feed(1786112740).p1;
  const sane = feesEth > 0 && feesEth < 0.01;
  console.log(`${sane ? "PASS" : "FAIL"}  #537173 WOOF fees price sanely  got=${feesEth}Ξ want=(0, 0.01)Ξ`);
  sane ? pass++ : fail++;

  // No swap history to fall back on: the tick is clamped into the position's own
  // range, which is bounded by construction — never the AMM's limit.
  const bare = new Map<bigint, BlockState>([[exitBn, { tick: MIN_TICK, fg0: null, fg1: null }]]);
  eq("no swaps → still resolved", resolvePriceTicks(bare, [], lo, hi), 1);
  eq("clamped to the position's range", bare.get(exitBn)!.priceTick, lo);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
