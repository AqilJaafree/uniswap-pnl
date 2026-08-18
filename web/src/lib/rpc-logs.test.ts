import { getLogsChunked } from "./rpc-logs";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** Record every range the chunker asks for, so splitting behaviour is observable. */
function spy(handler: (from: bigint, to: bigint) => number[]) {
  const calls: [bigint, bigint][] = [];
  const makeCall = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    return handler(from, to);
  };
  return { calls, makeCall };
}

const err = (msg: string) => { throw new Error(msg); };
const ranges = (calls: [bigint, bigint][]) => calls.map(([a, b]) => `${a}-${b}`).sort();

// ---- happy path: one call, no splitting -------------------------------------
{
  const s = spy(() => [1, 2, 3]);
  eq("single call returns logs", await getLogsChunked(s.makeCall, 0n, 100n), [1, 2, 3]);
  eq("single call makes exactly one request", s.calls.length, 1);
  eq("single call uses the full range", ranges(s.calls), ["0-100"]);
}

// ---- the result-count cap splits the range and concatenates ------------------
{
  // Fails only on the full range; each half succeeds.
  const s = spy((from, to) => (to - from > 50n ? err("query returned more than 10000 results") : [Number(from)]));
  eq("cap splits into two halves", await getLogsChunked(s.makeCall, 0n, 100n), [0, 51]);
  eq("cap: halves cover the range exactly", ranges(s.calls), ["0-100", "0-50", "51-100"].sort());
}

// ---- a timeout is treated as the same symptom --------------------------------
{
  const s = spy((from, to) => (to - from > 50n ? err("request timed out") : [Number(from)]));
  eq("timeout also splits", await getLogsChunked(s.makeCall, 0n, 100n), [0, 51]);
}

// viem surfaces the upstream text on `details`, not `message`.
{
  const s = spy((from, to) => {
    if (to - from > 50n) throw Object.assign(new Error("HTTP request failed"), { details: "logs matched exceeds limit of 10000" });
    return [Number(from)];
  });
  eq("splits on viem's `details` field", await getLogsChunked(s.makeCall, 0n, 100n), [0, 51]);
}

// ---- recursion continues until each slice fits -------------------------------
{
  const s = spy((from, to) => (to - from > 10n ? err("exceeds limit") : [Number(to - from)]));
  const got = await getLogsChunked(s.makeCall, 0n, 100n);
  eq("recurses until every slice fits", got.every((w) => w <= 10), true);
  eq("recursion preserves ascending block order", got.length > 1 && s.calls.length > 3, true);
}

// ---- unrelated errors must NOT be retried by halving -------------------------
{
  const s = spy(() => err("invalid address"));
  let threw = "";
  try { await getLogsChunked(s.makeCall, 0n, 100n); } catch (e) { threw = (e as Error).message; }
  eq("unrelated error propagates", threw, "invalid address");
  eq("unrelated error is not split", s.calls.length, 1);
}

// ---- a single block cannot be halved: give up rather than loop forever -------
{
  const s = spy(() => err("exceeds limit"));
  let threw = "";
  try { await getLogsChunked(s.makeCall, 7n, 7n); } catch (e) { threw = (e as Error).message; }
  eq("single block stops recursing", threw, "exceeds limit");
  eq("single block tried once", s.calls.length, 1);
}

// A 2-block range splits once, then each single block gives up — bounded, not infinite.
{
  const s = spy(() => err("exceeds limit"));
  let threw = "";
  try { await getLogsChunked(s.makeCall, 10n, 11n); } catch (e) { threw = (e as Error).message; }
  eq("two-block range terminates", threw, "exceeds limit");
  eq("two-block range splits exactly once", ranges(s.calls), ["10-10", "10-11", "11-11"].sort());
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
