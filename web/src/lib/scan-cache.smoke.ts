/**
 * Live proof that the scan cache does what it claims, against real chain data.
 *
 * The unit tests drive the cache with synthetic logs. This drives it with the real thing,
 * which is the only way to answer the two questions those tests cannot:
 *
 *   1. Do viem's log and receipt objects survive a structured clone at all? That is what
 *      IndexedDB stores values with. If they do not, every write is silently dropped and
 *      the whole feature is a no-op that still passes every unit test.
 *   2. Does a SECOND scan of the same wallet actually stop asking? Measured here as the
 *      request count and the wall clock of pass 2 against pass 1.
 *
 * Node has no IndexedDB, so the memory store stands in — everything above it (the range
 * arithmetic, the finality rule, the per-id records) is the same code the browser runs.
 * Pass 2 clears only the in-scan promise caches, which is exactly what a reload is.
 *
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/scan-cache.smoke.ts [wallet]
 */
import { memoryStore, setStore } from "./idb";
import { resetCaches } from "./chain-cache";
import { clearPromiseCache } from "./promise-cache";
import { clearTokenMetaCache } from "./token-meta";
import { analyzeWallet } from "./chain";

const WALLET = process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C";
/** Keep a full scan of a large wallet from running the clock out; both passes get it. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 240_000);

const store = memoryStore();
setStore(store);

/** Count JSON-RPC requests by method, the way perf-probe.smoke.ts does. */
const byMethod = new Map<string, number>();
let total = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    for (const call of Array.isArray(body) ? body : [body]) {
      if (!call?.method) continue;
      total++;
      byMethod.set(call.method, (byMethod.get(call.method) ?? 0) + 1);
    }
  } catch { /* not a JSON-RPC body — do not let accounting break the request */ }
  return realFetch(input, init);
}) as typeof fetch;

function snapshot() {
  const m = new Map(byMethod);
  const t = total;
  byMethod.clear();
  total = 0;
  return { total: t, byMethod: m };
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  ok ? pass++ : fail++;
};

async function scan(label: string) {
  const t0 = Date.now();
  const timer = setTimeout(() => { console.log(`  (${label}: budget reached, still running)`); }, BUDGET_MS);
  const p = await analyzeWallet(WALLET);
  clearTimeout(timer);
  const secs = (Date.now() - t0) / 1000;
  const reqs = snapshot();
  console.log(`\n${label}: ${p.positions.length} positions, ${p.skipped.length} skipped, ${secs.toFixed(0)}s, ${reqs.total} requests`);
  console.log(`  ${[...reqs.byMethod].map(([m, n]) => `${m}=${n}`).join("  ")}`);
  return { p, secs, reqs };
}

async function main() {
  // (1) Structured clone, on the real shapes. Done FIRST: if this fails, nothing below
  // means anything, and the failure is invisible in production because idb.ts swallows a
  // rejected write on purpose.
  const { client } = await import("./chain");
  const head = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber: head - 10n });
  let cloneErr = "";
  try {
    const round = structuredClone({ block, head });
    check("a block survives structured clone", round.block.number === block.number,
      `number=${round.block.number} timestamp=${typeof round.block.timestamp}`);
    check("bigints stay bigints through the clone", typeof round.head === "bigint", `${typeof round.head}`);
  } catch (e) { cloneErr = (e as Error).message; }
  if (cloneErr) check("structured clone of chain data", false, cloneErr);

  // (2) Cold scan, then a reload against the same store.
  const first = await scan("pass 1 (cold cache)");
  check("cold scan read positions", first.p.positions.length > 0, `${first.p.positions.length}`);
  check("cold scan wrote cache entries", store.size() > 0, `${store.size()} entries`);
  const wroteLogs = store.writes;

  clearPromiseCache();
  clearTokenMetaCache();
  const second = await scan("pass 2 (warm cache, same store)");

  check("warm scan reads the same positions",
    second.p.positions.length === first.p.positions.length,
    `${second.p.positions.length} vs ${first.p.positions.length}`);
  check("warm scan skips no more than the cold one",
    second.p.skipped.length <= first.p.skipped.length,
    `${second.p.skipped.length} vs ${first.p.skipped.length}`);
  // The headline claim. Not a fixed ratio — the tail queries and the live tip reads are
  // paid every time — but a warm scan that is not clearly cheaper means the cache is not
  // being hit and something above it is keying wrongly.
  check("warm scan issues fewer requests",
    second.reqs.total < first.reqs.total,
    `${second.reqs.total} vs ${first.reqs.total} (${(100 * (1 - second.reqs.total / first.reqs.total)).toFixed(0)}% fewer)`);
  check("warm scan is faster", second.secs < first.secs,
    `${second.secs.toFixed(0)}s vs ${first.secs.toFixed(0)}s`);

  // Totals must not MOVE. A cache that changes the answer is worse than no cache.
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-9);
  check("net PnL is unchanged", near(first.p.totals.net, second.p.totals.net),
    `${first.p.totals.net.toFixed(6)} vs ${second.p.totals.net.toFixed(6)}`);
  check("fees are unchanged", near(first.p.totals.fees, second.p.totals.fees),
    `${first.p.totals.fees.toFixed(6)} vs ${second.p.totals.fees.toFixed(6)}`);
  check("gas is unchanged", near(first.p.totals.gas, second.p.totals.gas),
    `${first.p.totals.gas.toExponential(6)} vs ${second.p.totals.gas.toExponential(6)}`);

  // (3) The escape hatch has to actually empty the thing.
  await resetCaches();
  check("resetCaches empties the store", store.size() === 0, `${store.size()} entries`);

  console.log(`\n  (cold pass wrote ${wroteLogs} records)`);
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
