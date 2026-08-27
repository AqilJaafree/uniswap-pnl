import { provisionalTotals } from "./provisional";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const pos = (tokenId: bigint, feesComplete = true, tickComplete = true) => ({ tokenId, feesComplete, tickComplete });

// ---- the ordinary case --------------------------------------------------------
{
  const p = provisionalTotals([pos(1n), pos(2n)]);
  eq("nothing provisional when every position is exact", p, { fees: [], price: [], any: false });
}

// ---- what the summary bar was hiding ------------------------------------------
{
  // These flags already render as badges on the position CARD ("~ fees partial",
  // "! price unverified"). The bar summed the same positions into one confident number
  // with no badge at all, which is how a wallet reads a headline it has no reason to
  // doubt. Same class as the totals that mixed ether with dollars.
  const p = provisionalTotals([pos(1n), pos(2n, false), pos(3n, true, false)]);
  eq("a position with partial fees is named", p.fees, ["2"]);
  eq("a position with an unverified price is named", p.price, ["3"]);
  eq("either one makes the totals provisional", p.any, true);
}

// ---- one position can be both --------------------------------------------------
{
  // A failed archive read takes out the fee measurement AND the tick in the same breath,
  // so the two lists overlap rather than partition. Both must name it: the fee figure and
  // the price figure are separately wrong, and a reader chasing one should not have to
  // infer the other.
  const p = provisionalTotals([pos(7n, false, false)]);
  eq("a doubly-degraded position appears in both lists", { fees: p.fees, price: p.price }, { fees: ["7"], price: ["7"] });
}

// ---- ids are stable and ordered -------------------------------------------------
{
  // Rendered into a sentence, so the order must not depend on Map iteration or on the
  // order analyzeWallet's concurrent pool happened to resolve in — that would make the
  // same wallet read differently on two scans, which is the whole bug this sits under.
  const p = provisionalTotals([pos(30n, false), pos(4n, false), pos(100n, false)]);
  eq("ids are sorted numerically, not as strings", p.fees, ["4", "30", "100"]);
}

// ---- empty ----------------------------------------------------------------------
{
  eq("an empty wallet is not provisional", provisionalTotals([]), { fees: [], price: [], any: false });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
