/**
 * Regression smoke (live RPC + Blockscout): v4 positions on a NATIVE-ETH pair must be
 * ground-truthed like ERC20/ERC20 pairs are.
 *
 * `fetchOwnerFlowsByTx` used to refuse any pair with a native leg, which threw away the
 * ERC20 leg too and cost those positions both mechanisms at once:
 *   • fees silently became exactly 0 — with fee-growth pruned, collect == decrease, so
 *     `fee = collect − decrease` is 0 (reported as "fees partial", but it is total);
 *   • the mint tick fell through to the pool's GENESIS tick, splitting a single-sided
 *     deposit across both tokens.
 *
 * #660267 (ETH/PACK 2.5%, closed by tx 0xcd323425…5e08) is the case that surfaced it.
 * Ground truth, decoded from the chain: deposited exactly 0.05 ETH and zero PACK (the
 * mint tx carries no ERC20 Transfer at all); received back 0.031569740431650379 ETH —
 * a native internal transfer, invisible to logs — plus 47,915.70 PACK. Valued at the
 * exit price that is ≈ +0.0259 Ξ (+52%). The app reported −0.0058 Ξ (−11.76%), fees 0.
 *
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/v4-native-eth-fee.smoke.ts
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { createChainClient } from "./chain";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

const TOKEN_ID = 660267n;
const MINT_BLOCK = 35540996n; // v4 PositionManager mint block for #660267

const DEPOSITED_ETH = 0.05;               // exact: the mint tx's own value, no refund
const RECEIVED_ETH = 0.031569740431650379; // internal transfer from the PoolManager
const RECEIVED_PACK = 47915.701427572998;

// computePositionPnLV4 is no longer importable directly — resolve the mint tx at the
// already-known block with a small local client, then drive the real computation through
// createChainClient(...).analyze(mintTxHash), which reaches v4.computePositionPnLV4 with
// no owner context, same as before.
const RPC_URL = process.env.RPC_URL || ROBINHOOD_CHAIN.rpcUrl;
const rawClient = createPublicClient({ transport: http(RPC_URL) });
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

async function main() {
  const mints = await rawClient.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId: TOKEN_ID }, fromBlock: MINT_BLOCK, toBlock: MINT_BLOCK });
  const mintTx = mints[0]?.transactionHash;
  if (!mintTx) throw new Error(`no mint Transfer found for #${TOKEN_ID} at block ${MINT_BLOCK}`);
  const portfolio = await createChainClient(ROBINHOOD_CHAIN).analyze(mintTx);
  const p = portfolio.positions[0];
  if (!p) throw new Error(`analyze(${mintTx}) produced no position (skipped: ${portfolio.skipped.join(", ")})`);
  const r = p.result;
  console.log(`#${TOKEN_ID} ${p.sym0}/${p.sym1} ${(p.fee / 1e4).toFixed(2)}%  open=${p.open}`);
  console.log(`  deposited: ${r.deposited0.toFixed(8)} ${p.sym0} + ${r.deposited1.toFixed(2)} ${p.sym1}`);
  console.log(`  withdrawn: ${r.withdrawn0.toFixed(8)} ${p.sym0} + ${r.withdrawn1.toFixed(2)} ${p.sym1}`);
  console.log(`  fees:      ${r.fees0.toFixed(8)} ${p.sym0} + ${r.fees1.toFixed(2)} ${p.sym1}`);
  console.log(`  net=${r.netPnlUsd.toFixed(8)}Ξ  IL=${r.ilUsd.toFixed(8)}Ξ  pnl%=${(r.pnlPct * 100).toFixed(2)}`);
  console.log(`  feesComplete=${p.feesComplete} tickComplete=${p.tickComplete}`);

  const checks: [string, boolean, string][] = [
    // The mint moved only ETH. The genesis-tick bug recorded 0.0393 ETH + 8,071 PACK.
    ["deposit is single-sided ETH", r.deposited1 < 1, `deposited1=${r.deposited1.toFixed(2)} PACK (want ~0, bug was 8071)`],
    ["deposit is the 0.05 ETH actually spent", Math.abs(r.deposited0 - DEPOSITED_ETH) < 1e-6, `deposited0=${r.deposited0.toFixed(8)} (want ${DEPOSITED_ETH})`],

    // Fees are the excess of what was received over the geometric principal, in BOTH
    // tokens. The bug reported exactly zero for each.
    ["fees recovered in ETH", r.fees0 > 0, `fees0=${r.fees0.toFixed(8)} (want > 0, bug was 0)`],
    ["fees recovered in PACK", r.fees1 > 0, `fees1=${r.fees1.toFixed(2)} (want > 0, bug was 0)`],

    // Principal + fees must reconstruct exactly what the owner actually received.
    ["ETH out matches the chain", Math.abs(r.withdrawn0 + r.fees0 - RECEIVED_ETH) < 1e-9, `${(r.withdrawn0 + r.fees0).toFixed(9)} vs ${RECEIVED_ETH}`],
    ["PACK out matches the chain", Math.abs(r.withdrawn1 + r.fees1 - RECEIVED_PACK) / RECEIVED_PACK < 1e-9, `${(r.withdrawn1 + r.fees1).toFixed(2)} vs ${RECEIVED_PACK}`],

    // Both provenance flags must clear: ground truth pins the tick and the fees.
    ["feesComplete", p.feesComplete, "fees are no longer best-effort"],
    ["tickComplete", p.tickComplete, "no genesis-tick fallback"],

    // The headline. The bug called this a −11.76% loss.
    ["net is a profit", r.netPnlUsd > 0, `net=${r.netPnlUsd.toFixed(8)}Ξ (want > 0, bug was -0.00580424)`],
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
