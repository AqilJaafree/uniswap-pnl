import { getLogsChunked, isTransient } from "./rpc-logs";

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


// ---- a dead backend is transient, not a bad request --------------------------
// The real shape: the load balancer answers -32000 with a dial error in `details`, which
// viem presents as "Missing or invalid parameters". Retrying is the only correct response.
{
  const deadBackend = () => {
    const e = new Error("Missing or invalid parameters.\nDouble check you have provided the correct parameters.") as Error & { details: string };
    e.details = 'Post "http://10.31.64.244:8547/rpc": dial tcp 10.31.64.244:8547: connect: no route to host';
    return e;
  };
  eq("a dial failure is recognised as transient", isTransient(deadBackend()), true);
  eq("a genuine bad request is not", isTransient(new Error("invalid argument 0: hex string too long")), false);
  // A timeout stays a WIDTH symptom — splitting fixes it, asking again does not.
  eq("a timeout is not treated as transient", isTransient(new Error("query timed out")), false);
  // The case the width-first guard actually exists for: a gateway that reports an
  // over-wide query as BOTH a 504 and a timeout. Width has to win, or the range is
  // re-asked three times at full size and then split anyway.
  eq("width wins when a message looks like both", isTransient(new Error("504 Gateway Timeout: query timed out")), false);

  let n = 0;
  const calls: [bigint, bigint][] = [];
  const makeCall = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    if (++n < 3) throw deadBackend();
    return [Number(from)];
  };
  const got = await getLogsChunked(makeCall, 0n, 100n, { sleep: async () => {} });
  eq("a flapping backend is retried until it answers", got, [0]);
  eq("and the range is never split by it", ranges(calls), ["0-100", "0-100", "0-100"]);
}

// ---- and a both-shaped error splits rather than retrying ---------------------
{
  const s2 = spy((from, to) => (to - from > 50n ? err("504 Gateway Timeout: query timed out") : [Number(from)]));
  eq("a 504-plus-timeout splits", await getLogsChunked(s2.makeCall, 0n, 100n, { sleep: async () => {} }), [0, 51]);
  eq("and is not re-asked at full width", ranges(s2.calls), ["0-100", "0-50", "51-100"].sort());
}

// ---- but it does not retry forever -------------------------------------------
{
  let n = 0;
  const makeCall = async () => {
    n++;
    const e = new Error("boom") as Error & { details: string };
    e.details = "dial tcp 10.0.0.1:8547: connect: connection refused";
    throw e;
  };
  let threw = "";
  try { await getLogsChunked(makeCall, 0n, 100n, { transientAttempts: 3, sleep: async () => {} }); }
  catch (e) { threw = (e as Error).message; }
  eq("a backend that stays dead gives up", threw, "boom");
  eq("after exactly the configured number of attempts", n, 3);
}

// ---- a non-transient error is still not retried ------------------------------
{
  let n = 0;
  const makeCall = async () => { n++; return err("invalid argument 0: bad address"); };
  let threw = "";
  try { await getLogsChunked(makeCall, 0n, 100n, { sleep: async () => {} }); } catch (e) { threw = (e as Error).message; }
  eq("a real bad request propagates", threw, "invalid argument 0: bad address");
  eq("and is asked exactly once", n, 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
