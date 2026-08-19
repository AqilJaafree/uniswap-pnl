/**
 * The persistent cache, driven the way the app drives it.
 *
 * A "second page load" here is `clearPromiseCache()` with the store left alone -- that is
 * exactly what a reload is, and it is the case the whole feature exists for.
 */
import { memoryStore, setStore } from "./idb";
import { clearPromiseCache } from "./promise-cache";
import { clearTokenMetaCache } from "./token-meta";
import {
  REORG_DEPTH, cachedBlockTimestamp, cachedLogRange, cachedLogsById, cachedPoint,
  cachedTokenMetaPersistent, isFinal, noteHead, resetHead,
} from "./chain-cache";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const s = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
  const ok = s(got) === s(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${s(got)} want=${s(want)}`);
  ok ? pass++ : fail++;
};

type L = { blockNumber: bigint | null; logIndex: number | null; id: bigint };
const log = (bn: bigint, li: number, id = 1n): L => ({ blockNumber: bn, logIndex: li, id });

/** A fresh store, an empty in-scan cache, and no head noted. A cold browser. */
function coldStart() {
  const store = memoryStore();
  setStore(store);
  clearPromiseCache();
  clearTokenMetaCache();
  resetHead();
  return store;
}
/** Same store, everything in-memory forgotten. A reload. */
function reload() {
  clearPromiseCache();
  clearTokenMetaCache();
}

const HEAD_1 = 10_000n;
const HEAD_2 = 12_000n;

// --- finality -------------------------------------------------------------------------

{
  coldStart();
  eq("nothing is final before a head is noted", isFinal(1n), false);
  noteHead(HEAD_1);
  eq("an old block is final", isFinal(1n), true);
  eq("a block exactly at the depth boundary is final", isFinal(HEAD_1 - REORG_DEPTH), true);
  eq("a block one inside the window is not", isFinal(HEAD_1 - REORG_DEPTH + 1n), false);
  noteHead(HEAD_1 - 1000n);
  eq("the head never moves backwards", isFinal(HEAD_1 - REORG_DEPTH), true);
}

// --- cachedLogRange -------------------------------------------------------------------

// The headline behaviour: a reload asks only for the blocks that did not exist last time.
{
  coldStart();
  noteHead(HEAD_1);
  const asked: [bigint, bigint][] = [];
  const chain = [log(100n, 0), log(9_600n, 0), log(11_000n, 0)];
  const fetchRange = async (f: bigint, t: bigint) => {
    asked.push([f, t]);
    return chain.filter((l) => l.blockNumber! >= f && l.blockNumber! <= t);
  };

  const first = await cachedLogRange("q", 0n, HEAD_1, fetchRange);
  eq("cold scan asks for the whole range", asked, [[0n, HEAD_1]]);
  eq("cold scan returns what the chain has", first.map((l) => Number(l.blockNumber)), [100, 9600]);

  reload();
  noteHead(HEAD_2);
  const second = await cachedLogRange("q", 0n, HEAD_2, fetchRange);
  eq("reload asks only for the tail", asked[1], [HEAD_1 - REORG_DEPTH + 1n, HEAD_2]);
  eq("reload returns cached prefix plus tail",
    second.map((l) => Number(l.blockNumber)), [100, 9600, 11000]);
  eq("reload issued exactly one query", asked.length, 2);
}

// A range that never settles must never be written down -- otherwise a reorged log would
// outlive the reorg.
{
  coldStart();
  noteHead(HEAD_1);
  let calls = 0;
  const f = async () => { calls++; return [log(9_990n, 0)]; };
  await cachedLogRange("tip", HEAD_1 - 10n, HEAD_1, f);
  reload();
  await cachedLogRange("tip", HEAD_1 - 10n, HEAD_1, f);
  eq("a request inside the reorg window is not persisted", calls, 2);
}

// Without a head, nothing is final, so nothing persists. Slow, never wrong.
{
  coldStart();
  let calls = 0;
  const f = async () => { calls++; return [log(1n, 0)]; };
  await cachedLogRange("nohead", 0n, HEAD_1, f);
  reload();
  await cachedLogRange("nohead", 0n, HEAD_1, f);
  eq("without a noted head nothing persists", calls, 2);
}

// Two queries must not share an entry.
{
  coldStart();
  noteHead(HEAD_1);
  const a = await cachedLogRange("A", 0n, HEAD_1, async () => [log(1n, 0)]);
  const b = await cachedLogRange("B", 0n, HEAD_1, async () => [log(2n, 0)]);
  eq("distinct keys do not collide", [Number(a[0].blockNumber), Number(b[0].blockNumber)], [1, 2]);
}

// --- cachedLogsById -------------------------------------------------------------------

{
  const ids = [1n, 2n, 3n];
  coldStart();
  noteHead(HEAD_1);
  const asked: { ids: bigint[]; from: bigint; to: bigint }[] = [];
  const chain = [log(100n, 0, 1n), log(200n, 0, 1n), log(300n, 0, 2n), log(11_500n, 0, 3n)];
  const fetchIds = async (bucket: bigint[], from: bigint, to: bigint) => {
    asked.push({ ids: bucket, from, to });
    return chain.filter((l) =>
      bucket.includes(l.id) && l.blockNumber! >= from && l.blockNumber! <= to);
  };
  const idOf = (l: L) => l.id;

  const first = await cachedLogsById("t", ids, 0n, HEAD_1, fetchIds, idOf);
  eq("cold scan is one bucket", asked.length, 1);
  eq("cold scan asks the full range for every id",
    { ids: asked[0].ids.map(Number), from: Number(asked[0].from), to: Number(asked[0].to) },
    { ids: [1, 2, 3], from: 0, to: 10000 });
  eq("logs land under their own id", first.get(1n)!.map((l) => Number(l.blockNumber)), [100, 200]);
  // Load-bearing: restrictToOwner reads an empty array as "asked, and there is nothing",
  // which is a different answer from a missing key.
  eq("an id with no logs is present and empty", first.get(3n), []);

  reload();
  noteHead(HEAD_2);
  const second = await cachedLogsById("t", ids, 0n, HEAD_2, fetchIds, idOf);
  eq("reload is still one bucket", asked.length, 2);
  eq("reload asks only the tail, for every id at once",
    { ids: asked[1].ids.map(Number), from: Number(asked[1].from), to: Number(asked[1].to) },
    { ids: [1, 2, 3], from: 9489, to: 12000 });
  eq("reload keeps the cached prefix", second.get(1n)!.map((l) => Number(l.blockNumber)), [100, 200]);
  eq("reload picks up what is new", second.get(3n)!.map((l) => Number(l.blockNumber)), [11500]);

  // A position minted since the last scan has no record, so it needs the full range while
  // everything else needs only the tail. Two buckets, still two queries -- not one per id.
  reload();
  const withNew = await cachedLogsById("t", [...ids, 9n], 0n, HEAD_2, fetchIds, idOf);
  const fresh = asked.slice(2).map((a) => ({ ids: a.ids.map(Number), from: Number(a.from) }));
  eq("a new id splits into its own bucket", fresh.length, 2);
  eq("the new id is fetched from the start", fresh.find((a) => a.ids.includes(9))!.from, 0);
  eq("the known ids are still only topped up",
    fresh.find((a) => !a.ids.includes(9))!.from, 11489);
  eq("every requested id is in the result", [...withNew.keys()].map(Number), [1, 2, 3, 9]);
}

// A log for an id nobody asked about can only come from a filter wider than intended.
// Dropping it keeps a position's ownership window from silently growing.
{
  coldStart();
  noteHead(HEAD_1);
  const got = await cachedLogsById(
    "w", [1n], 0n, HEAD_1,
    async () => [log(10n, 0, 1n), log(20n, 0, 99n)],
    (l) => l.id);
  eq("unrequested ids are dropped", [...got.keys()].map(Number), [1]);
  eq("the requested id is unaffected", got.get(1n)!.map((l) => Number(l.blockNumber)), [10]);
}

// The per-id twin of "a different start block is not reusable". The v4 lifecycle queries
// start at a POSITION's mint block, so a record written for one start must never be handed
// to a request with another -- it would answer with a window the caller did not ask for.
{
  coldStart();
  noteHead(HEAD_1);
  const asked: { from: bigint; to: bigint }[] = [];
  const fetchIds = async (bucket: bigint[], from: bigint, to: bigint) => {
    asked.push({ from, to });
    return [log(100n, 0, 1n), log(5_000n, 0, 1n)].filter((l) =>
      bucket.includes(l.id) && l.blockNumber! >= from && l.blockNumber! <= to);
  };
  const idOf = (l: L) => l.id;

  await cachedLogsById("m", [1n], 0n, HEAD_1, fetchIds, idOf);
  reload();
  const scoped = await cachedLogsById("m", [1n], 1_000n, HEAD_1, fetchIds, idOf);
  eq("a record from another start block is not reused", Number(asked[1].from), 1000);
  eq("and the answer is scoped to the start that was asked for",
    scoped.get(1n)!.map((l) => Number(l.blockNumber)), [5000]);
}

// A fully-covered revisit at the same head must issue nothing at all.
{
  coldStart();
  noteHead(HEAD_1);
  let calls = 0;
  const fetchIds = async (bucket: bigint[], from: bigint, to: bigint) => {
    calls++;
    return [log(100n, 0, 1n)].filter((l) =>
      bucket.includes(l.id) && l.blockNumber! >= from && l.blockNumber! <= to);
  };
  await cachedLogsById("q", [1n], 0n, HEAD_1, fetchIds, (l) => l.id);
  reload();
  const again = await cachedLogsById("q", [1n], 0n, HEAD_1 - REORG_DEPTH, fetchIds, (l) => l.id);
  eq("a revisit inside the cached range queries nothing", calls, 1);
  eq("and still answers", again.get(1n)!.map((l) => Number(l.blockNumber)), [100]);
}

// --- point caches ---------------------------------------------------------------------

{
  coldStart();
  noteHead(HEAD_1);
  let calls = 0;
  const fetch = async () => { calls++; return 1_700_000_000; };
  await cachedBlockTimestamp(42n, fetch);
  reload();
  eq("a settled block timestamp survives a reload",
    await cachedBlockTimestamp(42n, fetch), 1_700_000_000);
  eq("and was fetched once", calls, 1);

  // A tip block is shared within the scan but never written down.
  let tipCalls = 0;
  const tip = async () => { tipCalls++; return 1_700_000_999; };
  await Promise.all([cachedBlockTimestamp(HEAD_1, tip), cachedBlockTimestamp(HEAD_1, tip)]);
  eq("concurrent asks for the same block collapse", tipCalls, 1);
  reload();
  await cachedBlockTimestamp(HEAD_1, tip);
  eq("an unsettled block timestamp is not persisted", tipCalls, 2);
}

// Receipts are keyed case-insensitively: the same hash must not occupy two slots.
{
  coldStart();
  noteHead(HEAD_1);
  let calls = 0;
  const f = async () => { calls++; return { blockNumber: 5n, gasUsed: 21_000n }; };
  await cachedPoint("receipt:0xab", f, (r) => isFinal(r.blockNumber));
  reload();
  const r = await cachedPoint("receipt:0xab", f, (rr) => isFinal(rr.blockNumber));
  eq("a settled receipt survives a reload", Number(r.gasUsed), 21_000);
  eq("and was fetched once", calls, 1);
}

// Token metadata is immutable, so it persists with no finality question at all.
{
  coldStart();
  let calls = 0;
  const read = async (a: string) => { calls++; return { dec: 6, sym: `T${a}` }; };
  await cachedTokenMetaPersistent("0xAbC", read);
  reload();
  const m = await cachedTokenMetaPersistent("0xabc", read);
  eq("token metadata survives a reload with no head noted", m.sym, "T0xAbC");
  eq("and is case-insensitive", calls, 1);
}

// A failed fetch must not be written down as an answer.
{
  coldStart();
  noteHead(HEAD_1);
  let calls = 0;
  const f = async () => { calls++; if (calls === 1) throw new Error("rpc down"); return [log(1n, 0)]; };
  let threw = "";
  try { await cachedLogRange("flaky", 0n, HEAD_1, f); } catch (e) { threw = (e as Error).message; }
  eq("the failure surfaces", threw, "rpc down");
  const retried = await cachedLogRange("flaky", 0n, HEAD_1, f);
  eq("and the key is retried, not poisoned", retried.length, 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
