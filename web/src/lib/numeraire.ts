/**
 * Numeraire selection for a pool pair. The PnL engine prices the "anchor" leg at
 * 1, so its USD/ETH-labelled figures are really *anchor-unit* figures. USDG pairs
 * anchor on the dollar (values already USD); ETH pairs anchor on ETH (UI ×ethUsd).
 */
import { getAddress } from "viem";
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

// re-export so callers don't need viem directly
export { getAddress };
