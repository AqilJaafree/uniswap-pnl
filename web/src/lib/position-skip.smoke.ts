/**
 * Why was ONE v4 position excluded from a wallet's totals?
 *
 * The wallet scan reports a skipped position by id and nothing else -- `catch { skipped
 * .push(label) }` in chain.ts discards the error -- so the UI has to offer the user a
 * disjunction ("unreadable after retries, OR never had liquidity") that it cannot
 * actually distinguish. This script recovers the missing half: it runs the same
 * computation for a single tokenId and prints what it throws.
 *
 * Point RPC_URL at the DEPLOYED proxy to reproduce the browser exactly, lanes included --
 * that is what surfaced the Alchemy width-error regression, which the public node's
 * wording had been hiding:
 *
 *   RPC_URL=https://uniswap.yeeteora.xyz/rpc npx tsx web/src/lib/position-skip.smoke.ts 134693
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { createChainClient, retry } from "./chain";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

// chain.ts's `client` and chain-v4.ts's `computePositionPnLV4` are no longer importable
// directly (both privatized by the factory conversion), and chain-cache.ts's `noteHead`
// was always per-instance, never a standalone export. This script's raw diagnostic reads
// (ownerOf, the Transfer history dump) use their own small unthrottled client; the actual
// PnL computation goes through createChainClient(...).analyze(mintTxHash), which is the
// SAME no-owner-context single-tx path the old direct computePositionPnLV4(ID, mintBlock)
// call took (see analyzeTx's v4 branch in chain.ts).
const RPC_URL = process.env.RPC_URL || ROBINHOOD_CHAIN.rpcUrl;
const rawClient = createPublicClient({ transport: http(RPC_URL) });

const ID = BigInt(process.argv[2] ?? "134693");
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

const head = await rawClient.getBlockNumber();
console.log(`tokenId ${ID}   head ${head}\n`);

// Who holds it now?
try {
  const owner = await rawClient.readContract({
    address: POSM, functionName: "ownerOf", args: [ID],
    abi: [parseAbiItem("function ownerOf(uint256) view returns (address)")],
  });
  console.log(`ownerOf      ${owner}`);
} catch (e) {
  console.log(`ownerOf      THREW: ${(e as Error).message.split("\n")[0]}  (burned?)`);
}

// Its whole transfer history — the mint block is what the wallet scan passes in.
const xfers = await rawClient.getLogs({
  address: POSM, event: evTransfer, args: { tokenId: ID }, fromBlock: 0n, toBlock: head,
});
console.log(`transfers    ${xfers.length}`);
for (const x of xfers) {
  const a = x.args as { from: string; to: string };
  console.log(`  block ${x.blockNumber}  ${a.from} → ${a.to}`);
}
if (!xfers.length) { console.log("\nno transfers at all — not a token this contract minted"); process.exit(0); }

const mintTx = xfers[0].transactionHash!;
const holder = (xfers[xfers.length - 1].args as { to: string }).to;

console.log(`\ncomputing as owner ${holder}, mint tx ${mintTx} …`);
try {
  const portfolio = await retry(() => createChainClient(ROBINHOOD_CHAIN).analyze(mintTx));
  const pos = portfolio.positions[0];
  if (!pos) throw new Error(`analyze(${mintTx}) produced no position (skipped: ${portfolio.skipped.join(", ")})`);
  console.log("OK", JSON.stringify({
    pool: `${pos.sym0}/${pos.sym1}`,
    net: pos.result?.netPnlUsd,
  }, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
} catch (e) {
  const err = e as Error;
  console.log(`\nSKIPPED BECAUSE:\n  ${err.name}: ${err.message}`);
  if (err.cause) console.log(`  cause: ${String((err.cause as Error).message ?? err.cause).split("\n")[0]}`);
  console.log((err.stack ?? "").split("\n").slice(1, 6).join("\n"));
}
