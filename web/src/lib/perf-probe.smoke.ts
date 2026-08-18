/**
 * Throughput + request-count probe for analyzeWallet. Scratch tooling, not part of the app.
 *
 * Run: RPC_URL=<proxy> BUDGET_S=240 npx tsx web/src/lib/perf-probe.smoke.ts [wallet]
 *
 * Counts every JSON-RPC request by method and by lane, and reports requests PER COMPLETED
 * POSITION — which is the number a call-volume change should move, and unlike wall time it
 * does not drift with how throttled the endpoint happens to be.
 */
const counts = new Map<string, number>();
const lanes = new Map<string, number>();
let http429 = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
  const lane = url.includes("lane=wallet") ? "wallet" : "ordinary";
  lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const list = Array.isArray(body) ? body : [body];
    for (const b of list) {
      const m = String(b?.method ?? "?");
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  } catch { /* not JSON we can read; still counted by lane */ }
  const res = await realFetch(input as RequestInfo, init);
  if (res.status === 429) http429++;
  return res;
}) as typeof fetch;

const WALLET = process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C";
const BUDGET_MS = Number(process.env.BUDGET_S ?? 240) * 1000;

const { analyzeWallet } = await import("./chain");

let doneCount = 0, totalCount = 0;
const started = Date.now();
const scan = analyzeWallet(WALLET, (d, t) => { doneCount = d; totalCount = t; })
  .then(() => "complete" as const)
  .catch((e) => `error: ${(e as Error).message}` as const);
const budget = new Promise<"budget">((r) => setTimeout(() => r("budget"), BUDGET_MS));

const outcome = await Promise.race([scan, budget]);
const elapsed = (Date.now() - started) / 1000;
const reqs = [...counts.values()].reduce((a, b) => a + b, 0);

console.log(`\noutcome            ${outcome}`);
console.log(`elapsed            ${elapsed.toFixed(1)}s`);
console.log(`positions done     ${doneCount} / ${totalCount}`);
console.log(`requests total     ${reqs}`);
console.log(`requests/position  ${doneCount ? (reqs / doneCount).toFixed(1) : "n/a"}`);
console.log(`sec/position       ${doneCount ? (elapsed / doneCount).toFixed(2) : "n/a"}`);
console.log(`HTTP 429s          ${http429}`);
console.log(`by lane            ${[...lanes].map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`by method          ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
process.exit(0);
