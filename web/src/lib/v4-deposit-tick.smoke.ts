/**
 * Regression smoke (live RPC): a closed v4 position whose pool price barely moved
 * between deposit and exit must report ~zero price-PnL. Guards the bug where the
 * deposit-block tick fell back to the pool's genesis (init) tick — fabricating a
 * ~4x price gain (#248557 PONS/USDG was reported +226%; true ≈ 0% + fees).
 * Run: npx tsx web/src/lib/v4-deposit-tick.smoke.ts
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { createChainClient } from "./chain";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

// chain.ts's viem `client` and computePositionPnLV4 are no longer importable directly —
// see chain-v4.smoke.ts for the same pattern. A small local client resolves the mint tx;
// createChainClient(...).analyze(mintTxHash) does the real computation, with no owner
// context, same as the direct computePositionPnLV4(tokenId, mintBlock) call this replaces.
const RPC_URL = process.env.RPC_URL || ROBINHOOD_CHAIN.rpcUrl;
const rawClient = createPublicClient({ transport: http(RPC_URL) });
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

// #248557: PONS/USDG. Real slot0 ticks — deposit block 15483997 tick=-308799,
// exit block 15567492 tick=-308872 (73 ticks ≈ 0.7% apart). Both deposit and exit
// were essentially all-USDG at the same price, so price-PnL must be ~0.
const TOKEN_ID = 248557n;

async function main() {
  const mints = await rawClient.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId: TOKEN_ID }, fromBlock: 0n, toBlock: "latest" });
  const mintTx = mints[0]?.transactionHash;
  if (!mintTx) throw new Error(`no mint Transfer found for #${TOKEN_ID}`);
  const portfolio = await createChainClient(ROBINHOOD_CHAIN).analyze(mintTx);
  const p = portfolio.positions[0];
  if (!p) throw new Error(`analyze(${mintTx}) produced no position (skipped: ${portfolio.skipped.join(", ")})`);
  const r = p.result;
  console.log(`#${TOKEN_ID} ${p.sym0}/${p.sym1}  dep=${r.depositedUsd.toFixed(2)} wd=${r.withdrawnUsd.toFixed(2)} hodl=${r.hodlUsd.toFixed(2)}`);
  console.log(`  net=${r.netPnlUsd.toFixed(2)} pricePnl=${r.pricePnlUsd.toFixed(2)} IL=${r.ilUsd.toFixed(2)} pnl%=${(r.pnlPct * 100).toFixed(1)}`);

  // Price barely moved → deposited tokens valued at exit price ≈ deposited value.
  const pricePnlFrac = Math.abs(r.pricePnlUsd) / Math.max(1, r.depositedUsd);
  const ok = pricePnlFrac < 0.1; // < 10% of deposit (was ~330% under the init-tick bug)
  console.log(`\n${ok ? "PASS" : "FAIL"}  |pricePnl|/deposited = ${(pricePnlFrac * 100).toFixed(1)}% (want < 10%)`);

  // Gas must be captured even on a USDG pair with no WETH leg (was dropped to 0).
  const gasOk = p.gasEth > 0;
  console.log(`${gasOk ? "PASS" : "FAIL"}  gasEth = ${p.gasEth.toFixed(8)} ETH (want > 0)`);

  if (!ok || !gasOk) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
