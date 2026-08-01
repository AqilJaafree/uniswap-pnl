/**
 * Pure weekly-volume bucketing — the part that must be right regardless of which
 * provider fed it. Week keys are pinned to UTC (the providers' own day boundary),
 * so these assertions don't depend on the runner's timezone.
 */
import { weekKeyUTC, weekStartSec, weekLabel, weekSpan, bucketWeekly, niceCeil } from "./volume";
import { fmtUsdCompact } from "./format";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const utc = (y: number, m1: number, d: number, h = 12) => Math.floor(Date.UTC(y, m1 - 1, d, h) / 1000);

// ── week keys snap to Monday, in UTC ──
// 2026-08-01 is a Saturday; its week starts Monday 2026-07-27.
eq("saturday → its monday", weekKeyUTC(utc(2026, 8, 1)), "2026-07-27");
eq("sunday → same monday", weekKeyUTC(utc(2026, 8, 2)), "2026-07-27");
eq("monday → itself", weekKeyUTC(utc(2026, 7, 27)), "2026-07-27");
eq("next monday rolls over", weekKeyUTC(utc(2026, 8, 3)), "2026-08-03");
// Month and year boundaries must not reset the Monday walk.
eq("crosses a month backwards", weekKeyUTC(utc(2026, 3, 1)), "2026-02-23");
eq("crosses a year backwards", weekKeyUTC(utc(2027, 1, 1)), "2026-12-28");

// A UTC-midnight candle belongs to the week that midnight starts, not the one before.
eq("utc midnight monday", weekKeyUTC(utc(2026, 7, 27, 0)), "2026-07-27");
eq("utc 23:59 sunday", weekKeyUTC(utc(2026, 7, 26, 23)), "2026-07-20");

eq("weekStartSec round-trips", weekKeyUTC(weekStartSec("2026-07-27")), "2026-07-27");
eq("weekLabel spans 7 days", weekLabel("2026-07-27"), "Jul 27 → Aug 02");

// ── span filling ──
eq("span is inclusive", weekSpan("2026-07-06", "2026-07-27"),
  ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
eq("span of one week", weekSpan("2026-07-06", "2026-07-06"), ["2026-07-06"]);

// ── daily → weekly ──
{
  const days = [
    { ts: utc(2026, 7, 27), value: 100 }, // Mon
    { ts: utc(2026, 7, 29), value: 50 },  // Wed, same week
    { ts: utc(2026, 8, 2), value: 25 },   // Sun, same week
    { ts: utc(2026, 8, 3), value: 7 },    // Mon, next week
  ];
  const m = bucketWeekly(days);
  eq("sums within a week", m.get("2026-07-27"), 175);
  eq("splits at the boundary", m.get("2026-08-03"), 7);
  eq("no extra weeks", m.size, 2);
}
{
  // A provider gap must not become a zero — and must not poison the sum either.
  const m = bucketWeekly([
    { ts: utc(2026, 7, 27), value: 10 },
    { ts: utc(2026, 7, 28), value: NaN },
    { ts: utc(2026, 7, 29), value: -5 },
  ]);
  eq("drops NaN and negatives", m.get("2026-07-27"), 10);
}
eq("empty input → empty map", bucketWeekly([]).size, 0);

// ── compact USD ──
eq("null → dashes", fmtUsdCompact(null), "--");
eq("NaN → dashes", fmtUsdCompact(NaN), "--");
eq("Infinity → dashes", fmtUsdCompact(Infinity), "--");
eq("exact zero", fmtUsdCompact(0), "$0.00");
eq("rounds to zero", fmtUsdCompact(0.004), "<$0.01");
eq("under a thousand", fmtUsdCompact(483.958), "$483.96");
eq("thousands", fmtUsdCompact(22_808_760 / 1000), "$22.8K");
eq("millions", fmtUsdCompact(18_054_054), "$18.1M");
eq("billions", fmtUsdCompact(3_659_637_513), "$3.66B");
eq("negative keeps the minus", fmtUsdCompact(-1_234_567), "−$1.23M");
// No scientific notation may ever escape, at any magnitude.
eq("trillions stay decimal", fmtUsdCompact(1.52e12), "$1.52T");
eq("no e-notation", /e/i.test(fmtUsdCompact(9.9e15)), false);

// ── axis ceiling ──
eq("nice ceil rounds up to 2", niceCeil(1.84e9), 2e9);
eq("nice ceil rounds up to 5", niceCeil(3.66e9), 5e9);
eq("nice ceil on an exact decade", niceCeil(1e6), 1e6);
eq("nice ceil above 5 → next decade", niceCeil(6.2e6), 1e7);
// A degenerate max must never produce a zero denominator for the bar heights.
eq("nice ceil of zero", niceCeil(0), 1);
eq("nice ceil of NaN", niceCeil(NaN), 1);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
