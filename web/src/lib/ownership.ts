/**
 * Which blocks a given wallet actually held a position NFT.
 *
 * Both `analyzeWallet` paths enumerate positions by the ERC-721 `Transfer(to: wallet)`
 * log, which finds every NFT the wallet ever *received* — including ones it has since
 * handed to someone else. The lifecycle events, though, are keyed by tokenId alone
 * (v3) or by poolId+salt (v4), so they describe the position, not the holder. Left
 * unjoined, a wallet that sold a position keeps accruing the buyer's deposits and
 * withdrawals as if they were its own.
 *
 * Joining the two on block number is what makes a wallet's PnL its own: only events
 * inside a hold window are that wallet's cashflows.
 *
 * Pure and chain-free so it can be unit-tested — see ownership.test.ts.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const norm = (a: string) => a.toLowerCase();

export interface NftTransfer {
  blockNumber: bigint;
  logIndex: number;
  from: string;
  to: string;
}

/** A span the wallet held the NFT. `to === null` means it still holds it. */
export interface HoldWindow {
  from: bigint;
  to: bigint | null;
}

export interface Ownership {
  windows: HoldWindow[];
  /** The wallet holds the NFT at chain head. */
  heldNow: boolean;
  /**
   * Block where the wallet handed the NFT to ANOTHER address, if that is how its
   * tenure ended. A burn (transfer to the zero address) is an ordinary close, not a
   * sale, so it leaves this null — the difference decides whether a position is still
   * markable to market or has to stop at what the wallet actually realized.
   */
  soldAt: bigint | null;
}

/** Reconstruct a wallet's tenure from a token's full Transfer log. */
export function ownershipOf(transfers: NftTransfer[], owner: string): Ownership {
  const me = norm(owner);
  const sorted = [...transfers].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );

  const windows: HoldWindow[] = [];
  let open: HoldWindow | null = null;
  let soldAt: bigint | null = null;

  for (const t of sorted) {
    if (norm(t.to) === me) {
      // Re-acquiring clears any earlier sale: the wallet is on the hook for this
      // position again, and its current tenure is what the caller cares about.
      if (!open) { open = { from: t.blockNumber, to: null }; windows.push(open); soldAt = null; }
    } else if (norm(t.from) === me && open) {
      open.to = t.blockNumber;
      soldAt = norm(t.to) === ZERO ? null : t.blockNumber;
      open = null;
    }
  }

  return { windows, heldNow: open !== null, soldAt };
}

/**
 * Did the wallet hold the NFT at `block`?
 *
 * Both bounds are INCLUSIVE, and that is load-bearing rather than a rounding choice.
 * A mint emits the `Transfer(0 → wallet)` and the liquidity event in the same
 * transaction, so an exclusive lower bound would drop every position's own deposit;
 * a close emits the burn alongside the final decrease/collect, so an exclusive upper
 * bound would drop the withdrawal that ends it. Erring inward loses real cashflows;
 * erring outward can only pick up a counterparty acting in the very same block.
 */
export function heldAt(o: Ownership, block: bigint): boolean {
  return o.windows.some((w) => w.from <= block && (w.to === null || block <= w.to));
}
