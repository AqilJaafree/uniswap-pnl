/**
 * Pure, framework-free calendar helpers for the realized-PnL month view.
 *
 * A position's net PnL is "realized" the day it closed, so we bucket closed
 * positions by their close-date and render one month at a time. All values are
 * in the portfolio numeraire (Ξ) — the same unit the summary bar sums in.
 */

export interface DayItem {
  closedAt: number; // unix seconds
  net: number; // numeraire (e.g. WETH)
  fees: number;
  il: number;
  tokenId: bigint;
}

export interface DayBucket {
  net: number;
  fees: number;
  il: number;
  count: number;
  tokenIds: bigint[];
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const ymd = (y: number, month0: number, d: number) => `${y}-${pad(month0 + 1)}-${pad(d)}`;

/** "YYYY-MM-DD" in the runner's local time — a calendar should match the user's days. */
export const dayKeyLocal = (tsSec: number): string => {
  const d = new Date(tsSec * 1000);
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
};

/** "YYYY-MM-DD" in UTC — deterministic; used by tests. */
export const dayKeyUTC = (tsSec: number): string => {
  const d = new Date(tsSec * 1000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Group items by day key, summing net/fees/il and collecting tokenIds (input order preserved). */
export function bucketByDay(
  items: DayItem[],
  dayKey: (tsSec: number) => string = dayKeyLocal,
): Map<string, DayBucket> {
  const out = new Map<string, DayBucket>();
  for (const it of items) {
    const key = dayKey(it.closedAt);
    const b = out.get(key) ?? { net: 0, fees: 0, il: 0, count: 0, tokenIds: [] };
    b.net += it.net;
    b.fees += it.fees;
    b.il += it.il;
    b.count += 1;
    b.tokenIds.push(it.tokenId);
    out.set(key, b);
  }
  return out;
}

export interface GridCell {
  year: number;
  month: number; // 0-based
  day: number;
  key: string; // "YYYY-MM-DD", matches dayKeyLocal
  inMonth: boolean;
}

/**
 * 6×7 month matrix, Monday-first, including leading/trailing spillover days
 * from adjacent months (flagged inMonth: false). `month` is 0-based (0 = Jan).
 */
export function monthGrid(year: number, month: number): GridCell[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // 0 = Monday
  const rows: GridCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: GridCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(year, month, 1 - offset + w * 7 + dow);
      row.push({
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        key: ymd(d.getFullYear(), d.getMonth(), d.getDate()),
        inMonth: d.getMonth() === month,
      });
    }
    rows.push(row);
  }
  return rows;
}

export interface YearMonth {
  year: number;
  month: number; // 0-based
}

/** First and last close-month across items (inclusive). Null when there are none. */
export function monthRange(
  items: DayItem[],
  dayKey: (tsSec: number) => string = dayKeyLocal,
): { min: YearMonth; max: YearMonth } | null {
  if (items.length === 0) return null;
  const nums = items.map((it) => {
    const [y, m] = dayKey(it.closedAt).slice(0, 7).split("-").map(Number);
    return y * 12 + (m - 1);
  });
  const toYM = (n: number): YearMonth => ({ year: Math.floor(n / 12), month: n % 12 });
  return { min: toYM(Math.min(...nums)), max: toYM(Math.max(...nums)) };
}
