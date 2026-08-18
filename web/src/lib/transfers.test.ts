import { chunkIds, groupByTokenId, TOKEN_ID_CHUNK } from "./transfers";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    === JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  ok ? pass++ : fail++;
};

const t = (blockNumber: bigint, logIndex: number, from = "0xa", to = "0xb") =>
  ({ blockNumber, logIndex, from, to });

// ---- chunking ----------------------------------------------------------------
{
  eq("empty stays empty", chunkIds([]), []);
  eq("one short chunk", chunkIds([1, 2, 3], 50), [[1, 2, 3]]);
  eq("splits on the boundary", chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  // 112 positions was the wallet that prompted this: 3 queries, not 112.
  eq("a 112-id wallet becomes 3 queries", chunkIds(Array.from({ length: 112 }, (_, i) => i)).length, 3);
  eq("default chunk size", TOKEN_ID_CHUNK, 50);
  let threw = "";
  try { chunkIds([1], 0); } catch (e) { threw = (e as Error).message; }
  eq("a zero chunk size is refused, not an infinite loop", threw, "chunk size must be at least 1");
}

// ---- grouping ----------------------------------------------------------------
{
  const got = groupByTokenId([1n, 2n], [
    { tokenId: 2n, transfer: t(50n, 0) },
    { tokenId: 1n, transfer: t(10n, 1) },
    { tokenId: 1n, transfer: t(10n, 0) },
  ]);
  eq("separates ids", [...got.keys()], [1n, 2n]);
  // Chain order matters: ownershipOf walks these to build hold windows, and a topic-array
  // query returns them interleaved across ids and chunks.
  eq("sorts by block then logIndex", got.get(1n)!.map((x) => x.logIndex), [0, 1]);
  eq("second id intact", got.get(2n)!.length, 1);
}

// An id with no logs must be PRESENT and EMPTY, never missing: restrictToOwner reads
// "no logs" as "cannot establish ownership, do not truncate", and it must not confuse
// that with "never fetched".
{
  const got = groupByTokenId([7n, 8n], [{ tokenId: 7n, transfer: t(1n, 0) }]);
  eq("an id with no logs is present", got.has(8n), true);
  eq("an id with no logs is empty", got.get(8n), []);
}

// A log for an id nobody asked about can only come from an over-wide filter; dropping it
// keeps it from silently widening a position's ownership window.
{
  const got = groupByTokenId([1n], [
    { tokenId: 1n, transfer: t(1n, 0) },
    { tokenId: 99n, transfer: t(2n, 0) },
  ]);
  eq("unrequested ids are dropped", [...got.keys()], [1n]);
  eq("requested id unaffected", got.get(1n)!.length, 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
