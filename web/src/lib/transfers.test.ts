import { chunkIds, TOKEN_ID_CHUNK } from "./transfers";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    === JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  ok ? pass++ : fail++;
};

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

// Grouping the results back out by tokenId moved to chain-cache.ts, which has to do it
// anyway to keep one cache record per position; its tests cover the every-id-is-present
// and drop-unrequested-ids rules that used to live here.

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
