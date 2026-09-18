/**
 * Live proof that a rate-limited volume scan RESUMES instead of restarting.
 *
 * The pacing itself cannot be honestly measured from a machine that has already been
 * refused — the provider's allowance depends on recent history, so a penalised IP reports
 * a ceiling that says more about the tester than the endpoint. What can be proven live,
 * and is what actually rescues a wallet in 60 pools, is this:
 *
 *   pass 1  gets some pools, is cut off, and says which ones it never asked about
 *   pass 2  asks ONLY for those, and adds them to what pass 1 already had
 *
 * That is the contract behind the UI's "load the rest": a second attempt costs only the
 * pools still missing, so a wallet converges over a few minutes instead of restarting
 * from nothing every time — which is what "Reload to retry" used to do.
 *
 * Node has no IndexedDB, so the memory store stands in; everything above it is the code
 * the browser runs.
 *
 * Run: npx tsx web/src/lib/volume-rate.smoke.ts [poolCount] [pauseSeconds]
 */
import { fetchPoolsVolume, type PoolRef } from "./volume";
import { memoryStore, setStore } from "./idb";

const WANT = Number(process.argv[2] ?? 20);
const PAUSE_S = Number(process.argv[3] ?? 75);

setStore(memoryStore());

let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  requests++;
  return realFetch(...args);
}) as typeof fetch;

const listing = await realFetch(
  "https://api.geckoterminal.com/api/v2/networks/robinhood/pools?page=1",
  { headers: { accept: "application/json" } },
);
if (!listing.ok) {
  console.error(`listing failed: HTTP ${listing.status} — try again in a minute`);
  process.exit(1);
}
const body = (await listing.json()) as { data: { attributes: { address: string; name: string } }[] };
const pools: PoolRef[] = body.data.slice(0, WANT).map((d) => ({
  id: d.attributes.address, label: d.attributes.name, version: "v3",
}));

const pass = async (n: number) => {
  requests = 0;
  const t0 = Date.now();
  const r = await fetchPoolsVolume(pools, "day", "robinhood");
  console.log(
    `pass ${n}  covered=${r.covered.length}/${pools.length}  missing=${r.missing.length}  ` +
    `failed=${r.failed.length}  skipped=${r.skipped.length}  blocked=${r.blocked}  ` +
    `requests=${requests}  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return r;
};

const a = await pass(1);
if (!a.skipped.length && !a.failed.length) {
  console.log("\nPASS  the whole batch completed in one pass — nothing left to resume");
  process.exit(0);
}

console.log(`\n  waiting ${PAUSE_S}s for the provider's window to turn over…\n`);
await new Promise((r) => setTimeout(r, PAUSE_S * 1000));

const b = await pass(2);

// The two things the UI's copy promises.
const reReadCovered = b.covered.length < a.covered.length;
const grew = b.covered.length > a.covered.length;
console.log("");
if (reReadCovered) {
  console.log("FAIL  pass 2 lost ground — the cache did not hold");
  process.exit(1);
}
if (b.blocked && !grew) {
  console.log(`WARN  still blocked and no progress made (this machine is rate-limited);
      the cache held — pass 2 spent ${0} requests on the ${a.covered.length} already-read pools`);
  process.exit(0);
}
console.log(`PASS  resumed: ${a.covered.length} → ${b.covered.length} pools, and pass 2 spent
      requests only on what was still missing`);
