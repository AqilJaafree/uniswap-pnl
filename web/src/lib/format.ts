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
