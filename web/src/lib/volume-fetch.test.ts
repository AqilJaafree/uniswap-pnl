/**
 * The batch loop's failure accounting: what the user is told when the provider stops
 * answering.
 *
 * These do not exercise the pacing (token-bucket.test.ts does, against a fake clock).
 * They exercise the thing that produced the bug report: a provider that cuts us off
 * partway through a wallet's pools, and a UI that has to say something true about the
 * pools it never got to.
 */
import { clearVolumeMemo, fetchPoolsVolume, setVolumeGate, type PoolRef } from "./volume";
import { memoryStore, setStore, nullStore } from "./idb";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

setVolumeGate({ async take() {} }, 0); // no pacing, no retry delay — see the seam's comment

const pool = (n: number): PoolRef => ({ id: `0x${n}`, label: `P${n} / USDG 1.00%`, version: "v3" });
const POOLS = [1, 2, 3, 4, 5].map(pool);

const candles = (v: number) => ({
  data: { attributes: { ohlcv_list: [[1787356800, 1, 1, 1, 1, v]] } },
});

/** A fetch stub keyed on the pool id embedded in the URL. */
function stubFetch(reply: (id: string) => Response | Promise<Response> | Promise<never>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const id = String(url).match(/pools\/([^/]+)\//)![1];
    calls.push(id);
    return reply(id);
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * A fresh start: the in-process memo is module-level, so without clearing it a later
 * block is answered by an earlier block's promises and never reaches the stub at all.
 */
const reset = (store: Parameters<typeof setStore>[0]) => { setStore(store); clearVolumeMemo(); };

const ok = (v: number) => new Response(JSON.stringify(candles(v)), { status: 200 });
const status = (n: number) => new Response("{}", { status: n });
/** What Cloudflare's CORS-less 429 looks like to JavaScript: an opaque TypeError. */
const opaque = () => Promise.reject(new TypeError("Failed to fetch"));

// ── the provider cuts us off midway ──────────────────────────────────────
{
  reset(nullStore); // no cache — every pool is a network call
  const MANY = [1, 2, 3, 4, 5, 6, 7, 8].map(pool);
  // Everything from the third pool on is refused, and stays refused: a real block, not
  // the blip the next test covers.
  const calls = stubFetch((id) => (["0x1", "0x2"].includes(id) ? ok(100) : opaque()));
  const r = await fetchPoolsVolume(MANY, "day");

  eq("it stops asking once blocked", r.blocked, true);
  eq("what came back is kept", r.covered.map((p) => p.id).sort(), ["0x1", "0x2"]);
  eq("a blocked pool is not called unreadable", r.failed, []);
  eq("every pool is accounted for exactly once",
     r.covered.length + r.missing.length + r.failed.length + r.skipped.length, MANY.length);
  eq("the pools it never got to are reported as skipped",
     r.skipped.map((p) => p.id).sort(), ["0x3", "0x4", "0x5", "0x6", "0x7", "0x8"]);
  // The whole point: a blocked provider must not be asked 61 more times. Two workers,
  // three tries each, is the most that can be spent before both give up.
  eq("nothing past the block is ever requested", calls.includes("0x5"), false);
  eq("and it gives up within two pools' worth of tries", calls.length <= 2 + 2 * 3, true);
}

// ── a 404 is still 'not indexed', not a failure ──────────────────────────
{
  reset(nullStore);
  stubFetch((id) => (id === "0x2" ? status(404) : ok(50)));
  const r = await fetchPoolsVolume(POOLS, "day");
  eq("404 means the provider does not index it", r.missing.map((p) => p.id), ["0x2"]);
  eq("and the scan continues", r.covered.length, 4);
  eq("nothing is skipped", r.skipped, []);
}

// ── a readable 429 blocks too, once its retry is spent ───────────────────
{
  reset(nullStore);
  const calls = stubFetch((id) => (id === "0x1" ? status(429) : ok(1)));
  const r = await fetchPoolsVolume([pool(1)], "day");
  eq("a persistent 429 blocks", r.blocked, true);
  eq("but only after three tries", calls.filter((c) => c === "0x1").length, 3);
}

// ── an INTERMITTENT refusal must not abandon the wallet ──────────────────
{
  reset(nullStore);
  const slowed: number[] = [];
  setVolumeGate({ async take() {}, slow: () => (slowed.push(1), 10) }, 0);
  // Every pool is refused once and answers on the retry — which is what the live
  // provider actually does at a too-fast pace. Giving up on the first refusal would
  // report five pools as unreadable when all five have data.
  const seen = new Map<string, number>();
  stubFetch((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? status(429) : ok(3);
  });
  const r = await fetchPoolsVolume(POOLS, "day");
  eq("a blip does not block", r.blocked, false);
  eq("and every pool is still charted", r.covered.length, 5);
  eq("each refusal slowed the rate", slowed.length, 5);
  setVolumeGate({ async take() {} }, 0); // back to the plain gate for later blocks
}

// ── the day cache spends no budget on a second pass ──────────────────────
{
  reset(memoryStore());
  const first = stubFetch(() => ok(7));
  const a = await fetchPoolsVolume(POOLS, "day");
  eq("a cold pass reads every pool", first.length, 5);
  eq("all five are covered", a.covered.length, 5);

  // A reload keeps the store but loses the in-process memo. This is the case the old
  // sessionStorage cache did not survive, and the reason "Reload to retry" made things
  // worse rather than better.
  clearVolumeMemo(); // a reload keeps the store, loses the memo
  const second = stubFetch(() => { throw new Error("must not reach the network"); });
  const b = await fetchPoolsVolume(POOLS, "day");
  eq("a warm pass makes no request at all", second.length, 0);
  eq("and still charts every pool", b.covered.length, 5);
  eq("with the same totals", b.points[0].total, a.points[0].total);
}

// ── a block is waited out, not treated as the end ────────────────────────
//
// MEASURED against the live endpoint: at 3s spacing it answers three requests and then
// refuses everything; after ~30s of quiet a request succeeds again. So the budget comes
// back on its own, and abandoning the remaining pools threw away a wallet's chart over a
// wait. Wallet 0x7e99…A2C reported 79 of ~82 pools missing for exactly this reason.
{
  reset(nullStore);
  const MANY = [1, 2, 3, 4, 5, 6, 7, 8].map(pool);
  let refusing = true;
  // Two pools get through, then the wall — until the cooldown, after which it relents.
  const calls = stubFetch((id) =>
    ["0x1", "0x2"].includes(id) || !refusing ? ok(100) : opaque());
  const waits: number[] = [];
  setVolumeGate({ async take() {} }, 0, { cooldownMs: 0, maxResumes: 3 });
  const r = await fetchPoolsVolume(MANY, "day", undefined, (_ms, n) => {
    waits.push(n);
    refusing = false; // the minute passes
  });

  eq("the block is waited out, not abandoned", r.blocked, false);
  eq("and every pool ends up charted", r.covered.length, MANY.length);
  eq("so nothing is reported missing to the user", r.skipped, []);
  eq("one cooldown was enough", waits, [1]);
  eq("every pool is accounted for exactly once",
     r.covered.length + r.missing.length + r.failed.length + r.skipped.length, MANY.length);
  // The stop-immediately invariant still holds WITHIN a pass: the first pass must not
  // have ploughed through 0x4..0x8 while it was being refused.
  const firstPass = calls.slice(0, calls.indexOf("0x3") + 3);
  eq("it still stops asking inside a blocked pass", firstPass.includes("0x8"), false);
}

// ── but a provider that never relents still ends, and says so ────────────
{
  reset(nullStore);
  stubFetch(() => opaque());
  const waits: number[] = [];
  setVolumeGate({ async take() {} }, 0, { cooldownMs: 0, maxResumes: 2 });
  const r = await fetchPoolsVolume([pool(1), pool(2)], "day", undefined, (_ms, n) => waits.push(n));
  eq("a provider that never relents blocks", r.blocked, true);
  eq("after the capped number of resumes", waits, [1, 2]);
  eq("and the rest are reported skipped, not silently dropped", r.skipped.length, 2);
}
setVolumeGate({ async take() {} }, 0); // resume off again for anything added below

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
