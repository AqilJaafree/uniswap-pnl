import { getLogsChunked, isTransient, suggestedSplit, isPruned, findLogFloor, getLogsFromGenesis } from "./rpc-logs";

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


// ---- a rate limit must never be mistaken for an over-wide query --------------
// TOO_WIDE matches "too many", and the rate-limited refusal is "too many requests".
// Splitting there would answer "stop" with two queries, then four.
{
  const s3 = spy(() => err("too many requests"));
  let threw = "";
  try { await getLogsChunked(s3.makeCall, 0n, 100n, { sleep: async () => {} }); } catch (e) { threw = (e as Error).message; }
  eq("a 429-shaped refusal propagates", threw, "too many requests");
  eq("and the range is not split", ranges(s3.calls), ["0-100"]);
}


// ── the two nodes word an over-wide query differently ───────────────────
//
// This is the regression that made 63 v4 positions unreadable in one wallet. The pattern
// was written against the public node; once wallet-lane eth_getLogs went to Alchemy, its
// wording matched nothing, the range was never split, and every v4 position — which needs
// a pool-wide ModifyLiquidity query over its whole life — failed.
{
  // Verbatim, from the live endpoint.
  const ALCHEMY = "Log response size exceeded. You can make eth_getLogs requests with up to a "
    + "10,000 block range and no limit on the response size, or you can request any block range "
    + "with a cap of 10K logs in the response. Based on your parameters and the response size "
    + "limit, this block range should work: [0xa98d94, 0x19c7db9]";
  const PUBLIC = "logs matched by query exceeds limit of 10000";

  let calls = 0;
  const splitsOn = async (msg: string) => {
    calls = 0;
    const out = await getLogsChunked(async (f, t) => {
      calls++;
      // Refuse anything wider than 1000 blocks, as a capped node would.
      if (t - f > 1000n) throw new Error(msg);
      return [Number(f)];
    }, 0n, 4000n, { sleep: async () => {} });
    return out.length;
  };

  eq("the public node's wording splits", await splitsOn(PUBLIC) > 0, true);
  eq("and so does Alchemy's", await splitsOn(ALCHEMY) > 0, true);

  // A rate limit must still NOT be split — halving a 429 doubles the load on an endpoint
  // that just said stop.
  let rlCalls = 0;
  let threw = false;
  try {
    await getLogsChunked(async () => { rlCalls++; throw new Error("429 Rate Limit Hit, limit will reset in 60 seconds"); },
      0n, 4000n, { sleep: async () => {} });
  } catch { threw = true; }
  eq("a rate limit propagates instead of splitting", threw, true);
  eq("and is not multiplied into more queries", rlCalls <= 3, true);
}

// ── Alchemy names a range that would work; use it ───────────────────────
{
  const hint = "…this block range should work: [0xa98d94, 0x19c7db9]";
  eq("the suggested upper bound is taken", String(suggestedSplit(hint, 0xa98d94n, 0x28f6dden)), String(0x19c7db9n));
  // Only when it starts where we asked: a hint for a different range is not ours.
  eq("a hint starting elsewhere is ignored", suggestedSplit(hint, 0n, 0x28f6dden), null);
  // And only when it lands strictly inside — otherwise it is not a split at all and the
  // recursion would not converge.
  eq("a hint at or past our own end is ignored", suggestedSplit(hint, 0xa98d94n, 0x19c7db9n), null);
  eq("no hint at all falls back to halving", suggestedSplit("plain width error", 0n, 100n), null);

  // Infura words both the refusal and the hint differently. Same treatment.
  const infura = "query returned more than 10000 results. Try with this block range [0x0, 0x64].";
  eq("infura's hint parses too", String(suggestedSplit(infura, 0n, 1000n)), String(0x64n));
}

// ── the width figure in the message is NOT stable; the phrase is ────────
//
// Alchemy's own documented example of this error says "2K block range" where the endpoint
// this app talks to says "10,000". Matching the number would work on one and not the
// other, which is the exact shape of the bug this file now guards.
{
  const twoK = "Log response size exceeded. You can make eth_getLogs requests with up to a "
    + "2K block range and no limit on the response size, or you can request any block range "
    + "with a cap of 10K logs in the response. Based on your parameters and the response size "
    + "limit, this block range should work: [0x0, 0xd043b8]";
  let split = 0;
  const out = await getLogsChunked(async (f, t) => {
    split++;
    if (t - f > 100n) throw new Error(twoK);
    return [Number(f)];
  }, 0n, 400n, { sleep: async () => {} });
  eq("the documented 2K wording splits as well", out.length > 0, true);
  eq("and it took more than one call to get there", split > 1, true);
}

// ── a retention refusal is its own category, not a width one ─────────────
{
  eq("Blockdaemon's Arc wording is pruned", isPruned(new Error("pruned history unavailable")), true);
  eq("a generic 'history unavailable' phrasing is pruned too", isPruned({ details: "history unavailable for this range" }), true);
  eq("a width complaint is NOT pruned", isPruned(new Error("query returned more than 10000 results")), false);
  eq("a rate limit is NOT pruned", isPruned(new Error("rate limit exceeded")), false);
}

// ── getLogsChunked must NEVER blind-bisect a retention refusal ───────────
//
// The whole reason PRUNED is split out from TOO_WIDE: folding it in would recurse a
// genesis-to-head query toward single-block chunks across the entire unreadable history.
// This asserts the boundary holds — a pruned error propagates on the first try, exactly
// like any other non-width error.
{
  let calls = 0;
  const e = await getLogsChunked(async () => { calls++; throw new Error("pruned history unavailable"); }, 0n, 21_000_000n, { sleep: async () => {} })
    .then(() => null, (err) => err as Error);
  eq("a pruned error propagates rather than being retried", e?.message, "pruned history unavailable");
  eq("and it is asked exactly once, not halved", calls, 1);
}

// ── findLogFloor: binary search for the retention boundary ───────────────
{
  const FLOOR = 500_000n;
  let probes = 0;
  const probe = async (from: bigint) => { probes++; return from >= FLOOR; };
  const found = await findLogFloor(probe, 0n, 21_000_000n, 1n);
  eq("floor is found within tolerance", found >= FLOOR && found < FLOOR + 200n, true);
  eq("logarithmically few probes, not a linear scan", probes < 40, true);

  const noPruning = await findLogFloor(async () => true, 0n, 1000n, 1n);
  eq("no pruning at all converges to the low end", noPruning < 200n, true);
}

// ── getLogsFromGenesis: honest genesis reads survive a real retention wall ─
{
  // No pruning at all: behaves exactly like getLogsChunked, no floor search paid for.
  {
    let calls = 0;
    const r = await getLogsFromGenesis(async (f, t) => { calls++; return [Number(f), Number(t)]; }, 1000n);
    eq("unpruned: logs come back", r.logs, [0, 1000]);
    eq("unpruned: truncatedAt is null", r.truncatedAt, null);
    eq("unpruned: exactly one call, no floor search", calls, 1);
  }

  // A real retention wall: the true match sits AFTER the floor, so it is still found.
  {
    const FLOOR = 500_000n;
    const HEAD = 21_000_000n;
    const MATCH_AT = 600_000n;
    const makeCall = async (f: bigint, t: bigint) => {
      if (f < FLOOR) throw new Error("pruned history unavailable");
      return f <= MATCH_AT && MATCH_AT <= t ? [Number(MATCH_AT)] : [];
    };
    const r = await getLogsFromGenesis(makeCall, HEAD, { probeWidth: 100n });
    eq("the match past the floor is still found", r.logs, [Number(MATCH_AT)]);
    eq("truncatedAt is set — the caller must not trust silence before it", r.truncatedAt !== null, true);
    eq("truncatedAt sits at or after the true floor", r.truncatedAt! >= FLOOR, true);
  }

  // The true match predates the floor entirely: an honest "unknown," not a false "empty."
  {
    const FLOOR = 500_000n;
    const HEAD = 21_000_000n;
    const makeCall = async (f: bigint, t: bigint) => {
      if (f < FLOOR) throw new Error("pruned history unavailable");
      return []; // the real match is somewhere below FLOOR — unreachable, never "found empty"
    };
    const r = await getLogsFromGenesis(makeCall, HEAD, { probeWidth: 100n });
    eq("nothing found within the readable window", r.logs, []);
    eq("but truncatedAt says so — this must not be read as 'never existed'", r.truncatedAt !== null, true);
  }

  // A non-pruning error must still propagate untouched.
  {
    const e = await getLogsFromGenesis(async () => { throw new Error("execution reverted"); }, 1000n)
      .then(() => null, (err) => err as Error);
    eq("a non-pruning error is not mistaken for retention", e?.message, "execution reverted");
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
