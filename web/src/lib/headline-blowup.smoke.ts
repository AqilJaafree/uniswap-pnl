/**
 * Diagnostic (live RPC): WHICH position is responsible for a wallet's headline.
 *
 * A single position priced against the AMM's numerical limit reports ~1e39, and the
 * portfolio total is a plain sum — so one blown-up position IS the headline and every
 * other position falls below float resolution. This prints the per-position ranking the
 * summary bar does not, so the offender can be named instead of inferred.
 *
 * Run: RPC_URL=https://uniswap.yeeteora.xyz/rpc npx tsx web/src/lib/headline-blowup.smoke.ts [wallet]
 */
import { analyzeWallet } from "./chain";

const WALLET = process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C";
const SANE = 1e9; // no honest position on this chain nets a billion of anything

async function main() {
  const p = await analyzeWallet(WALLET);
  const rows = p.positions
    .map((x) => ({
      id: `${x.version}#${x.tokenId}`,
      pair: `${x.sym0}/${x.sym1}`,
      kind: x.numeraireKind,
      open: x.open,
      net: x.result.netPnlUsd,
      fees: x.result.feesUsd,
      il: x.result.ilUsd,
      price: x.result.pricePnlUsd,
      px: x.priceT1perT0,
      basis: x.priceBasis,
      flags: `${x.tickComplete ? "" : "tick!"}${x.feesComplete ? "" : "fees~"}` || "ok",
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  console.log(`\nwallet ${p.query}  positions=${p.positions.length} skipped=${p.skipped.length}\n`);
  console.log("TOP 12 BY |net|");
  for (const r of rows.slice(0, 12)) {
    console.log(
      `  ${r.id.padEnd(12)} ${r.pair.padEnd(16)} ${r.kind} ${r.open ? "open  " : "closed"} ` +
      `net=${r.net.toExponential(3).padStart(11)} fees=${r.fees.toExponential(3).padStart(11)} ` +
      `il=${r.il.toExponential(2).padStart(10)} price=${r.price.toExponential(2).padStart(10)} ` +
      `px=${r.px.toExponential(2)} ${r.basis} [${r.flags}]`,
    );
  }

  const insane = rows.filter((r) => !Number.isFinite(r.net) || Math.abs(r.net) > SANE);
  console.log(`\nINSANE (|net| > 1e9 or non-finite): ${insane.length}`);
  for (const r of insane) console.log(`  ${r.id} ${r.pair} net=${r.net.toExponential(3)} basis=${r.basis} flags=${r.flags}`);

  // What the headline would read with the blown-up positions removed — i.e. what the
  // other 280 positions actually add up to.
  const sane = rows.filter((r) => Number.isFinite(r.net) && Math.abs(r.net) <= SANE);
  const sum = (f: (r: typeof sane[number]) => number, k: string) =>
    sane.filter((r) => r.kind === k).reduce((a, r) => a + f(r), 0);
  console.log(`\nHEADLINE WITHOUT THEM`);
  console.log(`  eth: net=${sum((r) => r.net, "eth").toFixed(6)} fees=${sum((r) => r.fees, "eth").toFixed(6)} over ${sane.filter((r) => r.kind === "eth").length}`);
  console.log(`  usd: net=${sum((r) => r.net, "usd").toFixed(2)} fees=${sum((r) => r.fees, "usd").toFixed(2)} over ${sane.filter((r) => r.kind === "usd").length}`);
  console.log(`\nAS REPORTED`);
  console.log(`  eth: net=${p.totals.eth.net.toExponential(3)} fees=${p.totals.eth.fees.toExponential(3)}`);
  console.log(`  usd: net=${p.totals.usd.net.toExponential(3)} fees=${p.totals.usd.fees.toExponential(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
