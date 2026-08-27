/**
 * Which positions the headline totals are not entitled to state confidently.
 *
 * `feesComplete` and `tickComplete` already reach the screen — as the "~ fees partial"
 * and "! price unverified" badges on a position CARD. What they never reached was the
 * SummaryBar, which sums exact and degraded positions into one figure and presents it
 * with no qualification whatsoever. A wallet reading "Fees earned: 0.42 Ξ" has no way to
 * know that two of its positions contributed a floor of zero because an archive read
 * failed, nor that the same scan run again would say something else.
 *
 * That is the same defect as a total that mixed ether with dollars: not an arithmetic
 * error, a reporting one. The sum is a fine sum; the claim made about it is too strong.
 *
 * Pure and separate from App.tsx so the decision can be tested — the rendering cannot be,
 * in this repo, and the decision is the part with rules in it.
 */

/** Only the three fields the decision reads. Keeps this testable without a whole PositionPnL. */
interface Flagged {
  tokenId: bigint;
  /** False when some fee segment could not be measured and is reported as a floor. */
  feesComplete: boolean;
  /** False when the price anchoring this position came from a fallback, not a read. */
  tickComplete: boolean;
}

export interface ProvisionalTotals {
  /** tokenIds whose fee figure is a floor rather than a measurement. */
  fees: string[];
  /** tokenIds whose price basis was never verified. */
  price: string[];
  /** True when the totals include anything from either list. */
  any: boolean;
}

/**
 * The two lists OVERLAP rather than partition: one failed archive read takes out both the
 * fee measurement and the tick, and a reader chasing a wrong fee figure should not have to
 * work out for themselves that the price is suspect too.
 *
 * Sorted numerically. Rendered into a sentence, so the order must not follow whatever
 * order `analyzeWallet`'s concurrent pool happened to resolve in — that would make one
 * wallet read differently on two scans, which is precisely the complaint this sits under.
 */
export function provisionalTotals(positions: readonly Flagged[]): ProvisionalTotals {
  const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  const ids = (pick: (p: Flagged) => boolean) =>
    positions.filter(pick).map((p) => p.tokenId).sort(byId).map(String);

  const fees = ids((p) => !p.feesComplete);
  const price = ids((p) => !p.tickComplete);
  return { fees, price, any: fees.length > 0 || price.length > 0 };
}
