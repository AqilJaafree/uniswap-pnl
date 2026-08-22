import { groupByCachedTo, mergeLogs, nextPersistTo, planRangeFetch, upTo } from "./log-cache";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const s = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
  const ok = s(got) === s(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${s(got)} want=${s(want)}`);
  ok ? pass++ : fail++;
};
const log = (bn: bigint, li: number) => ({ blockNumber: bn, logIndex: li });

// --- planRangeFetch -------------------------------------------------------------------

eq("no record fetches everything", planRangeFetch(undefined, 0n, 100n), { kind: "full", from: 0n, to: 100n });

eq("record short of the head extends from its end + 1",
  planRangeFetch({ from: 0n, to: 60n, logs: [] }, 0n, 100n),
  { kind: "extend", from: 61n, to: 100n });

eq("record already past the head issues nothing",
  planRangeFetch({ from: 0n, to: 120n, logs: [] }, 0n, 100n), { kind: "hit" });

eq("record ending exactly at the head issues nothing",
  planRangeFetch({ from: 0n, to: 100n, logs: [] }, 0n, 100n), { kind: "hit" });

// The trap this guards: reusing a record whose start block differs would silently answer
// a genesis-to-head question with a mint-block-to-head answer.
eq("a different start block is not reusable",
  planRangeFetch({ from: 50n, to: 90n, logs: [] }, 0n, 100n),
  { kind: "full", from: 0n, to: 100n });

// --- nextPersistTo --------------------------------------------------------------------

eq("writes stop short of the head by the reorg depth", nextPersistTo(null, 0n, 1000n, 512n), 488n);

eq("a request wholly inside the reorg window writes nothing",
  nextPersistTo(null, 0n, 100n, 512n), null);

// Without the max(), a head that advanced by less than the depth would shrink the record
// every visit and the cache could never grow.
eq("a barely-advanced head never shrinks the record",
  nextPersistTo(900n, 0n, 1000n, 512n), 900n);

eq("a well-advanced head extends the record",
  nextPersistTo(400n, 0n, 1000n, 512n), 488n);

eq("a from-block above the settled point writes nothing",
  nextPersistTo(null, 600n, 1000n, 512n), null);

// --- mergeLogs ------------------------------------------------------------------------

eq("prefix and tail concatenate in chain order",
  mergeLogs([log(5n, 0)], [log(9n, 1), log(7n, 2)]).map((l) => [Number(l.blockNumber), l.logIndex]),
  [[5, 0], [7, 2], [9, 1]]);

eq("logs in one block order by log index",
  mergeLogs([], [log(5n, 3), log(5n, 1), log(5n, 2)]).map((l) => l.logIndex), [1, 2, 3]);

// An off-by-one at a range boundary must show up as no change, never as a doubled event.
eq("an overlapping boundary does not double-count",
  mergeLogs([log(5n, 0), log(6n, 0)], [log(6n, 0), log(7n, 0)]).map((l) => Number(l.blockNumber)),
  [5, 6, 7]);

// --- upTo -----------------------------------------------------------------------------

eq("upTo is inclusive of its bound",
  upTo([log(1n, 0), log(5n, 0), log(6n, 0)], 5n).map((l) => Number(l.blockNumber)), [1, 5]);

// --- groupByCachedTo ------------------------------------------------------------------

// The point of the whole module: a wallet cached by one earlier scan is ONE bucket, so
// its whole history costs one query rather than one per chunk.
{
  const g = groupByCachedTo([
    { id: 1n, to: 900n }, { id: 2n, to: 900n }, { id: 3n, to: null }, { id: 4n, to: 800n },
  ]);
  eq("ids sharing a cached end share a bucket", g.get("900")!.ids.map(Number), [1, 2]);
  eq("uncached ids get their own bucket", g.get("none")!.ids.map(Number), [3]);
  eq("bucket carries its end block", g.get("none")!.to, null);
  eq("distinct ends stay distinct", g.size, 3);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
