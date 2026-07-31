/**
 * End-to-end smoke (live RPC): run the REAL production path — `analyzeWallet`, the
 * same call the browser makes — with no external throttle, so the client's own
 * concurrency gate is what's under test.
 *
 * Guards the silent-under-report failure: unthrottled, the public RPC times out
 * under analyzeWallet's fan-out, positions exhaust their retries and land in
 * `skipped`, and the headline total quietly omits them. Any skip is a FAIL here.
 *
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/wallet-analyze.smoke.ts [wallet]
 */
import { analyzeWallet } from "./chain";

const WALLET = process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C";

async function main() {
  const t0 = Date.now();
  const p = await analyzeWallet(WALLET, (done, total) => {
    if (done === 0 || done === total || done % 10 === 0) console.log(`  …${done}/${total}`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const v3 = p.positions.filter((x) => x.version === "v3").length;
  const v4 = p.positions.filter((x) => x.version === "v4").length;
  const unverified = p.positions.filter((x) => !x.tickComplete);

  console.log(`\nwallet ${p.query}   (${secs}s)`);
  console.log(`  positions read : ${p.positions.length}  (v3 ${v3}, v4 ${v4})`);
  console.log(`  skipped        : ${p.skipped.length}${p.skipped.length ? ` → ${p.skipped.join(", ")}` : ""}`);
  console.log(`  price-unverified: ${unverified.length}${unverified.length ? ` → ${unverified.map((x) => `#${x.tokenId}`).join(", ")}` : ""}`);
  console.log(`  totals         : net=${p.totals.net.toFixed(2)} fees=${p.totals.fees.toFixed(2)} gasEth=${p.totals.gas.toExponential(3)}`);

  const ok = p.skipped.length === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${p.skipped.length} position(s) skipped (want 0 — a skip silently under-reports the wallet total)`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
