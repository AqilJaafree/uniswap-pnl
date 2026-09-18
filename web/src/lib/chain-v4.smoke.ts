/**
 * Manual v4 smoke test against live Robinhood RPC. Not part of `verify` (network).
 * Run: npx tsx web/src/lib/chain-v4.smoke.ts [tokenId]
 * Finds a recent PositionManager mint if no tokenId is given, computes its PnL,
 * and asserts the engine identity holds.
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { createChainClient } from "./chain";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

// chain.ts no longer exports its viem `client` (it's private to createChainClient's
// closure), so this script builds its own minimal, unthrottled one — fine for a handful
// of manual getLogs calls. The actual PnL computation still goes through the one real
// v4 implementation, via createChainClient(...).analyze(mintTxHash) below.
const RPC_URL = process.env.RPC_URL || ROBINHOOD_CHAIN.rpcUrl;
const rawClient = createPublicClient({ transport: http(RPC_URL) });

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

async function main() {
  const arg = process.argv[2];
  let tokenId: bigint, mintTx: string;
  const blk = await rawClient.getBlockNumber();
  if (arg) {
    tokenId = BigInt(arg);
    const mints = await rawClient.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: 0n, toBlock: "latest" });
    if (!mints.length) throw new Error(`no mint Transfer found for #${tokenId}`);
    mintTx = mints[0].transactionHash!;
  } else {
    const mints = await rawClient.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: blk - 20000n, toBlock: "latest" });
    if (!mints.length) throw new Error("no recent v4 mints found; pass a tokenId");
    const last = mints[mints.length - 1];
    tokenId = (last.args as { tokenId: bigint }).tokenId;
    mintTx = last.transactionHash!;
  }
  console.log(`Computing v4 PnL for tokenId #${tokenId} (mint tx ${mintTx})…`);
  // analyze(mintTxHash) routes to analyzeTx's v4 branch, which resolves the tokenId and
  // mint block from the tx itself and calls v4.computePositionPnLV4(tokenId, mintBlock)
  // with no owner context — exactly the single-tx path this script always exercised.
  const portfolio = await createChainClient(ROBINHOOD_CHAIN).analyze(mintTx);
  const p = portfolio.positions[0];
  if (!p) throw new Error(`analyze(${mintTx}) produced no position (skipped: ${portfolio.skipped.join(", ")})`);
  const r = p.result;
  console.log(`  pair=${p.sym0}/${p.sym1} fee=${p.fee} open=${p.open} numeraire=${p.numeraire}(${p.numeraireKind}) version=${p.version} feesComplete=${p.feesComplete}`);
  console.log(`  deposited=${r.depositedUsd.toFixed(6)} withdrawn=${r.withdrawnUsd.toFixed(6)} fees=${r.feesUsd.toFixed(6)}`);
  console.log(`  net=${r.netPnlUsd.toFixed(6)}  price/HODL=${r.pricePnlUsd.toFixed(6)}  IL=${r.ilUsd.toFixed(6)}`);

  const identity = r.pricePnlUsd + r.ilUsd + r.feesUsd - r.gasUsd;
  const ok = Math.abs(identity - r.netPnlUsd) <= 1e-6 * Math.max(1, Math.abs(r.netPnlUsd));
  console.log(`\n${ok ? "PASS" : "FAIL"}  net identity: ${r.netPnlUsd.toFixed(6)} ≈ ${identity.toFixed(6)}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
