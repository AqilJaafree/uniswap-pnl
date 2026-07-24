/**
 * Regression smoke (live RPC): v4 fees must come from GROUND TRUTH (actual tokens
 * received on close), not the fee-growth reconstruction. #303574 (USDG/GME) was
 * minted with the price BELOW its range, so the feeGrowthInside baseline read as 0
 * and fees were overstated ~20x — the app showed +$193.97 (+194%) for a position
 * that actually LOST money. True: deposited 100 USDG, received 16.75 USDG + 837k
 * GME → fees ≈ 5.5 USDG + 58.7k GME ≈ $10.5, net ≈ -$12.4 (-12%).
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/v4-groundtruth-fee.smoke.ts
 */
import { computePositionPnLV4 } from "./chain-v4";

const TOKEN_ID = 303574n;
const MINT_BLOCK = 17256154n; // v4 PositionManager mint block for #303574

async function main() {
  const p = await computePositionPnLV4(TOKEN_ID, MINT_BLOCK);
  const r = p.result;
  console.log(`#${TOKEN_ID} ${p.sym0}/${p.sym1}  dep=${r.depositedUsd.toFixed(2)} wd=${r.withdrawnUsd.toFixed(2)}`);
  console.log(`  fees0=${r.fees0.toFixed(4)} ${p.sym0}  fees1=${Math.round(r.fees1)} ${p.sym1}  feesUsd=${r.feesUsd.toFixed(2)}`);
  console.log(`  net=${r.netPnlUsd.toFixed(2)} IL=${r.ilUsd.toFixed(2)} pnl%=${(r.pnlPct * 100).toFixed(1)}`);

  // Fees must be ground-truth (~5.5 USDG), not the ~115 USDG fee-growth overstate.
  const feesOk = r.fees0 < 20 && r.feesUsd < 50; // true ≈ 5.5 USDG / $10.5; bug was 115 / $217
  console.log(`\n${feesOk ? "PASS" : "FAIL"}  fees0=${r.fees0.toFixed(2)} USDG (want < 20, bug was ~115)`);

  // Net must be a LOSS — the bug reported +$193.97.
  const netOk = r.netPnlUsd < 0;
  console.log(`${netOk ? "PASS" : "FAIL"}  net=${r.netPnlUsd.toFixed(2)} (want < 0, bug was +193.97)`);

  if (!feesOk || !netOk) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
