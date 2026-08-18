import { cachedTokenMeta, clearTokenMetaCache, tokenMetaCacheSize } from "./token-meta";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const defer = () => { let r: (v: never) => void, j: (e: unknown) => void;
  const p = new Promise((res, rej) => { r = res as never; j = rej; }); return { p, r: r!, j: j! }; };

// ---- the point of the whole thing: one call per token, not per position ------
{
  clearTokenMetaCache();
  let calls = 0;
  const fetcher = async (a: string) => { calls++; return { dec: 6, sym: `T${a}` }; };
  await cachedTokenMeta("0xAAA", fetcher);
  await cachedTokenMeta("0xAAA", fetcher);
  await cachedTokenMeta("0xAAA", fetcher);
  eq("repeated lookups issue one call", calls, 1);
  eq("value is still correct", (await cachedTokenMeta("0xAAA", fetcher)).dec, 6);
}

// Addresses differing only in case are the SAME token; two slots would double the calls
// and could disagree with each other.
{
  clearTokenMetaCache();
  let calls = 0;
  const fetcher = async () => { calls++; return { dec: 18, sym: "X" }; };
  await cachedTokenMeta("0xAbCdEf", fetcher);
  await cachedTokenMeta("0xabcdef", fetcher);
  await cachedTokenMeta("0xABCDEF", fetcher);
  eq("case-insensitive identity", calls, 1);
  eq("one cache entry", tokenMetaCacheSize(), 1);
}

// Distinct tokens must not collide.
{
  clearTokenMetaCache();
  const fetcher = async (a: string) => ({ dec: a === "0x1" ? 6 : 18, sym: a });
  eq("first token", (await cachedTokenMeta("0x1", fetcher)).dec, 6);
  eq("second token", (await cachedTokenMeta("0x2", fetcher)).dec, 18);
  eq("two entries", tokenMetaCacheSize(), 2);
}

// CONCURRENT misses must collapse into ONE request — the case that made this a promise
// cache rather than a value cache. Several positions ask for the same token at once.
{
  clearTokenMetaCache();
  let calls = 0;
  const d = defer();
  const fetcher = async () => { calls++; return d.p as unknown as { dec: number; sym: string }; };
  const a = cachedTokenMeta("0xSAME", fetcher);
  const b = cachedTokenMeta("0xSAME", fetcher);
  const c = cachedTokenMeta("0xSAME", fetcher);
  eq("in-flight lookups share one call", calls, 1);
  d.r({ dec: 8, sym: "S" } as never);
  eq("all callers get the value", (await Promise.all([a, b, c])).map((m) => m.dec), [8, 8, 8]);
}

// A transient failure must not poison the token for the rest of the session.
{
  clearTokenMetaCache();
  let calls = 0;
  const fetcher = async () => { calls++; if (calls === 1) throw new Error("rpc down"); return { dec: 2, sym: "OK" }; };
  let threw = "";
  try { await cachedTokenMeta("0xFLAKY", fetcher); } catch (e) { threw = (e as Error).message; }
  eq("the failure surfaces", threw, "rpc down");
  eq("the failure is evicted", tokenMetaCacheSize(), 0);
  eq("a later lookup retries and succeeds", (await cachedTokenMeta("0xFLAKY", fetcher)).sym, "OK");
  eq("which took a second call", calls, 2);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
