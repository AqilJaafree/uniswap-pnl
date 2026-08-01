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
 * GET with a bounded retry on 429.
 *
 * GeckoTerminal's free tier is ~30 calls/minute and answers a burst with 429.
 * Without this, a rate-limited pool is indistinguishable from an unknown one and
 * the UI tells the user their pool "isn't indexed" — which is simply false.
 */
async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < 2) {
      await wait(1500 * (attempt + 1));
      continue;
    }
    throw new HttpError(res.status);
  }
}

/**
 * Cache a provider response for the rest of the tab session.
 *
 * Daily candles only change once a day, and GeckoTerminal's free tier allows ~30
 * calls/minute — re-analysing the same wallet, or flipping between day and week,
 * must not spend that budget again. Keyed by URL + UTC date so the cache
 * self-expires at the day boundary. A full/blocked sessionStorage is not an error:
 * fall through to the network.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function getJsonCached(url: string): Promise<unknown> {
  // Process-level memo first. It dedupes concurrent callers, and it is the ONLY
  // cache under Node (tsx smoke runs have no sessionStorage) — without it, asking
  // for the same pools at both granularities fetches everything twice and the
  // second round gets 429'd.
  const memo = inFlight.get(url);
  if (memo) return memo;

  const load = (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `vol:${today}:${url}`;
    try {
      const hit = sessionStorage.getItem(key);
      if (hit) return JSON.parse(hit) as unknown;
    } catch { /* storage unavailable — treat as a miss */ }

    const body = await getJson(url);
    try { sessionStorage.setItem(key, JSON.stringify(body)); } catch { /* over quota — fine */ }
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
  failed: PoolRef[]; // rate-limited or unreachable (transient — worth retrying)
  coverageStart: string | null;
}

type PoolFetch =
  | { kind: "ok"; days: DailyPoint[] }
  | { kind: "missing" } // provider genuinely has no such pool
  | { kind: "failed" }; // rate limit, timeout, network — say so, don't call it missing

/** Daily candles for one pool. */
async function fetchPoolDaily(pool: PoolRef): Promise<PoolFetch> {
  const url = `${GT_BASE}/${pool.id}/ohlcv/day?aggregate=1&limit=365&currency=usd`;
  let body: unknown;
  try {
    body = await getJsonCached(url);
  } catch (e) {
    // Only a 404 proves the pool isn't indexed. Everything else — 429 after
    // retries, a timeout, a 5xx — is a failure to find out, which is a different
    // statement to make to the user.
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
 * Pools are fetched two at a time: GeckoTerminal's free tier allows ~30 calls per
 * minute, and a wallet with many distinct pools would otherwise burn the budget in
 * one burst and get 429s that look like "pool not indexed".
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
  onProgress?.(0, pools.length);

  const CONCURRENCY = 2;
  const queue = [...pools];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const res = await fetchPoolDaily(p);
      if (res.kind === "ok") {
        covered.push(p);
        perPool.set(p.id, bucketBy(res.days, g));
        firstTs = Math.min(firstTs, ...res.days.map((d) => d.ts));
      } else if (res.kind === "missing") {
        missing.push(p);
      } else {
        failed.push(p);
      }
      onProgress?.(++done, pools.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pools.length) }, worker));

  const keys = [...new Set([...perPool.values()].flatMap((m) => [...m.keys()]))].sort();
  if (!keys.length) return { points: [], covered, missing, failed, coverageStart: null };

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
    coverageStart: Number.isFinite(firstTs) ? dayKeyUTC(firstTs) : null,
  };
}
