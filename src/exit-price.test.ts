/**
 * Out-of-range exit pricing (archive-free).
 *
 * A CLOSED v3 position that drifted fully out of range returns only ONE token
 * on its final burn, so `impliedInRangePrice` (which needs both tokens) can't be
 * used. The exit price must then be pinned to the range BOUNDARY the position
 * crossed — NOT the live pool price, which keeps drifting as the token moves
 * after the position closed and grossly overstates impermanent loss.
 */
import {
  priceAtTick, closedExitPrice, exitTxHash, impliedInRangePrice,
  impliedEventPrice, buildImpliedPriceFeed, computePnL,
  type LiquidityEvent, type PairMeta,
} from "./uniswap-v3-pnl";

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

const ev = (o: Partial<LiquidityEvent>): LiquidityEvent => ({
  kind: "decrease", tokenId: 1n, txHash: "0x", blockNumber: 0n, timestamp: 0,
  amount0: 0n, amount1: 0n, ...o,
});

// ── priceAtTick: token1-per-token0 at an exact tick ──
approx("priceAtTick(0) = 1", priceAtTick(0), 1);
approx("priceAtTick(0) with dec skew", priceAtTick(0, 6, 18), 1e-12);
approx("priceAtTick matches impliedInRange at a boundary", priceAtTick(-94200), Math.pow(1.0001, -94200));

// ── in-range burn (both tokens out) → exact geometric price ──
{
  const burn = ev({ amount0: 1000n, amount1: 2000n, liquidity: 5000n });
  const { price, basis } = closedExitPrice([burn], -100, 100);
  eq("in-range basis", basis, "in-range");
  approx("in-range price", price, impliedInRangePrice(2000n, 5000n, -100));
}

// ── all token0 out → price fell through the LOWER bound → value at price(tickLower) ──
{
  const burn = ev({ amount0: 325n, amount1: 0n, liquidity: 5000n });
  const { price, basis } = closedExitPrice([burn], -94200, -93000);
  eq("below-range basis", basis, "lower-boundary");
  approx("below-range price = price(tickLower)", price, priceAtTick(-94200));
}

// ── all token1 out → price rose through the UPPER bound → value at price(tickUpper) ──
{
  const burn = ev({ amount0: 0n, amount1: 900n, liquidity: 5000n });
  const { price, basis } = closedExitPrice([burn], -94200, -93000);
  eq("above-range basis", basis, "upper-boundary");
  approx("above-range price = price(tickUpper)", price, priceAtTick(-93000));
}

// ── no liquidity-bearing burn (pure fee claim only) → caller must fall back ──
{
  const col = ev({ kind: "collect", amount0: 5n, amount1: 5n });
  const { price, basis } = closedExitPrice([col], -100, 100);
  eq("no-burn basis", basis, "none");
  eq("no-burn price is NaN", Number.isNaN(price), true);
}

// ── exitTxHash: the tx that closed the position = last liquidity-bearing burn ──
{
  const h = (n: number) => "0x" + String(n).padStart(64, "0");
  const inc = ev({ kind: "increase", txHash: h(1), liquidity: 5000n, amount0: 100n, amount1: 100n });
  const burn = ev({ kind: "decrease", txHash: h(2), liquidity: 5000n, amount0: 90n, amount1: 0n });
  const collect = ev({ kind: "collect", txHash: h(2), amount0: 90n, amount1: 3n });
  eq("exit tx = the burn tx", exitTxHash([inc, burn, collect]), h(2));

  // partial decrease then a later full close → the LAST burn wins
  const partial = ev({ kind: "decrease", txHash: h(3), liquidity: 2000n, amount0: 40n, amount1: 40n });
  const final = ev({ kind: "decrease", txHash: h(4), liquidity: 3000n, amount0: 60n, amount1: 0n });
  eq("exit tx = last burn", exitTxHash([inc, partial, final]), h(4));

  // open position's synthetic burn (txHash "0xopen", no liquidity) is ignored
  const synthetic = ev({ kind: "decrease", txHash: "0xopen", amount0: 50n, amount1: 50n });
  eq("synthetic burn ignored", exitTxHash([inc, synthetic]), undefined);

  // never burned (only entry + fee claims) → no exit tx
  eq("no burn → undefined", exitTxHash([inc, collect]), undefined);
}

// ── impliedEventPrice: price any liquidity-bearing event from its own geometry ──
{
  const inc = ev({ kind: "increase", amount0: 1000n, amount1: 2000n, liquidity: 5000n });
  const a = impliedEventPrice(inc, -100, 100);
  eq("increase in-range basis", a.basis, "in-range");
  approx("increase in-range price = burn geometry", a.price, impliedInRangePrice(2000n, 5000n, -100));

  eq("single-token0 → lower boundary", impliedEventPrice(ev({ amount0: 5n, amount1: 0n, liquidity: 1n }), -94200, -93000).basis, "lower-boundary");
  eq("single-token1 → upper boundary", impliedEventPrice(ev({ amount0: 0n, amount1: 5n, liquidity: 1n }), -94200, -93000).basis, "upper-boundary");
  eq("no liquidity → none", impliedEventPrice(ev({ amount0: 5n, amount1: 5n, liquidity: 0n }), -100, 100).basis, "none");
}

// ── buildImpliedPriceFeed: deposit priced at DEPOSIT time, close at mark ──
{
  const h = (n: number) => "0x" + String(n).padStart(64, "0");
  // deposit in-range where geometry implies price ≈ 1 (tick 0), exit mark = 4.
  const inc = ev({ kind: "increase", txHash: h(1), timestamp: 0, amount0: 1000n, amount1: 1000n, liquidity: 1000n });
  const dec = ev({ kind: "decrease", txHash: h(2), timestamp: 100, amount0: 0n, amount1: 900n, liquidity: 1000n });
  const feed = buildImpliedPriceFeed([inc, dec], -100, 100, 18, 18, /*mark*/ 4, /*markTs*/ 100);
  approx("feed at deposit ≈ implied deposit price", feed(0), impliedInRangePrice(1000n, 1000n, -100));
  approx("feed at close = mark", feed(100), 4);
  approx("feed before first event = earliest point", feed(-50), impliedInRangePrice(1000n, 1000n, -100));
  // synthetic mark events (txHash not 66 chars) are ignored as price points
  const synthetic = ev({ kind: "decrease", txHash: "0xopen", timestamp: 50, amount0: 0n, amount1: 1n, liquidity: 1n });
  const feed2 = buildImpliedPriceFeed([inc, synthetic], -100, 100, 18, 18, 4, 50);
  approx("synthetic event not used as a price point", feed2(50), 4);
}

// ── end-to-end: a moving-price feed makes pricePnl non-zero (the old constant
//    feed forced it to 0 and flipped winners into losers). ──
{
  const pair: PairMeta = { symbol0: "WETH", symbol1: "USDG", decimals0: 18, decimals1: 6 };
  const h = (n: number) => "0x" + String(n).padStart(64, "0");
  const inc: LiquidityEvent = { kind: "increase", tokenId: 1n, txHash: h(1), blockNumber: 1n, timestamp: 0, amount0: 5n * 10n ** 17n, amount1: 1000n * 10n ** 6n, liquidity: 1n };
  const dec: LiquidityEvent = { kind: "decrease", tokenId: 1n, txHash: h(2), blockNumber: 2n, timestamp: 864000, amount0: 0n, amount1: 2200n * 10n ** 6n, liquidity: 1n };
  const col: LiquidityEvent = { kind: "collect", tokenId: 1n, txHash: h(2), blockNumber: 2n, timestamp: 864000, amount0: 0n, amount1: 2200n * 10n ** 6n };
  const moving = (t: number) => ({ p0: t < 432000 ? 2000 : 3000, p1: 1 }); // WETH $2000→$3000
  const constant = () => ({ p0: 3000, p1: 1 }); // the old exit-anchored feed
  const good = computePnL([inc, dec, col], pair, moving);
  const bad = computePnL([inc, dec, col], pair, constant);
  approx("moving feed: depositedUsd = real cost $2000", good.depositedUsd, 2000);
  approx("moving feed: net ≈ +$200 (winner)", good.netPnlUsd, 200);
  approx("constant feed BUG: pricePnl forced to 0", bad.pricePnlUsd, 0);
  eq("constant feed BUG: winner reported as loser", bad.netPnlUsd < 0, true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
