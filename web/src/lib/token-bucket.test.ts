/**
 * The rate budget, driven by a fake clock so the assertions cost no wall time.
 *
 * The property that matters most is the last group: concurrent takers must get DIFFERENT
 * wait times. A bucket that hands the same one to everybody is not a rate limit, it is a
 * synchronised burst with extra steps.
 */
import { bucketState, takeToken, tokenBucket } from "./token-bucket";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const PER_MIN = 30; // one token every 2000ms
const BURST = 5;
const take = (s: ReturnType<typeof bucketState>, now: number) => takeToken(s, now, PER_MIN, BURST);

// ── the burst is free, then the rate bites ──
{
  let s = bucketState(BURST, 0);
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = take(s, 0);
    waits.push(r.waitMs);
    s = r.state;
  }
  eq("the first `burst` calls do not wait", waits.slice(0, 5), [0, 0, 0, 0, 0]);
  eq("and the rest are spaced by the rate", waits.slice(5), [2000, 4000, 6000]);
}

// ── refill ──
{
  let s = bucketState(BURST, 0);
  for (let i = 0; i < 5; i++) s = take(s, 0).state;
  eq("a drained bucket makes the next caller wait", take(s, 0).waitMs, 2000);
  eq("waiting out one token clears it", take(s, 2000).waitMs, 0);
  eq("a long idle refills, but not past the burst", take(s, 10 * 60_000).state.tokens, BURST - 1);
}

// ── the reservation must not drift backwards ──
{
  let s = bucketState(1, 0);
  s = take(s, 0).state;             // spends the only token, at = 0
  const r = take(s, 0);             // reserves 2000ms out, at = 2000
  eq("a reservation moves the clock forward", r.state.at, 2000);
  // A caller arriving at 1000 is inside that reservation: it must queue BEHIND it, not
  // be handed the same slot because 1000ms of "elapsed" time appears to have refilled one.
  // The reserved token lands at 2000 and is already spoken for, so this caller waits for
  // the one after it, at 4000 -- 3000ms from its own arrival, and measured from THAT.
  eq("a later caller queues behind the reservation", take(r.state, 1000).waitMs, 3000);
}

// ── concurrent takers get distinct slots ──
{
  const bucket = tokenBucket({
    perMinute: PER_MIN, burst: 1, now: () => 0, sleep: async () => {},
  });
  const seen: number[] = [];
  const orig = bucket.waitMs;
  for (let i = 0; i < 4; i++) { seen.push(orig()); bucket.take(); }
  eq("each concurrent caller sees a later slot", seen, [0, 2000, 4000, 6000]);
}

// ── the async wrapper actually sleeps for the reserved time ──
{
  const slept: number[] = [];
  const bucket = tokenBucket({
    perMinute: PER_MIN, burst: 2, now: () => 0, sleep: async (ms) => { slept.push(ms); },
  });
  await bucket.take();
  await bucket.take();
  await bucket.take();
  await bucket.take();
  eq("only the calls past the burst sleep", slept, [2000, 4000]);
}

// ── slowing down on refusal ─────────────────────────────────────────────
{
  const slept: number[] = [];
  const bucket = tokenBucket({
    perMinute: 60, burst: 2, floorPerMinute: 15,
    now: () => 0, sleep: async (ms) => { slept.push(ms); },
  });
  eq("starts at the given rate", bucket.rate(), 60);
  eq("halves on refusal", bucket.slow(), 30);
  eq("and again", bucket.slow(), 15);
  eq("but never below the floor", bucket.slow(), 15);

  // At 15/min a token is 4000ms, and slow() banked no credit, so the very next caller
  // waits a full interval rather than spending a token saved at the old rate.
  await bucket.take();
  eq("the new rate applies immediately", slept, [4000]);
}

// ── and it must climb back out ──────────────────────────────────────────
//
// The bug this guards: the bucket only ever halved. One refusal in the first seconds of a
// scan held the rate at the floor for the whole page, with the provider answering fine.
{
  const b = tokenBucket({
    perMinute: 20, burst: 2, floorPerMinute: 5, recoverAfter: 3,
    now: () => 0, sleep: async () => {},
  });
  b.slow(); b.slow();
  eq("two refusals take it to the floor", b.rate(), 5);

  b.ok(); b.ok();
  eq("a couple of clean responses are not enough", b.rate(), 5);
  b.ok();
  eq("a RUN of them widens it by one step", b.rate(), 10);
  b.ok(); b.ok(); b.ok();
  eq("and again", b.rate(), 15);
  for (let i = 0; i < 30; i++) b.ok();
  eq("but never past the opening rate", b.rate(), 20);

  // A refusal mid-run must reset the run, not merely halve: otherwise two clean responses
  // either side of a refusal count as progress toward widening.
  b.slow();
  eq("a refusal halves it again", b.rate(), 10);
  b.ok(); b.ok();
  b.slow();
  eq("and resets the clean run", b.rate(), 5);
  b.ok(); b.ok();
  eq("so the interrupted run does not carry over", b.rate(), 5);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
