/**
 * Pure volume bucketing — the part that must be right regardless of which provider
 * fed it. Period keys are pinned to UTC (the providers' own candle boundary), so
 * these assertions don't depend on the runner's timezone.
 */
import {
  dayKeyUTC, weekKeyUTC, periodKey, periodStartSec, periodLabel, periodSpan,
  bucketBy, niceCeil, isWeekend, isPartialPeriod,
} from "./volume";
import { fmtUsdCompact } from "./format";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const utc = (y: number, m1: number, d: number, h = 12) => Math.floor(Date.UTC(y, m1 - 1, d, h) / 1000);

// ── day keys ──
eq("day key", dayKeyUTC(utc(2026, 8, 1)), "2026-08-01");
eq("day key at utc midnight", dayKeyUTC(utc(2026, 8, 1, 0)), "2026-08-01");
eq("day key at utc 23:59", dayKeyUTC(utc(2026, 8, 1, 23)), "2026-08-01");

// ── week keys snap to Monday, in UTC ──
// 2026-08-01 is a Saturday; its week starts Monday 2026-07-27.
eq("saturday → its monday", weekKeyUTC(utc(2026, 8, 1)), "2026-07-27");
eq("sunday → same monday", weekKeyUTC(utc(2026, 8, 2)), "2026-07-27");
eq("monday → itself", weekKeyUTC(utc(2026, 7, 27)), "2026-07-27");
eq("next monday rolls over", weekKeyUTC(utc(2026, 8, 3)), "2026-08-03");
eq("crosses a month backwards", weekKeyUTC(utc(2026, 3, 1)), "2026-02-23");
eq("crosses a year backwards", weekKeyUTC(utc(2027, 1, 1)), "2026-12-28");
eq("utc midnight monday", weekKeyUTC(utc(2026, 7, 27, 0)), "2026-07-27");
eq("utc 23:59 sunday", weekKeyUTC(utc(2026, 7, 26, 23)), "2026-07-20");

// ── granularity dispatch ──
eq("periodKey day", periodKey(utc(2026, 8, 1), "day"), "2026-08-01");
eq("periodKey week", periodKey(utc(2026, 8, 1), "week"), "2026-07-27");
eq("periodStartSec round-trips", weekKeyUTC(periodStartSec("2026-07-27")), "2026-07-27");

// ── labels ──
eq("week label spans 7 days", periodLabel("2026-07-27", "week"), "Jul 27 → Aug 02");
eq("day label names the weekday", periodLabel("2026-08-01", "day"), "Sat, Aug 01");

// ── weekend detection (the reason daily exists) ──
eq("saturday is weekend", isWeekend("2026-08-01"), true);
eq("sunday is weekend", isWeekend("2026-08-02"), true);
eq("monday is not", isWeekend("2026-08-03"), false);
eq("friday is not", isWeekend("2026-07-31"), false);

// ── partial (still-accruing) periods ──
{
  // Pin "now" to Sat 2026-08-01 12:00 UTC so this never depends on the clock.
  const now = utc(2026, 8, 1);
  eq("today is partial", isPartialPeriod("2026-08-01", "day", now), true);
  eq("yesterday is complete", isPartialPeriod("2026-07-31", "day", now), false);
  eq("current week is partial", isPartialPeriod("2026-07-27", "week", now), true);
  eq("last week is complete", isPartialPeriod("2026-07-20", "week", now), false);
  // The boundary itself: a week ending exactly at `now` is finished, not partial.
  eq("week ending exactly now is complete",
    isPartialPeriod("2026-07-20", "week", utc(2026, 7, 27, 0)), false);
}

// ── span filling ──
eq("week span is inclusive", periodSpan("2026-07-06", "2026-07-27", "week"),
  ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
eq("day span is inclusive", periodSpan("2026-07-30", "2026-08-02", "day"),
  ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
eq("span of one week", periodSpan("2026-07-06", "2026-07-06", "week"), ["2026-07-06"]);
// A day span must cross a month boundary without resetting.
eq("day span crosses a month", periodSpan("2026-01-30", "2026-02-02", "day"),
  ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);

// ── daily → periods ──
{
  const days = [
    { ts: utc(2026, 7, 27), value: 100 }, // Mon
    { ts: utc(2026, 7, 29), value: 50 },  // Wed, same week
    { ts: utc(2026, 8, 2), value: 25 },   // Sun, same week
    { ts: utc(2026, 8, 3), value: 7 },    // Mon, next week
  ];
  const w = bucketBy(days, "week");
  eq("sums within a week", w.get("2026-07-27"), 175);
  eq("splits at the week boundary", w.get("2026-08-03"), 7);
  eq("no extra weeks", w.size, 2);

  const d = bucketBy(days, "day");
  eq("day view keeps each candle", d.size, 4);
  eq("day view does not aggregate", d.get("2026-07-29"), 50);
}
{
  // Two candles in one UTC day (shouldn't happen, but must sum rather than drop).
  const d = bucketBy([{ ts: utc(2026, 8, 1, 3), value: 10 }, { ts: utc(2026, 8, 1, 20), value: 5 }], "day");
  eq("same-day candles sum", d.get("2026-08-01"), 15);
}
{
  // A provider gap must not become a zero — and must not poison the sum either.
  const m = bucketBy([
    { ts: utc(2026, 7, 27), value: 10 },
    { ts: utc(2026, 7, 28), value: NaN },
    { ts: utc(2026, 7, 29), value: -5 },
  ], "week");
  eq("drops NaN and negatives", m.get("2026-07-27"), 10);
}
eq("empty input → empty map", bucketBy([], "week").size, 0);

// ── axis ceiling ──
eq("nice ceil rounds up to 2", niceCeil(1.84e9), 2e9);
eq("nice ceil rounds up to 5", niceCeil(3.66e9), 5e9);
eq("nice ceil on an exact decade", niceCeil(1e6), 1e6);
eq("nice ceil above 5 → next decade", niceCeil(6.2e6), 1e7);
// A degenerate max must never produce a zero denominator for the line geometry.
eq("nice ceil of zero", niceCeil(0), 1);
eq("nice ceil of NaN", niceCeil(NaN), 1);

// ── compact USD ──
eq("null → dashes", fmtUsdCompact(null), "--");
eq("NaN → dashes", fmtUsdCompact(NaN), "--");
eq("Infinity → dashes", fmtUsdCompact(Infinity), "--");
eq("exact zero", fmtUsdCompact(0), "$0.00");
eq("rounds to zero", fmtUsdCompact(0.004), "<$0.01");
eq("under a thousand", fmtUsdCompact(483.958), "$483.96");
eq("thousands", fmtUsdCompact(22_808), "$22.8K");
eq("millions", fmtUsdCompact(18_054_054), "$18.1M");
eq("billions", fmtUsdCompact(3_659_637_513), "$3.66B");
eq("negative keeps the minus", fmtUsdCompact(-1_234_567), "−$1.23M");
eq("trillions stay decimal", fmtUsdCompact(1.52e12), "$1.52T");
eq("no e-notation", /e/i.test(fmtUsdCompact(9.9e15)), false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
