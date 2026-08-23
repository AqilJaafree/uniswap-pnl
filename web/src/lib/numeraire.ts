/**
 * Numeraire selection for a pool pair. The PnL engine prices the "anchor" leg at
 * 1, so its USD/ETH-labelled figures are really *anchor-unit* figures. USDG pairs
 * anchor on the dollar (values already USD); ETH pairs anchor on ETH (UI ×ethUsd).
 */
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

export type NumeraireKind = "eth" | "usd";
export interface Numeraire {
  kind: NumeraireKind;
  anchorIsToken0: boolean;
  symbol: string; // "USD" for usd; "WETH" for eth (drives the Ξ glyph in format.ts)
}

const norm = (a: string) => a.toLowerCase();
const USDG = norm(ROBINHOOD_CHAIN.tokens.USDG);
const ETHSET = new Set([norm(ROBINHOOD_CHAIN.tokens.WETH), norm(ROBINHOOD_CHAIN.tokens.NATIVE_ETH)]);

/** Choose the value unit for a pair. USDG (USD) beats ETH. null = unsupported pair. */
export function pickNumeraire(token0: string, token1: string, _sym0: string, _sym1: string): Numeraire | null {
  const t0 = norm(token0), t1 = norm(token1);
  if (t0 === USDG || t1 === USDG) return { kind: "usd", anchorIsToken0: t0 === USDG, symbol: "USD" };
  if (ETHSET.has(t0) || ETHSET.has(t1)) return { kind: "eth", anchorIsToken0: ETHSET.has(t0), symbol: "WETH" };
  return null;
}

/** PricePoint (USD/anchor-unit of each whole token) given token1-per-token0 price. */
export function numerairePricePoint(priceT1perT0: number, anchorIsToken0: boolean): { p0: number; p1: number } {
  return anchorIsToken0 ? { p0: 1, p1: 1 / priceT1perT0 } : { p0: priceT1perT0, p1: 1 };
}

/** Convert an anchor-unit value to USD. usd → identity; eth → ×ethUsd (falls back to value when ethUsd null). */
export function toUsd(valueInNumeraire: number, kind: NumeraireKind, ethUsd: number | null): number {
  if (kind === "usd") return valueInNumeraire;
  return ethUsd == null ? valueInNumeraire : valueInNumeraire * ethUsd;
}

/**
 * A position's value (in its own numeraire) expressed in a chosen DISPLAY unit,
 * using an ETH/USD rate that is always available (decoupled from the display
 * toggle). This makes the ETH and USD views mutually consistent — the ETH view
 * is exactly the USD view divided by the rate — and lets a MIXED wallet (WETH-
 * and USDG-quoted positions) aggregate coherently in either unit:
 *   • usd display → the position's USD value (eth×rate, usd as-is)
 *   • eth display → that USD value ÷ rate, so USDG positions convert to Ξ too
 * A non-positive rate can't define an ETH view, so it falls back to the ETH-
 * native value (0 for a USD position) instead of dividing by zero.
 */
export function displayValue(
  valueInNumeraire: number,
  kind: NumeraireKind,
  ethUsd: number,
  unit: "eth" | "usd",
): number {
  const usd = toUsd(valueInNumeraire, kind, ethUsd);
  if (unit === "usd") return usd;
  if (ethUsd > 0) return usd / ethUsd;
  return kind === "eth" ? valueInNumeraire : 0; // no rate → can't price USD in Ξ
}

/**
 * A position's pre-gas net (in its own numeraire) minus native ETH gas, both
 * expressed in the chosen display unit via the shared rate. Gas is denominated in
 * ETH regardless of the pair, so a USD-numeraire (USDG) position's gas is priced
 * through the rate here instead of being dropped to 0 for want of a WETH leg.
 */
export function netAfterGas(
  netInNumeraire: number,
  kind: NumeraireKind,
  gasEth: number,
  ethUsd: number,
  unit: "eth" | "usd",
): number {
  return displayValue(netInNumeraire, kind, ethUsd, unit) - displayValue(gasEth, "eth", ethUsd, unit);
}

/**
 * Native gas (already in whole ETH) expressed in the pair's numeraire unit.
 * ETH-numeraire pairs keep it as ETH; USD-numeraire pairs convert via the pool's
 * WETH leg price (`priceT1perT0`) — the only archive-free ETH/USD source we have.
 * Returns 0 for a USD pair with no WETH leg (gas can't be priced, and ETH-as-USD
 * would be a unit error).
 */
export function gasInNumeraire(
  gasEth: number,
  num: Numeraire,
  token0: string,
  token1: string,
  priceT1perT0: number,
): number {
  if (num.kind === "eth") return gasEth; // result already denominated in ETH
  const pp = numerairePricePoint(priceT1perT0, num.anchorIsToken0); // p0/p1 = USD per whole token
  const ethUsd = ETHSET.has(norm(token0)) ? pp.p0 : ETHSET.has(norm(token1)) ? pp.p1 : null;
  return ethUsd == null ? 0 : gasEth * ethUsd;
}


/** One numeraire's slice of a portfolio. Values are in that numeraire's unit. */
export interface NumeraireBucket { net: number; fees: number; il: number; count: number }

/**
 * A portfolio's totals, split by the unit they are actually denominated in, plus gas.
 *
 * `gas` and `count` are unambiguous — gas is native ETH whatever the pair quotes in, and
 * a position is a position.
 */
export interface PortfolioTotals {
  eth: NumeraireBucket; // WETH/native-quoted positions, in Ξ
  usd: NumeraireBucket; // USDG-quoted positions, in dollars
  gas: number;          // native ETH across every position, in Ξ
  count: number;        // positions read
}

/** The fields of a position that a total is made of — structural, so `PositionPnL` fits. */
export interface TotalsInput {
  numeraireKind: NumeraireKind;
  gasEth: number;
  result: { netPnlUsd: number; feesUsd: number; ilUsd: number };
}

/**
 * Sum a portfolio WITHOUT mixing units.
 *
 * `netPnlUsd` and friends are anchor-unit, not dollars: ether for a WETH pair, dollars
 * for a USDG one (see `pickNumeraire`). Adding them across a mixed wallet yields a number
 * in no unit at all — 0x7e99…A2C once read "net=120.86", which was ~dollars from its USDG
 * positions with a little ether stirred in.
 *
 * Converting here instead would need an ETH/USD rate, and baking one into the portfolio
 * puts a second, staler source of truth beside the live rate the UI already prices with.
 * So the buckets stay separate and a caller wanting ONE number supplies the rate itself —
 * which is exactly what `SummaryBar` does, per position, via `displayValue`/`netAfterGas`.
 */
export function totalsByNumeraire(positions: readonly TotalsInput[]): PortfolioTotals {
  const bucket = (): NumeraireBucket => ({ net: 0, fees: 0, il: 0, count: 0 });
  const t: PortfolioTotals = { eth: bucket(), usd: bucket(), gas: 0, count: positions.length };
  for (const p of positions) {
    const b = p.numeraireKind === "usd" ? t.usd : t.eth;
    b.net += p.result.netPnlUsd;
    b.fees += p.result.feesUsd;
    b.il += p.result.ilUsd;
    b.count++;
    t.gas += p.gasEth;
  }
  return t;
}
