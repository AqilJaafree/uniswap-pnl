/**
 * How the explorer is asked for a tx's trace.
 *
 * The bug behind these: `fetchNativeFlowsByTx` fans out over every tx of a position with
 * an unbounded `Promise.all`, once per position. Measured against the real explorer at
 * 50-way concurrency, that draws 200s, 500s, dropped connections, and — once in that
 * sample — a response with NO CORS header, which the browser reports as a CORS failure
 * and which reaches this code as an opaque TypeError. The consequence is not cosmetic:
 * a lost MINT trace costs the implied tick, and the position falls back to the pool's
 * genesis tick.
 */
import { createExplorerTraceReader, setExplorerGate, UnindexedTrace } from "./chain-v4";
import { createChainCache } from "./chain-cache";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";
import { memoryStore, setStore } from "./idb";
import { clearPromiseCache } from "./promise-cache";

// createV4Client's real trace-fetching implementation, built for the same chain the
// hardcoded IndexedDB keys below assume (NS `v1:4663`) — see createExplorerTraceReader.
// One cache instance for the whole file: resetCaches() below clears the underlying
// store/promise-cache globally regardless of which instance asks, so reuse is just less
// churn, not a correctness requirement.
const cache = createChainCache(ROBINHOOD_CHAIN);
const { fetchTraceCalls, cachedTraceCalls } = createExplorerTraceReader(ROBINHOOD_CHAIN, cache);
const resetCaches = () => cache.resetCaches();

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const TX = "0xabc";
let takes = 0, slows = 0, oks = 0;
const gate = {
  async take() { takes++; },
  slow: () => (slows++, 60),
  ok: () => { oks++; },
};
setExplorerGate(gate);

const body = (items: unknown[], next: unknown = null) =>
  new Response(JSON.stringify({ items, next_page_params: next }), { status: 200 });
const frame = { type: "call", from: "0x1", to: "0x2", value: "5", success: true };

function stub(reply: (n: number) => Response | Promise<never>) {
  let n = 0;
  const seen = () => n;
  globalThis.fetch = (async () => reply(++n)) as unknown as typeof fetch;
  return seen;
}

// ── every request is paced ───────────────────────────────────────────────
{
  takes = 0; slows = 0;
  await resetCaches();
  // Two pages, so the pagination loop is covered too — it used to fetch up to 20 pages
  // per tx with nothing between them.
  stub((n) => (n === 1 ? body([frame], { index: 2 }) : body([frame])));
  const calls = await fetchTraceCalls(TX);
  eq("both pages are read", calls.length, 2);
  eq("and each one took a token", takes, 2);
  eq("a clean read never slows the rate", slows, 0);
  // Each clean page counts toward widening the rate again. Without this the gate only
  // ever ratchets down and a long scan finishes at the floor.
  eq("and both clean pages count toward recovery", oks, 2);
}

// ── overload backs the rate off ──────────────────────────────────────────
{
  takes = 0; slows = 0; oks = 0;
  await resetCaches();
  stub(() => new Response("oops", { status: 500 }));
  let threw = "";
  try { await fetchTraceCalls(TX); } catch (e) { threw = (e as Error).message; }
  eq("a 500 surfaces rather than being read as an empty trace", threw, "blockscout 500 for 0xabc");
  eq("and it slows the rate", slows, 1);
  eq("a failed read counts toward nothing", oks, 0);
}

// ── an opaque failure (the CORS-less response) does too ──────────────────
{
  takes = 0; slows = 0; oks = 0;
  await resetCaches();
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  let threw = "";
  try { await fetchTraceCalls(TX); } catch (e) { threw = (e as Error).name; }
  eq("the opaque rejection surfaces", threw, "TypeError");
  eq("and it slows the rate too", slows, 1);
}

// ── a 404 must NOT slow anything ─────────────────────────────────────────
{
  takes = 0; slows = 0; oks = 0;
  await resetCaches();
  stub(() => new Response("nope", { status: 404 }));
  try { await fetchTraceCalls(TX); } catch { /* expected */ }
  eq("a 4xx that is not a rate limit leaves the rate alone", slows, 0);
}

// ── an empty frame list is an unread trace, not an empty one ─────────────
// Live 2026-08-26, v4 #892396: Blockscout answered 200 with `{"items":[]}` for the exit
// tx of an ETH/DELTA position, stably, while the tx's real trace carried nine frames —
// one of them the 0.0625 ETH the PoolManager paid the wallet. Read as a flow of zero, it
// told `reconcileRemovalTicks` the chain had paid no ETH at all, which refuted a CORRECT
// pool tick and replaced it with the range's upper bound: withdrawn became 0 ETH, fees
// became 0, and a +10.24% position was reported as −97.52%. A v4 position tx reaches the
// PoolManager through the PositionManager, so its trace has frames by construction —
// zero of them is the explorer saying "not indexed", never "nothing moved".
{
  takes = 0; slows = 0; oks = 0;
  await resetCaches();
  stub(() => body([]));
  let threw = "";
  let kind = "";
  try { await cachedTraceCalls(TX, null); } catch (e) { threw = (e as Error).message; kind = (e as Error).constructor.name; }
  eq("zero frames is refused rather than read as a zero flow", threw, "blockscout: no trace frames for 0xabc — not indexed");
  // Its own class, so `retry` can tell "not indexed" from "overloaded" and ask once
  // rather than three times — see retry.test.ts.
  eq("and it is refused as its own kind of failure", kind, "UnindexedTrace");
}

// ── and it is not remembered, so the explorer can catch up ───────────────
{
  await resetCaches();
  const seen = stub(() => body([]));
  try { await cachedTraceCalls(TX, null); } catch { /* expected */ }
  try { await cachedTraceCalls(TX, null); } catch { /* expected */ }
  eq("an unread trace is re-asked rather than cached", seen(), 2);
}

// ── a trace an EARLIER build persisted as empty is not served back ───────
// The refusal above lives inside `cachedPoint`'s fetcher, and `cachedPoint` returns a
// stored value BEFORE the fetcher runs. Every browser that scanned #892396 while the bug
// was live therefore holds `[]` under this key in IndexedDB, and the fix was inert for
// exactly the people who had already hit it. Node smokes cannot see this: idb.ts hands a
// Node process the null store, where every read misses, so the hit path never executes.
{
  await resetCaches();
  const store = memoryStore();
  setStore(store);
  clearPromiseCache();
  // Byte-for-byte what a pre-fix build wrote: NS is `v1:<chainId>`, key `trace:<hash>`.
  await store.put("points", "v1:4663:trace:0xabc", []);
  const seen = stub(() => body([frame]));
  const calls = await cachedTraceCalls(TX, null);
  eq("a persisted empty trace is a miss, not a hit", calls.length, 1);
  eq("and the explorer is asked again", seen(), 1);
}

// ── and if the explorer is still behind, it is still refused ─────────────
{
  await resetCaches();
  const store = memoryStore();
  setStore(store);
  clearPromiseCache();
  await store.put("points", "v1:4663:trace:0xabc", []);
  stub(() => body([]));
  let kind = "";
  try { await cachedTraceCalls(TX, null); } catch (e) { kind = (e as Error).constructor.name; }
  eq("a poisoned key whose tx is still unindexed still refuses", kind, "UnindexedTrace");
  setStore(memoryStore());
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
