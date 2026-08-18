import { ownershipOf, heldAt, type NftTransfer } from "./ownership";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? String(v) : v))
    === JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  ok ? pass++ : fail++;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const ME = "0x7e995decc404633CF2889968537D723c55ffEA2C";
const BUYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const t = (blockNumber: bigint, from: string, to: string, logIndex = 0): NftTransfer =>
  ({ blockNumber, logIndex, from, to });

// ---- still held: mint, never moved -------------------------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME)], ME);
  eq("mint opens an unbounded window", o.windows, [{ from: 100n, to: null }]);
  eq("mint means held now", o.heldNow, true);
  eq("mint is not a sale", o.soldAt, null);
  eq("holds at the mint block itself", heldAt(o, 100n), true);
  eq("holds long after", heldAt(o, 999_999n), true);
  eq("does not hold before minting", heldAt(o, 99n), false);
}

// ---- burned: an ordinary close, NOT a sale -----------------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME), t(500n, ME, ZERO)], ME);
  eq("burn closes the window", o.windows, [{ from: 100n, to: 500n }]);
  eq("burn means not held now", o.heldNow, false);
  eq("burn is not a sale", o.soldAt, null);
  // The final decrease/collect share the burn's block — they must stay the wallet's.
  eq("holds at the burn block (inclusive)", heldAt(o, 500n), true);
  eq("does not hold after the burn", heldAt(o, 501n), false);
}

// ---- sold: tenure ends, and it is flagged as a sale ---------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME), t(500n, ME, BUYER)], ME);
  eq("sale closes the window", o.windows, [{ from: 100n, to: 500n }]);
  eq("sale means not held now", o.heldNow, false);
  eq("sale records the block", o.soldAt, 500n);
  eq("holds at the sale block (inclusive)", heldAt(o, 500n), true);
  eq("buyer's later activity is not ours", heldAt(o, 600n), false);
}

// ---- the buyer's own view of the same token -----------------------------------
{
  const log = [t(100n, ZERO, ME), t(500n, ME, BUYER)];
  const o = ownershipOf(log, BUYER);
  eq("buyer's window starts at the purchase", o.windows, [{ from: 500n, to: null }]);
  eq("buyer holds now", o.heldNow, true);
  eq("buyer did not own the mint", heldAt(o, 100n), false);
  eq("buyer owns later activity", heldAt(o, 600n), true);
}

// ---- re-acquired: two windows, and the sale flag is cleared -------------------
{
  const o = ownershipOf([t(100n, ZERO, ME), t(200n, ME, BUYER), t(300n, BUYER, ME)], ME);
  eq("re-acquire yields two windows", o.windows, [{ from: 100n, to: 200n }, { from: 300n, to: null }]);
  eq("re-acquire means held now", o.heldNow, true);
  eq("re-acquire clears the sale", o.soldAt, null);
  eq("holds in the first window", heldAt(o, 150n), true);
  eq("gap between windows is not ours", heldAt(o, 250n), false);
  eq("holds in the second window", heldAt(o, 400n), true);
}

// ---- sold again after re-acquiring --------------------------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME), t(200n, ME, BUYER), t(300n, BUYER, ME), t(400n, ME, OTHER)], ME);
  eq("second sale is the recorded one", o.soldAt, 400n);
  eq("not held after the second sale", o.heldNow, false);
}

// ---- a wallet that never touched the token ------------------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME), t(500n, ME, BUYER)], OTHER);
  eq("stranger has no windows", o.windows, []);
  eq("stranger holds nothing", o.heldNow, false);
  eq("stranger never held", heldAt(o, 300n), false);
}

// ---- address comparison is case-insensitive -----------------------------------
{
  const o = ownershipOf([t(100n, ZERO, ME.toLowerCase())], ME.toUpperCase());
  eq("checksum casing does not matter", o.heldNow, true);
}

// ---- ordering: input order must not matter ------------------------------------
{
  const shuffled = [t(300n, BUYER, ME), t(100n, ZERO, ME), t(200n, ME, BUYER)];
  const o = ownershipOf(shuffled, ME);
  eq("out-of-order input is sorted", o.windows, [{ from: 100n, to: 200n }, { from: 300n, to: null }]);
}

// Same block, different logIndex — sorting must fall through to logIndex, or a
// flip-then-return inside one block would read as still-held.
{
  const o = ownershipOf([t(100n, ZERO, ME, 0), t(100n, ME, BUYER, 1)], ME);
  eq("same-block transfers order by logIndex", o.windows, [{ from: 100n, to: 100n }]);
  eq("same-block sale is not held now", o.heldNow, false);
  eq("same-block sale is flagged", o.soldAt, 100n);
}

// ---- empty log: caller must be able to detect "unknown" and not truncate ------
{
  const o = ownershipOf([], ME);
  eq("no transfers = no windows", o.windows, []);
  eq("no transfers = not held", o.heldNow, false);
  eq("no transfers = no sale", o.soldAt, null);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
