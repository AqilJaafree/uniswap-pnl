/**
 * Live smoke test for the volume providers. Not part of `npm run verify` (it hits
 * the network); run it when a provider's shape or coverage is in doubt:
 *
 *   npx tsx web/src/lib/volume.smoke.ts
 *
 * Checks both scopes end to end at both granularities: DefiLlama's chain-wide
 * v3/v4 breakdown, and GeckoTerminal's per-pool candles for a v3 pool address AND
 * a v4 poolId — the two key shapes, since v4 pools have no address and would 404
 * if keyed wrongly.
 */
import { fetchChainVolume, fetchPoolsVolume, periodLabel, isWeekend, type PoolRef } from "./volume";
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
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 1e-6;

console.log("── DefiLlama: chain-wide Uniswap v3 / v4 ──");
const chainW = await fetchChainVolume("week");
const chainD = await fetchChainVolume("day");
check("weekly points", chainW.points.length > 0, `${chainW.points.length} weeks from ${chainW.coverageStart}`);
check("daily points", chainD.points.length > chainW.points.length, `${chainD.points.length} days`);
check("both series present", chainW.points.some((p) => p.v3 > 0) && chainW.points.some((p) => p.v4 > 0));

// The week view is a roll-up of the day view, so the two must total identically.
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
check("daily and weekly totals agree",
  near(sum(chainD.points.map((p) => p.v3 + p.v4)), sum(chainW.points.map((p) => p.v3 + p.v4))),
  `day ${fmtUsdCompact(sum(chainD.points.map((p) => p.v3 + p.v4)))} vs week ${fmtUsdCompact(sum(chainW.points.map((p) => p.v3 + p.v4)))}`);

for (const p of chainD.points.slice(-7)) {
  console.log(`   ${periodLabel(p.period, "day").padEnd(14)}${isWeekend(p.period) ? "🛌" : "  "} v3 ${fmtUsdCompact(p.v3).padStart(9)}   v4 ${fmtUsdCompact(p.v4).padStart(9)}`);
}

// The weekday/weekend split is the whole reason the day view exists.
const wd = chainD.points.filter((p) => !isWeekend(p.period) && p.v3 + p.v4 > 0);
const we = chainD.points.filter((p) => isWeekend(p.period) && p.v3 + p.v4 > 0);
if (wd.length && we.length) {
  const avg = (xs: typeof wd) => sum(xs.map((p) => p.v3 + p.v4)) / xs.length;
  console.log(`   weekday avg ${fmtUsdCompact(avg(wd))}/day · weekend avg ${fmtUsdCompact(avg(we))}/day (${Math.round((avg(we) / avg(wd)) * 100)}%)`);
}

console.log("\n── GeckoTerminal: per-pool (v3 address + v4 poolId) ──");
const pvW = await fetchPoolsVolume(POOLS, "week");
const pvD = await fetchPoolsVolume(POOLS, "day");
check("all pools indexed", pvW.missing.length === 0,
  pvW.missing.length ? `missing: ${pvW.missing.map((m) => m.label).join(", ")}` : `${pvW.covered.length} covered`);
check("no transient failures", pvW.failed.length === 0 && pvD.failed.length === 0,
  [...pvW.failed, ...pvD.failed].map((m) => m.label).join(", "));
check("a v4 poolId resolved", pvW.covered.some((p) => p.version === "v4"));
check("weekly points", pvW.points.length > 0, `${pvW.points.length} weeks from ${pvW.coverageStart}`);
check("daily points", pvD.points.length > pvW.points.length, `${pvD.points.length} days`);
check("daily and weekly totals agree",
  near(sum(pvD.points.map((p) => p.total)), sum(pvW.points.map((p) => p.total))));

for (const p of pvW.points.slice(-5)) {
  console.log(`   ${periodLabel(p.period, "week").padEnd(18)} total ${fmtUsdCompact(p.total).padStart(9)}`);
}

// Sanity: the wallet's pools are a subset of the chain, so a period's pool total
// can never exceed that period's chain-wide Uniswap volume. A breach means the two
// providers are being read on different scales (e.g. one already aggregated).
const chainBy = new Map(chainW.points.map((p) => [p.period, p.v3 + p.v4]));
const breach = pvW.points.find((p) => chainBy.has(p.period) && p.total > chainBy.get(p.period)! * 1.0001);
check("pool total ≤ chain total per week", !breach,
  breach ? `${breach.period}: pools ${fmtUsdCompact(breach.total)} > chain ${fmtUsdCompact(chainBy.get(breach.period)!)}` : "");

console.log(`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`}`);
if (bad > 0) process.exit(1);
