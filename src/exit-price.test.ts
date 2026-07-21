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
  priceAtTick, closedExitPrice, exitTxHash, impliedInRangePrice, type LiquidityEvent,
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

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
