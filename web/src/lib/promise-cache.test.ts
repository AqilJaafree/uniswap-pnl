import { cachedByKey, clearPromiseCache, promiseCacheSize } from "./promise-cache";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const defer = <T>() => { let r!: (v: T) => void; const p = new Promise<T>((res) => { r = res; }); return { p, r }; };

// The point: many positions in one pool issue one query, not one each.
{
  clearPromiseCache();
  let calls = 0;
  const f = async () => { calls++; return [1, 2, 3]; };
  await cachedByKey("pool:A", f);
  await cachedByKey("pool:A", f);
  eq("repeat lookups issue one call", calls, 1);
  eq("value preserved", await cachedByKey("pool:A", f), [1, 2, 3]);
}

// Concurrent misses must collapse — the reason this caches promises, not values.
{
  clearPromiseCache();
  let calls = 0;
  const d = defer<string>();
  const f = () => { calls++; return d.p; };
  const a = cachedByKey("k", f), b = cachedByKey("k", f), c = cachedByKey("k", f);
  eq("in-flight duplicates collapse", calls, 1);
  d.r("v");
  eq("all callers get it", await Promise.all([a, b, c]), ["v", "v", "v"]);
}

// Distinct keys must not collide.
{
  clearPromiseCache();
  eq("key A", await cachedByKey("A", async () => 1), 1);
  eq("key B", await cachedByKey("B", async () => 2), 2);
  eq("two entries", promiseCacheSize(), 2);
}

// A failure must not poison the key for the session.
{
  clearPromiseCache();
  let calls = 0;
  const f = async () => { calls++; if (calls === 1) throw new Error("rpc down"); return "ok"; };
  let threw = "";
  try { await cachedByKey("flaky", f); } catch (e) { threw = (e as Error).message; }
  eq("failure surfaces", threw, "rpc down");
  eq("failure evicted", promiseCacheSize(), 0);
  eq("retry succeeds", await cachedByKey("flaky", f), "ok");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
