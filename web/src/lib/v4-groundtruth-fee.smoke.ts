/**
 * Regression smoke (live RPC): v4 fees must come from GROUND TRUTH (actual tokens
 * received on close), not the fee-growth reconstruction. #303574 (USDG/GME) was
 * minted with the price BELOW its range, so the feeGrowthInside baseline read as 0
 * and fees were overstated ~20x — the app showed +$193.97 (+194%) for a position
 * that actually LOST money. True: deposited 100 USDG, received 16.75 USDG + 837k
 * GME → fees ≈ 5.5 USDG + 58.7k GME ≈ $10.5, net ≈ -$12.4 (-12%).
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/v4-groundtruth-fee.smoke.ts
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { createChainClient } from "./chain";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

const TOKEN_ID = 303574n;
const MINT_BLOCK = 17256154n; // v4 PositionManager mint block for #303574

// computePositionPnLV4 is no longer importable directly (chain-v4.ts's factory keeps it
// private) — resolve the mint tx at the already-known block with a small local client,
// then drive the real computation through createChainClient(...).analyze(mintTxHash),
// which reaches v4.computePositionPnLV4 with no owner context, same as before.
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
