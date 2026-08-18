import { mapPool } from "./pool";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- results keep the INPUT order, not the completion order -------------------
{
  const got = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    // Reverse the finishing order relative to the input.
    for (let i = 0; i < (6 - n); i++) await tick();
    return n * 10;
  });
  eq("order follows the input, not completion", got, [10, 20, 30, 40, 50]);
}

// ---- the limit is actually enforced ------------------------------------------
{
  let inflight = 0, peak = 0;
  await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    inflight++; peak = Math.max(peak, inflight);
    await tick(); await tick();
    inflight--;
  });
  eq("never exceeds the limit", peak <= 3, true);
  eq("actually reaches the limit", peak, 3);
}

// ---- every item runs exactly once ---------------------------------------------
{
  const seen: number[] = [];
  await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { seen.push(n); });
  eq("every item runs once", seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
}

// ---- edges --------------------------------------------------------------------
{
  eq("empty input", await mapPool([], 4, async () => 1), []);
  // More slots than items must not spawn idle workers that hang the Promise.all.
  eq("limit above length", await mapPool([1, 2], 10, async (n) => n), [1, 2]);
  eq("limit of one is sequential", await mapPool([1, 2, 3], 1, async (n) => n), [1, 2, 3]);
  let threw = "";
  try { await mapPool([1], 0, async (n) => n); } catch (e) { threw = (e as Error).message; }
  eq("a zero limit is refused, not a silent hang", threw, "pool limit must be at least 1");
}

// A rejecting job must propagate — analyzeWallet relies on catching per position, so a
// swallowed failure would silently drop a position from the totals instead of listing it
// as skipped.
{
  let threw = "";
  try {
    await mapPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("boom"); return n; });
  } catch (e) { threw = (e as Error).message; }
  eq("a failing job propagates", threw, "boom");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
