/**
 * Live smoke test for the weekly-volume providers. Not part of `npm run verify`
 * (it hits the network); run it when a provider's shape or coverage is in doubt:
 *
 *   npx tsx web/src/lib/volume.smoke.ts
 *
 * Checks both scopes end to end: DefiLlama's chain-wide v3/v4 breakdown, and
 * GeckoTerminal's per-pool candles for a v3 pool address AND a v4 poolId — the two
 * key shapes, since v4 pools have no address and would 404 if keyed wrongly.
 */
import { fetchChainWeekly, fetchPoolsWeekly, weekLabel, type PoolRef } from "./volume";
import { fmtUsdCompact } from "./format";

const POOLS: PoolRef[] = [
  { id: "0xa70fc67c9f69da90b63a0e4c05d229954574e313", label: "CASHCAT / WETH 1%", version: "v3" },
  { id: "0x10cc6bd38112cac182db90b6a71d8bb5939526ba", label: "PONS / WETH 1%", version: "v3" },
  { id: "0x1d5b7bfffebfe8fbfc230bc49ad414c245d1eef9", label: "JOVI / WETH 0.01%", version: "v3" },
  { id: "0x0a9c28f389e46cd3a52f1084359f72b7c85f80ba283dce64d34ccb5a213e0ff3", label: "GME / USDG 0.7%", version: "v4" },
  { id: "0x67c92850184a76efc034072b3ccb6094d63dec6bec50df1c994eb643ba050a58", label: "FRONG / USDG 4.69%", version: "v4" },
];

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── DefiLlama: chain-wide Uniswap v3 / v4 ──");
const chain = await fetchChainWeekly();
check("returns weeks", chain.weeks.length > 0, `${chain.weeks.length} weeks from ${chain.coverageStart}`);
check("both series present", chain.weeks.some((w) => w.v3 > 0) && chain.weeks.some((w) => w.v4 > 0));
for (const w of chain.weeks.slice(-5)) {
  console.log(`   ${weekLabel(w.week).padEnd(18)} v3 ${fmtUsdCompact(w.v3).padStart(9)}   v4 ${fmtUsdCompact(w.v4).padStart(9)}`);
}

console.log("\n── GeckoTerminal: per-pool (v3 address + v4 poolId) ──");
const pv = await fetchPoolsWeekly(POOLS);
check("all pools indexed", pv.missing.length === 0, pv.missing.length ? `missing: ${pv.missing.map((m) => m.label).join(", ")}` : `${pv.covered.length} covered`);
check("a v4 poolId resolved", pv.covered.some((p) => p.version === "v4"));
check("returns weeks", pv.weeks.length > 0, `${pv.weeks.length} weeks from ${pv.coverageStart}`);
for (const w of pv.weeks.slice(-5)) {
  console.log(`   ${weekLabel(w.week).padEnd(18)} total ${fmtUsdCompact(w.total).padStart(9)}`);
}

// Sanity: the wallet's pools are a subset of the chain, so a week's pool total can
// never exceed that week's chain-wide Uniswap volume. A breach means the two
// providers are being read on different scales (e.g. one already weekly).
const chainBy = new Map(chain.weeks.map((w) => [w.week, w.v3 + w.v4]));
const breach = pv.weeks.find((w) => chainBy.has(w.week) && w.total > chainBy.get(w.week)! * 1.0001);
check("pool total ≤ chain total per week", !breach,
  breach ? `${breach.week}: pools ${fmtUsdCompact(breach.total)} > chain ${fmtUsdCompact(chainBy.get(breach.week)!)}` : "");

console.log(`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`}`);
if (bad > 0) process.exit(1);
