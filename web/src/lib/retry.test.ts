/**
 * `retry` exists for TRANSIENT failures — a 500 from an overloaded explorer, a dropped
 * connection, a CORS-less response. Not every failure is one.
 *
 * Blockscout answering "this tx's trace is not indexed" is a fact about its index, not a
 * hiccup: it can change, but on the scale of minutes, not the 300/600/900 ms this backs
 * off for. Retrying it spends three requests to learn the same thing three times — and
 * each one is a 200, so `fetchTraceCalls` counts it toward WIDENING the explorer's rate
 * budget. That is the wrong direction to push an explorer that is already behind.
 */
import { retry } from "./chain";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

class Permanent extends Error {}

// ── a transient failure is retried ───────────────────────────────────────
{
  let calls = 0;
  const got = await retry(async () => { if (++calls < 3) throw new Error("500"); return "ok"; });
  eq("a transient failure is retried to success", got, "ok");
  eq("and it took every attempt it needed", calls, 3);
}

// ── an unretryable one is asked exactly once ─────────────────────────────
{
  let calls = 0;
  let threw = "";
  try {
    await retry(async () => { calls++; throw new Permanent("not indexed"); }, 3, (e) => !(e instanceof Permanent));
  } catch (e) { threw = (e as Error).message; }
  eq("an unretryable failure is asked once", calls, 1);
  eq("and it still surfaces to the caller", threw, "not indexed");
}

// ── the predicate defaults to retrying everything ────────────────────────
{
  let calls = 0;
  try { await retry(async () => { calls++; throw new Permanent("x"); }); } catch { /* expected */ }
  eq("without a predicate nothing changes", calls, 3);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
