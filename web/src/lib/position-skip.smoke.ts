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
import { parseAbiItem, getAddress } from "viem";
import { client, retry } from "./chain";
import { computePositionPnLV4 } from "./chain-v4";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";
import { noteHead } from "./chain-cache";

const ID = BigInt(process.argv[2] ?? "134693");
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

const head = await client.getBlockNumber();
noteHead(head);
console.log(`tokenId ${ID}   head ${head}\n`);

// Who holds it now?
try {
  const owner = await client.readContract({
    address: POSM, functionName: "ownerOf", args: [ID],
    abi: [parseAbiItem("function ownerOf(uint256) view returns (address)")],
  });
  console.log(`ownerOf      ${owner}`);
} catch (e) {
  console.log(`ownerOf      THREW: ${(e as Error).message.split("\n")[0]}  (burned?)`);
}

// Its whole transfer history — the mint block is what the wallet scan passes in.
const xfers = await client.getLogs({
  address: POSM, event: evTransfer, args: { tokenId: ID }, fromBlock: 0n, toBlock: head,
});
console.log(`transfers    ${xfers.length}`);
for (const x of xfers) {
  const a = x.args as { from: string; to: string };
  console.log(`  block ${x.blockNumber}  ${a.from} → ${a.to}`);
}
if (!xfers.length) { console.log("\nno transfers at all — not a token this contract minted"); process.exit(0); }

const mintBlock = xfers[0].blockNumber!;
const holder = (xfers[xfers.length - 1].args as { to: string }).to;

console.log(`\ncomputing as owner ${holder}, mintBlock ${mintBlock} …`);
try {
  const pos = await retry(() => computePositionPnLV4(ID, mintBlock));
  console.log("OK", JSON.stringify({
    pool: pos.label ?? null,
    net: pos.result?.netPnlUsd,
  }, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
} catch (e) {
  const err = e as Error;
  console.log(`\nSKIPPED BECAUSE:\n  ${err.name}: ${err.message}`);
  if (err.cause) console.log(`  cause: ${String((err.cause as Error).message ?? err.cause).split("\n")[0]}`);
  console.log((err.stack ?? "").split("\n").slice(1, 6).join("\n"));
}
