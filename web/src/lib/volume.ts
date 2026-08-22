/**
 * Swap-volume data layer, daily or weekly.
 *
 * Why an API and not our own logs: reconstructing pool volume from `Swap` logs is
 * measurable and infeasible from the browser. One chunked full-history fetch for a
 * single Robinhood-Chain pool (CASHCAT/WETH 1%) cost 403,365 swaps / 326 RPC calls /
 * 246 s / 356 MB — and a wallet touches many pools. The public RPC caps eth_getLogs
 * at ~2.5 s of server work (≈2–5k results) and 429s above ~2 concurrent calls, so
 * chunking spreads that cost, it doesn't remove it.
 *
 * Two providers cover Robinhood Chain, both CORS-open and free:
 *   • DefiLlama       — chain-wide Uniswap V3 / V4 daily volume (one call, both series)
 *   • GeckoTerminal   — per-pool daily OHLCV, keyed by v3 pool address OR v4 poolId
 *
 * Both report USD notional priced by the provider, NOT by our PnL engine's
 * numeraire — the two figures are not expected to reconcile, and the UI says so.
 * Both also start at their own coverage date (DefiLlama ≈ 2026-06-25; GeckoTerminal
 * at pool creation), which is later than the chain's genesis. Callers surface
 * `coverageStart` rather than letting a short series read as a quiet week.
 *
 * Both providers are natively DAILY, so the day view is the raw feed and the week
 * view is a roll-up of it — the same bytes either way, which is why switching
 * granularity costs no extra request.
 */

import { getStore } from "./idb";
import { tokenBucket } from "./token-bucket";

// ─────────────────────────────────────────────────────────────────────────
// Pure period helpers
// ─────────────────────────────────────────────────────────────────────────

/** Bucket width. Both come from the same daily candles. */
export type Granularity = "day" | "week";

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * UTC, not local, for every key here: both providers bucket their candles on UTC
 * boundaries, so re-bucketing them in local time would shift a candle into the
 * wrong day (and the wrong week) for any reader away from UTC. The realized-PnL
 * calendar keys on LOCAL days instead — it buckets our own on-chain timestamps,
 * where the user's own day is the right frame.
 */
export const dayKeyUTC = (tsSec: number): string => ymd(new Date(tsSec * 1000));

/** "YYYY-MM-DD" of the Monday starting the UTC week `tsSec` falls in. */
export const weekKeyUTC = (tsSec: number): string => {
  const d = new Date(tsSec * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)));
};

export const periodKey = (tsSec: number, g: Granularity): string =>
  g === "week" ? weekKeyUTC(tsSec) : dayKeyUTC(tsSec);

/** Unix seconds at the start of a "YYYY-MM-DD" period key. */
export const periodStartSec = (key: string): number => {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
};

/** "Jul 27 → Aug 02" for a week; "Sat, Aug 01" for a day. */
export function periodLabel(key: string, g: Granularity): string {
  const start = periodStartSec(key) * 1000;
  if (g === "day") {
    return new Date(start).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "2-digit", timeZone: "UTC",
    });
  }
  const f = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
  return `${f(start)} → ${f(start + 6 * 86400 * 1000)}`;
}

/**
 * True when a period hasn't finished yet, so its total is still accruing.
 *
 * This matters more for a line than it did for bars: a half-finished week is a
 * partial sum, and joining it with a straight segment draws a confident downward
 * "trend" that is really just the clock. The chart dashes that segment instead.
 */
export function isPartialPeriod(key: string, g: Granularity, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const step = (g === "week" ? 7 : 1) * 86400;
  return periodStartSec(key) + step > nowSec;
}

/** True when a day key falls on a Saturday or Sunday (UTC). */
export const isWeekend = (dayKey: string): boolean => {
  const dow = new Date(periodStartSec(dayKey) * 1000).getUTCDay();
  return dow === 0 || dow === 6;
};

/**
 * Every period key from `first` to `last` inclusive.
 *
 * Providers omit periods with no volume, so a naive group-by silently closes the
 * gap and draws two non-adjacent points side by side. Filling the span keeps the
 * x-axis a real time axis: a zero day renders as zero, not as absent.
 */
export function periodSpan(first: string, last: string, g: Granularity): string[] {
  const step = (g === "week" ? 7 : 1) * 86400;
  const out: string[] = [];
  for (let t = periodStartSec(first); t <= periodStartSec(last); t += step) out.push(periodKey(t, g));
  return out;
}

export interface DailyPoint {
  ts: number; // unix seconds
  value: number;
}

/**
 * Round an axis maximum up to a clean 1/2/5 × 10ⁿ, so gridline ticks read as round
 * numbers ($0 / $2B / $4B) instead of tracking the data's exact peak.
 */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Sum daily points into periods. Non-finite and negative values are dropped. */
export function bucketBy(days: DailyPoint[], g: Granularity): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of days) {
    if (!Number.isFinite(d.value) || d.value < 0) continue;
    const k = periodKey(d.ts, g);
    out.set(k, (out.get(k) ?? 0) + d.value);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared fetch plumbing
// ─────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 12_000;

/** Carries the HTTP status so callers can tell "no such pool" from "slow down". */
export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The provider is refusing us, and will keep refusing us for a while.
 *
 * Distinct from HttpError because it means something different to the caller: an
 * HttpError is about ONE pool, this is about the next minute of requests. Whoever is
 * looping over pools must stop, not move on to the next one.
 */
export class BlockedError extends Error {
  constructor(public reason: "rate-limit" | "opaque") {
    super(`blocked: ${reason}`);
    this.name = "BlockedError";
  }
}

/**
 * GeckoTerminal's published free-tier budget is ~30 calls/minute. We aim under it, and
 * the burst is small: the state that produces the opaque 429s below is entered by
 * bursting, and it outlasts the burst by a long way.
 */
/**
 * Where the pacing STARTS, not where it settles.
 *
 * GeckoTerminal documents ~30 calls/minute. Measured, that number is optimistic: paced
 * at 25/min this endpoint still refused roughly half the requests in a ten-request run.
 * So the opening rate is conservative and every refusal halves it, down to the floor —
 * the provider is the only honest source for its own current allowance.
 */
const GT_PER_MINUTE = 20;
const GT_FLOOR_PER_MINUTE = 6;
/** Tries per pool. Each refusal halves the rate first, so these are not identical asks. */
const MAX_TRIES = 3;

interface Gate { take(): Promise<void>; slow?(): number }
let gtBucket: Gate = tokenBucket({
  perMinute: GT_PER_MINUTE, floorPerMinute: GT_FLOOR_PER_MINUTE, burst: 3,
});
let retryMs = 2000;

/**
 * Test seam: swap the rate budget and the retry delay.
 *
 * Without it the batch tests would have to sit through the real pacing — minutes of wall
 * clock to assert something that is pure bookkeeping. The pacing arithmetic itself is
 * tested directly, against a fake clock, in token-bucket.test.ts.
 */
/** The rate the bucket has settled on, after however many refusals. For the smoke. */
export function gtRate(): number {
  return (gtBucket as { rate?(): number }).rate?.() ?? NaN;
}

export function setVolumeGate(gate: Gate, retry = 0): void {
  gtBucket = gate;
  retryMs = retry;
}

/**
 * GET, rate-gated, with the two failure modes told apart.
 *
 * There are TWO different 429s from this provider, and only one of them is visible to
 * JavaScript. Measured against api.geckoterminal.com:
 *
 *   light burst      429 WITH `access-control-allow-origin: *`  → `res.status` is readable
 *   sustained abuse  429 with NO CORS header at all             → `fetch` REJECTS
 *
 * The second is served by Cloudflare's edge before the API sees it, and the browser will
 * not expose a response it cannot verify the origin of. So it arrives as an opaque
 * TypeError whose console message says "blocked by CORS policy" — which is why this once
 * read as a network fault, and why 61 pools at a time were reported unreadable. It is a
 * rate limit; it just cannot say so.
 *
 * `gate` is the rate budget to spend, if any. Only a cache MISS spends one.
 */
/**
 * Halve the budget after a refusal. The bucket also drops its banked tokens, so the
 * retry's own `take()` waits out a full interval at the new rate -- that IS the backoff,
 * which is why no explicit sleep is needed when a gate is present.
 */
function slowDown(gate?: Gate): void {
  gate?.slow?.();
}

async function getJson(url: string, gate?: Gate): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await gate?.take();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // A timeout is about this one request and says nothing about our standing with the
      // provider; let it surface as an ordinary failure.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
      // Otherwise: a refusal we are not allowed to read. Measured, these come and go
      // rather than latching, so treat one as "too fast" and only the third in a row as
      // "stopped" -- giving up on the first would abandon a whole wallet over a blip.
      if (attempt < MAX_TRIES - 1) { slowDown(gate); continue; }
      throw new BlockedError("opaque");
    }
    if (res.ok) return res.json();
    if (res.status === 429) {
      if (attempt < MAX_TRIES - 1) { slowDown(gate); if (!gate?.slow) await wait(retryMs); continue; }
      throw new BlockedError("rate-limit");
    }
    throw new HttpError(res.status);
  }
}

/**
 * Cache a provider response until the UTC day turns over.
 *
 * Daily candles change once a day, so a second look at the same wallet — a reload, a
 * flip between day and week, a return visit an hour later — must not spend the request
 * budget again. This used to live in sessionStorage, which does not survive a reload in
 * a fresh tab and, worse, made "Reload to retry" the exact wrong advice: it threw away
 * every candle and re-fired the whole pool list into a provider that was already
 * refusing us. IndexedDB (the same store the chain scan uses) survives both.
 *
 * ONE RECORD PER URL, carrying the day it was fetched, rather than the day in the key.
 * A dated key would be correct too, but it leaves yesterday's entry behind forever: at
 * ~30 KB of candles per pool and a wallet in dozens of pools, that is tens of MB a week
 * of garbage nothing ever reads. Overwriting one record keeps it bounded.
 *
 * A store that cannot open degrades to `nullStore` — every read misses, every write is
 * dropped, and the only cost is speed. See idb.ts.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Forget the in-process memo, so the next call consults the store again.
 *
 * What a page reload does to this module, without the reload. "Rescan from chain" clears
 * the persistent side (chain-cache's `resetCaches` empties the whole store, these entries
 * with it); leaving the memo populated would let the old answers survive it and make the
 * button look broken -- the same trap resetCaches documents for the promise layer.
 */
export function clearVolumeMemo(): void {
  inFlight.clear();
}

const utcDay = () => new Date().toISOString().slice(0, 10);

interface DayCached { day: string; body: unknown }

async function getJsonCached(url: string, gate?: Gate): Promise<unknown> {
  // Process-level memo first. It dedupes concurrent callers, and it is the ONLY cache
  // under Node (tsx smoke runs have no IndexedDB) — without it, asking for the same
  // pools at both granularities fetches everything twice and the second round is
  // rate-limited.
  const memo = inFlight.get(url);
  if (memo) return memo;

  const load = (async () => {
    const store = await getStore();
    const key = `vol:${url}`;
    const hit = await store.get<DayCached>("points", key);
    if (hit && hit.day === utcDay()) return hit.body;

    const body = await getJson(url, gate);
    void store.put("points", key, { day: utcDay(), body } satisfies DayCached);
    return body;
  })();

  inFlight.set(url, load);
  load.catch(() => inFlight.delete(url)); // never memoize a failure
  return load;
}

// ─────────────────────────────────────────────────────────────────────────
// DefiLlama — chain-wide Uniswap V3 / V4
// ─────────────────────────────────────────────────────────────────────────

const LLAMA_URL =
  "https://api.llama.fi/overview/dexs/Robinhood%20Chain?excludeTotalDataChart=true";

/** DefiLlama's display names for the two adapters we chart. */
const LLAMA_V3 = "Uniswap V3";
const LLAMA_V4 = "Uniswap V4";

export interface ChainPoint {
  period: string;
  v3: number;
  v4: number;
}

export interface ChainVolume {
  points: ChainPoint[];
  coverageStart: string | null; // first UTC day the provider reports, "YYYY-MM-DD"
}

/** Read one protocol's USD volume out of a breakdown entry, tolerating either shape. */
function llamaValue(entry: Record<string, unknown>, name: string): number {
  const v = entry[name];
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // Some chains nest a second level (adapter → version). Sum it rather than drop it.
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .reduce<number>((a, x) => a + (typeof x === "number" && Number.isFinite(x) ? x : 0), 0);
  }
  return 0;
}

/** Chain-wide Uniswap v3 + v4 volume (USD) on Robinhood Chain, per day or week. */
export async function fetchChainVolume(g: Granularity): Promise<ChainVolume> {
  const body = (await getJsonCached(LLAMA_URL)) as {
    totalDataChartBreakdown?: [number, Record<string, unknown>][];
  };
  const rows = body.totalDataChartBreakdown ?? [];
  if (!rows.length) return { points: [], coverageStart: null };

  const v3 = bucketBy(rows.map(([ts, by]) => ({ ts, value: llamaValue(by, LLAMA_V3) })), g);
  const v4 = bucketBy(rows.map(([ts, by]) => ({ ts, value: llamaValue(by, LLAMA_V4) })), g);

  const keys = [...new Set([...v3.keys(), ...v4.keys()])].sort();
  if (!keys.length) return { points: [], coverageStart: null };

  const points = periodSpan(keys[0], keys[keys.length - 1], g).map((period) => ({
    period,
    v3: v3.get(period) ?? 0,
    v4: v4.get(period) ?? 0,
  }));
  const firstTs = Math.min(...rows.map(([ts]) => ts));
  return { points, coverageStart: dayKeyUTC(firstTs) };
}

// ─────────────────────────────────────────────────────────────────────────
// GeckoTerminal — per-pool daily OHLCV
// ─────────────────────────────────────────────────────────────────────────

const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/robinhood/pools";

/**
 * A pool to chart. `id` is what GeckoTerminal keys on: the pool ADDRESS for
 * Uniswap v3, and the 32-byte poolId for v4 (v4 pools live inside the singleton
 * PoolManager and have no address of their own).
 */
export interface PoolRef {
  id: string;
  label: string; // "CASHCAT / WETH 1%" — from our own symbols
  version: "v3" | "v4";
}

export interface PoolPoint {
  period: string;
  total: number;
  byPool: Record<string, number>; // pool id → USD volume that period
}

export interface PoolVolume {
  points: PoolPoint[];
  covered: PoolRef[]; // pools the provider had data for
  missing: PoolRef[]; // the provider does not index them (a durable fact)
  failed: PoolRef[]; // timeout or network — transient, and specific to that pool
  /**
   * Pools we never asked about, because the provider cut us off partway through.
   *
   * Kept apart from `failed` on purpose: "we asked and could not find out" and "we did
   * not ask" are different statements, and only the second one is fixed by waiting.
   */
  skipped: PoolRef[];
  /** True once the provider rate-limited us. The remaining pools are in `skipped`. */
  blocked: boolean;
  coverageStart: string | null;
}

type PoolFetch =
  | { kind: "ok"; days: DailyPoint[] }
  | { kind: "missing" } // provider genuinely has no such pool
  | { kind: "failed" } // timeout or network — this pool only
  | { kind: "blocked" }; // rate-limited — stop asking, for every remaining pool

/** Daily candles for one pool. */
async function fetchPoolDaily(pool: PoolRef): Promise<PoolFetch> {
  const url = `${GT_BASE}/${pool.id}/ohlcv/day?aggregate=1&limit=365&currency=usd`;
  let body: unknown;
  try {
    body = await getJsonCached(url, gtBucket);
  } catch (e) {
    // Only a 404 proves the pool isn't indexed. Everything else — a rate limit, a
    // timeout, a 5xx — is a failure to find out, which is a different statement to make
    // to the user, and a rate limit is different again: it is about every pool after
    // this one too.
    if (e instanceof BlockedError) return { kind: "blocked" };
    return { kind: e instanceof HttpError && e.status === 404 ? "missing" : "failed" };
  }
  const list = (body as { data?: { attributes?: { ohlcv_list?: number[][] } } })?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length === 0) return { kind: "missing" };
  // [ts, open, high, low, close, volume_usd]
  return { kind: "ok", days: list.map((row) => ({ ts: row[0], value: row[5] })) };
}

/**
 * Volume for the pools a wallet/position actually sits in, per day or week.
 *
 * Paced by a REQUESTS-PER-MINUTE budget, not by concurrency. Those are different
 * quantities and bounding the wrong one is what broke this: two in flight at ~200ms
 * each is 300-400 calls/minute against a limit of ~30, so a wallet in 60 pools was
 * reliably cut off partway through and every remaining pool reported unreadable.
 * A cache hit costs no budget, so the pacing is only ever paid on a cold day.
 *
 * And when the provider does cut us off, this STOPS. Continuing to ask cannot succeed —
 * the limit is per-minute and we are inside it — but it does deepen the block, so a
 * wallet with 200 pools would spend minutes making its own situation worse. What was
 * already read stays on the chart; the rest come back as `skipped`.
 */
export async function fetchPoolsVolume(
  pools: PoolRef[],
  g: Granularity,
  onProgress?: (done: number, total: number) => void,
): Promise<PoolVolume> {
  const covered: PoolRef[] = [];
  const missing: PoolRef[] = [];
  const failed: PoolRef[] = [];
  const perPool = new Map<string, Map<string, number>>();
  let firstTs = Infinity;
  let done = 0;
  let blocked = false;
  onProgress?.(0, pools.length);

  // Two workers still, but they are no longer what limits the rate — the shared bucket
  // inside getJson is. Their job now is only to keep a second request moving while the
  // first waits on the network.
  const WORKERS = 2;
  const queue = [...pools];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (blocked) { queue.unshift(p); return; } // put it back for the skipped tally
      const res = await fetchPoolDaily(p);
      if (res.kind === "ok") {
        covered.push(p);
        perPool.set(p.id, bucketBy(res.days, g));
        firstTs = Math.min(firstTs, ...res.days.map((d) => d.ts));
      } else if (res.kind === "missing") {
        missing.push(p);
      } else if (res.kind === "blocked") {
        // The pool that hit the wall was never read either, so it goes back on the queue
        // with the others we have not tried.
        blocked = true;
        queue.unshift(p);
        return;
      } else {
        failed.push(p);
      }
      onProgress?.(++done, pools.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, pools.length) }, worker));
  // Whatever is still queued was never asked about. Deduped because both workers can
  // push their in-hand pool back at once.
  const skipped = [...new Map(queue.map((p) => [p.id, p])).values()];

  const keys = [...new Set([...perPool.values()].flatMap((m) => [...m.keys()]))].sort();
  if (!keys.length) return { points: [], covered, missing, failed, skipped, blocked, coverageStart: null };

  const points = periodSpan(keys[0], keys[keys.length - 1], g).map((period) => {
    const byPool: Record<string, number> = {};
    let total = 0;
    for (const [id, m] of perPool) {
      const v = m.get(period) ?? 0;
      byPool[id] = v;
      total += v;
    }
    return { period, total, byPool };
  });

  return {
    points,
    covered,
    missing,
    failed,
    skipped,
    blocked,
    coverageStart: Number.isFinite(firstTs) ? dayKeyUTC(firstTs) : null,
  };
}
