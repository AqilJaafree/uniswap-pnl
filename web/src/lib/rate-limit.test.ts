import { rateLimitWaitMs, createRateLimitGate, DEFAULT_RATE_LIMIT_WAIT_MS } from "./rate-limit";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The exact shape viem produced when this killed a live scan. */
const viem429 = () => {
  const e = new Error("RPC Request failed.") as Error & { code: number; details: string };
  e.code = 429;
  e.details = "Rate Limit Hit, limit will reset in 60 seconds";
  return e;
};

// ---- detection ---------------------------------------------------------------
eq("the real 429 is recognised and its interval read", rateLimitWaitMs(viem429()), 60_000);
eq("a rate limit with no interval still waits", rateLimitWaitMs(new Error("Too Many Requests")), DEFAULT_RATE_LIMIT_WAIT_MS);
eq("and the default matches what this endpoint actually states", DEFAULT_RATE_LIMIT_WAIT_MS, 60_000);
eq("a 429 status field counts", rateLimitWaitMs({ status: 429, message: "nope" }), DEFAULT_RATE_LIMIT_WAIT_MS);
eq("minutes are understood", rateLimitWaitMs(new Error("rate limit, reset in 2 minutes")), 120_000);
eq("a non-rate-limit error is not ours", rateLimitWaitMs(new Error("invalid argument 0")), null);
eq("a dead backend is not a rate limit", rateLimitWaitMs(new Error("dial tcp: no route to host")), null);
// A stated zero would otherwise retry inside the same window and trip the limit again.
eq("a stated zero falls back to the default", rateLimitWaitMs(new Error("rate limit, reset in 0 seconds")), DEFAULT_RATE_LIMIT_WAIT_MS);

// ---- the gate ----------------------------------------------------------------
{
  let clock = 1000;
  const slept: number[] = [];
  const gate = createRateLimitGate({
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });

  eq("no pause means no waiting", (await gate.wait(), slept), []);
  gate.note(60_000);
  await gate.wait();
  eq("a noted limit is slept out once", slept, [60_000]);
  eq("and the clock has passed it", clock >= gate.resumeAt(), true);

  // The whole reason the gate is shared rather than per-request — and note the ORDER:
  // the long pause is reported FIRST, so a later, shorter one must not shorten it. A
  // second request tripping a 5s limit while a 60s one is running must not release
  // everybody after 5.
  slept.length = 0;
  gate.note(30_000);
  gate.note(10_000);
  await gate.wait();
  eq("a later shorter limit does not shorten the pause", slept.reduce((a, b) => a + b, 0), 30_000);
}

// ---- a pause extended mid-sleep is not woken early ---------------------------
{
  let clock = 0;
  const slept: number[] = [];
  let extended = false;
  const gate = createRateLimitGate({
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      // Another in-flight request trips the limit again while this one sleeps.
      if (!extended) { extended = true; gate.note(5_000); }
    },
  });
  gate.note(10_000);
  await gate.wait();
  eq("an extension during the sleep is also waited out", slept, [10_000, 5_000]);
}

// ---- a hostile interval cannot park the app ---------------------------------
{
  let clock = 0;
  const gate = createRateLimitGate({ now: () => clock, sleep: async (ms) => { clock += ms; }, maxWaitMs: 90_000 });
  gate.note(86_400_000);
  eq("an absurd interval is capped", gate.resumeAt(), 90_000);
}


// ---- adaptive fan-out: waiting alone does not clear a limit you keep exceeding ----
{
  const gate = createRateLimitGate({ now: () => 0, sleep: async () => {}, maxInflight: 8, recoverAfter: 3 });
  eq("starts at the full permit", gate.permitted(), 8);
  gate.note(60_000);
  eq("a 429 halves the permit", gate.permitted(), 4);
  gate.note(60_000);
  gate.note(60_000);
  eq("repeated 429s keep halving", gate.permitted(), 1);
  gate.note(60_000);
  eq("but never below one", gate.permitted(), 1);

  // Recovery is deliberately slow: re-opening on the first success would restore full
  // fan-out the instant the pause ends, which is exactly what re-tripped the limit.
  gate.noteSuccess(); gate.noteSuccess();
  eq("a couple of successes do not widen it", gate.permitted(), 1);
  gate.noteSuccess();
  eq("a run of successes widens it by one", gate.permitted(), 2);

  // A 429 in the middle of a recovery run must not be credited as progress.
  gate.noteSuccess(); gate.noteSuccess();
  gate.note(60_000);
  eq("a 429 resets the recovery streak", gate.permitted(), 1);
  gate.noteSuccess(); gate.noteSuccess();
  eq("and the part-finished streak did not carry over", gate.permitted(), 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
