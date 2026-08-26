/**
 * Regression smoke (live archive RPC + Blockscout): an explorer that has not indexed a
 * tx's trace must not be read as "the chain paid nothing".
 *
 * v4 #892396 (ETH/DELTA 1.0002%, ticks 124600–131400) opened 2026-08-25 06:03 with a
 * single-sided 0.06 ETH deposit and closed 22 h 30 m later, tx 0x19f8d828…de57. Ground
 * truth, decoded from `debug_traceTransaction`: the PoolManager paid the wallet
 * 0.062507735689330163 ETH as a NATIVE internal transfer — invisible to logs — plus
 * 757.856757567573047435 DELTA. The pool sat below tickLower at both ends, so the
 * principal is the full below-range amount0 (59999999999999999 wei, which the close tx's
 * own `amount0Min` independently confirms) and everything else is fees.
 *
 * Blockscout answers 200 with `{"items":[]}` for that tx — stably, while neighbouring
 * txs index fine. Read as a flow of zero it made `actualReceived` (0 ETH, 757.86 DELTA);
 * `reconcileRemovalTicks` then found a principal its payout "disproved", refuted a
 * CORRECT tick and replaced it with tickUpper. That tick drove both the geometry
 * (withdrawn 0 ETH, fees exactly 0, `feesComplete: true`) and the headline price, and a
 * +10.24% position was reported as −97.52%.
 *
 * RUN IT BOTH WAYS — the two guards this pins bite on different RPCs, and each one is
 * vacuous on the other's:
 *   • ARCHIVE (mint-block state intact): the exit assertions bite. Removing the
 *     empty-trace refusal in `cachedTraceCalls` reproduces −97.52% exactly.
 *   • PRUNED (the deployed proxy; the public node answers every historical eth_call with
 *     `-32000 metadata is not found`): the DEPOSIT assertions bite, because only there is
 *     the implied mint tick load-bearing. Removing the outflow half of
 *     `nativeFlowWithoutTrace` splits the single-sided deposit into 0.0373 ETH +
 *     6560.73 DELTA and invents −0.0077 Ξ of IL. On archive that revert passes silently.
 * A pruned read also cannot measure the fee legs, so it asserts a flat, flagged position
 * rather than the +10.04% an archive node reconstructs.
 *
 * Run: RPC_URL=<archive rpc>                       npx tsx web/src/lib/v4-unread-trace.smoke.ts
 *      RPC_URL=https://uniswap.yeeteora.xyz/rpc    npx tsx web/src/lib/v4-unread-trace.smoke.ts
 */
import { computePositionPnLV4 } from "./chain-v4";

const TOKEN_ID = 892396n;
const MINT_BLOCK = 45497636n;

const DEPOSITED_ETH = 0.06;
const FEES_ETH = 0.002507735689330164;   // 0.062507735689330163 received − 0.059999999999999999 principal
const FEES_DELTA = 757.856757567573;

async function main() {
  const p = await computePositionPnLV4(TOKEN_ID, MINT_BLOCK);
  const r = p.result;
  const archive = p.feesComplete;
  console.log(`#${TOKEN_ID} ${p.sym0}/${p.sym1} ${(p.fee / 1e4).toFixed(4)}%  open=${p.open}  archive=${archive}`);
  console.log(`  deposited: ${r.deposited0.toFixed(18)} ${p.sym0} + ${r.deposited1} ${p.sym1}`);
  console.log(`  withdrawn: ${r.withdrawn0.toFixed(18)} ${p.sym0} + ${r.withdrawn1} ${p.sym1}`);
  console.log(`  fees:      ${r.fees0.toFixed(18)} ${p.sym0} + ${r.fees1} ${p.sym1}`);
  console.log(`  net=${r.netPnlUsd}Ξ  IL=${r.ilUsd}Ξ  pnl%=${(r.pnlPct * 100).toFixed(2)}  gas=${p.gasEth}Ξ`);
  console.log(`  feesComplete=${p.feesComplete} tickComplete=${p.tickComplete}`);

  const checks: [string, boolean, string][] = [
    // The DEPOSIT. Dropping the mint tx whole (the first shape of the fix) lost the
    // outflow its own `value` evidences and the tick fell back, splitting a single-sided
    // deposit into 0.0373 ETH + 6560.73 DELTA and inventing −0.0077 Ξ of IL with it.
    ["deposit is single-sided ETH", r.deposited1 === 0, `deposited1=${r.deposited1} (want 0, regression was 6560.73)`],
    ["deposit is the 0.06 ETH actually sent", Math.abs(r.deposited0 - DEPOSITED_ETH) < 1e-9, `deposited0=${r.deposited0} (want ${DEPOSITED_ETH})`],

    // The PRINCIPAL. The bug reconstructed the position as 100% DELTA at tickUpper.
    ["principal came back as ETH", Math.abs(r.withdrawn0 - DEPOSITED_ETH) < 1e-9, `withdrawn0=${r.withdrawn0} (want ${DEPOSITED_ETH}, bug was 0)`],
    ["and none of it as DELTA", r.withdrawn1 === 0, `withdrawn1=${r.withdrawn1} (want 0, bug was 757.86)`],

    // A round trip that returns its deposit has no impermanent loss and no price PnL:
    // both ends of the position were 100% token0 at the same geometry.
    ["no IL on a same-side round trip", Math.abs(r.ilUsd) < 1e-12, `il=${r.ilUsd}`],

    // The position's whole return is its fees. Both legs read exactly 0 under the bug.
    ...(archive
      ? ([
          ["fees in ETH match the chain", Math.abs(r.fees0 - FEES_ETH) < 1e-15, `fees0=${r.fees0} (want ${FEES_ETH}, bug was 0)`],
          ["fees in DELTA match the chain", Math.abs(r.fees1 - FEES_DELTA) / FEES_DELTA < 1e-12, `fees1=${r.fees1} (want ${FEES_DELTA}, bug was 0)`],
          ["net is a profit near +10%", r.pnlPct > 0.09 && r.pnlPct < 0.11, `pnl%=${(r.pnlPct * 100).toFixed(2)} (want ≈10.0, bug was −97.52)`],
        ] as [string, boolean, string][])
      : ([
          // Pruned state cannot measure the fees, so the position reads flat — understated
          // and flagged, never negative. That is the whole point: the bug's −97.52% was a
          // confident number, `feesComplete: true` and all.
          ["a pruned read is flat, not a 97% loss", r.pnlPct === 0, `pnl%=${(r.pnlPct * 100).toFixed(2)} (want 0, bug was −97.52)`],
        ] as [string, boolean, string][])),

    // The pool really was pinned at MIN_TICK across the exit block — a dust swap at
    // 46296645 took its last liquidity — so no source can VERIFY the exit price and the
    // badge must stay on. `feesComplete` is a separate axis and holds on an archive node.
    ["exit price is flagged unverified", !p.tickComplete, "tickComplete must be false — the pool was at its numerical floor"],
  ];

  let failed = 0;
  console.log();
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
    if (!ok) failed++;
  }
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
