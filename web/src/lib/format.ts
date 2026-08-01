export const shortId = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export const fmtUsd = (n: number) => {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}$${s}`;
};

export const signUsd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Value in the numeraire token (e.g. Ξ). Adaptive precision for small amounts. */
export const fmtUnit = (n: number, sym: string) => {
  const a = Math.abs(n);
  const dp = a === 0 ? 2 : a < 0.001 ? 6 : a < 1 ? 5 : a < 1000 ? 4 : 2;
  const glyph = sym === "WETH" ? "Ξ" : "";
  return `${n < 0 ? "−" : ""}${glyph}${a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}${glyph ? "" : " " + sym}`;
};
export const signUnit = (n: number, sym: string) => (n >= 0 ? "+" : "−") + fmtUnit(Math.abs(n), sym).replace("−", "");

/** Token quantity — compact for big, precise for small. */
export const fmtToken = (n: number, sym: string) => {
  const a = Math.abs(n);
  let s: string;
  if (a === 0) s = "0";
  else if (a >= 1e6) s = a.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  else if (a >= 1) s = a.toLocaleString("en-US", { maximumFractionDigits: 4 });
  else s = a.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${s} ${sym}`;
};

export const fmtPct = (frac: number) => `${frac >= 0 ? "+" : "−"}${Math.abs(frac * 100).toFixed(2)}%`;

/**
 * USD notional, abbreviated — for axis ticks and volume figures, where the
 * magnitude is the message and cents are noise.
 *
 * Follows the display pipeline: invalid → "--", exact zero → "$0.00", rounds-to-
 * zero-but-isn't → "<$0.01", then K/M/B/T. Never scientific notation, never a
 * truncating ellipsis. `fmtUsd` stays the right call for exact amounts.
 */
export const fmtUsdCompact = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "--";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a === 0) return "$0.00";
  if (a < 0.005) return `${sign}<$0.01`;
  if (a < 1000) return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const [unit, div] of [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    if (a >= div) {
      const v = a / div;
      // Keep three significant digits across the decade so 1.24M and 999K read alike.
      return `${sign}$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 })}${unit}`;
    }
  }
  return `${sign}$${a.toFixed(2)}`;
};
