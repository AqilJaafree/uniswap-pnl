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
const item = (closedAt: number, net: number, fees = 0, il = 0, tokenId = 1n, price = 0, gas = 0): DayItem =>
  ({ closedAt, net, fees, il, price, gas, tokenId });

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


// ---------------------------------------------------------------------------
// A day must carry every term its net is made of.
//
// net = fees + pricePnl + il − gas (see computePnL: withdrawn = hodl + il and
// hodl = deposited + pricePnl). The calendar bucketed only fees and il, so its
// day tooltip showed a net that its own components could not account for.
//
// MEASURED on wallet 0x7e99…A2C, 249 closed positions: net $754.76 against
// fees $682.77 and il −$447.86 — the two shown terms explain $234.91 and leave
// $519.85, or 69% of the headline, in a pricePnl ($534.91) and gas ($15.05) the
// view never mentioned. Only 11 of 249 positions carried it: a single-token
// deposit forces hodlUsd == depositedUsd and pricePnl to exactly 0, which is why
// this stayed invisible on most of them.
// ---------------------------------------------------------------------------
{
  const d = at(2026, 8, 14);
  // One position of each shape: a two-sided deposit that moved on price, and a
  // single-token deposit whose pricePnl is structurally zero.
  const b = bucketByDay([
    item(d, 0.1082, 0.1029, -0.1029, 1n, 0.1082, 0),
    item(d, 29.8, 34.6, -4.8, 2n, 0, 0),
  ], dayKeyUTC).get("2026-08-14")!;

  approx("fees still sum", b.fees, 34.7029);
  approx("il still sums", b.il, -4.9029);
  approx("pricePnl is carried", b.price, 0.1082);
  approx("gas is carried", b.gas, 0);
  eq("count unchanged", b.count, 2);
  approx("day net", b.net, 29.9082);
  // The identity the tooltip has to be able to show.
  approx("net reconciles to its parts", b.fees + b.price + b.il - b.gas, b.net, 1e-9);

  // Gas is subtracted, not added — a day that earned nothing but paid gas is a loss.
  const g = bucketByDay([item(at(2026, 8, 15), -0.03, 0, 0, 3n, 0, 0.03)], dayKeyUTC).get("2026-08-15")!;
  approx("gas-only day reconciles", g.fees + g.price + g.il - g.gas, g.net);
  eq("gas-only day is negative", g.net < 0, true);

  // The regression: fees + il alone must NOT be mistaken for the net when a
  // pricePnl leg exists.
  const shown = b.fees + b.il;
  const missing = Math.abs(b.net - shown) > 1e-9;
  console.log(`${missing ? "PASS" : "FAIL"}  fees + il alone does not explain the net (gap ${(b.net - shown).toFixed(4)})`);
  missing ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
