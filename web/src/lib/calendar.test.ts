/**
 * Pure calendar bucketing — realized PnL grouped by close-date, plus the
 * month-grid geometry the calendar renders. Framework-free and deterministic:
 * tests pin the day key to UTC so they don't depend on the runner's timezone.
 */
import {
  dayKeyUTC, bucketByDay, monthGrid, monthRange, type DayItem,
} from "./calendar";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const approx = (name: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want≈${want}`);
  ok ? pass++ : fail++;
};

const at = (y: number, m1: number, d: number) => Math.floor(Date.UTC(y, m1 - 1, d, 12) / 1000);
const item = (closedAt: number, net: number, fees = 0, il = 0, tokenId = 1n): DayItem =>
  ({ closedAt, net, fees, il, tokenId });

// ── dayKeyUTC: unix seconds → "YYYY-MM-DD" (UTC) ──
eq("dayKeyUTC mid-day", dayKeyUTC(at(2026, 7, 3)), "2026-07-03");
eq("dayKeyUTC pads", dayKeyUTC(at(2026, 1, 5)), "2026-01-05");

// ── bucketByDay: sum net/fees/il + count, keyed by day ──
{
  const items = [
    item(at(2026, 7, 3), 0.005, 0.006, -0.001, 10n),
    item(at(2026, 7, 3), 0.003, 0.003, 0, 11n),
    item(at(2026, 7, 5), -0.002, 0.001, -0.003, 12n),
  ];
  const b = bucketByDay(items, dayKeyUTC);
  eq("bucket day count", b.size, 2);
  const d3 = b.get("2026-07-03")!;
  approx("day net sum", d3.net, 0.008);
  approx("day fees sum", d3.fees, 0.009);
  approx("day il sum", d3.il, -0.001);
  eq("day count", d3.count, 2);
  eq("day tokenIds", d3.tokenIds.join(","), "10,11");
}

// ── monthGrid(July 2026): 6×7, Monday-first, spillover flagged ──
{
  const g = monthGrid(2026, 6); // month is 0-based → 6 = July
  eq("grid rows", g.length, 6);
  eq("grid cols", g[0].length, 7);
  // July 1 2026 is a Wednesday → 2 leading spillover days (Mon Jun 29, Tue Jun 30)
  eq("first cell is Jun 29", g[0][0].day, 29);
  eq("first cell out of month", g[0][0].inMonth, false);
  eq("Jul 1 at index 2", g[0][2].day, 1);
  eq("Jul 1 in month", g[0][2].inMonth, true);
  eq("Jul 1 key", g[0][2].key, "2026-07-01");
  // last cell is Aug 9 (spillover)
  eq("last cell day", g[5][6].day, 9);
  eq("last cell month (0-based)", g[5][6].month, 7);
  eq("last cell out of month", g[5][6].inMonth, false);
}

// ── monthRange: first/last close-month across items ──
{
  const r = monthRange([item(at(2026, 1, 20), 0), item(at(2026, 7, 2), 0), item(at(2026, 3, 9), 0)], dayKeyUTC)!;
  eq("range min year", r.min.year, 2026);
  eq("range min month", r.min.month, 0); // January (0-based)
  eq("range max month", r.max.month, 6); // July
  eq("empty range is null", monthRange([], dayKeyUTC), null);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
