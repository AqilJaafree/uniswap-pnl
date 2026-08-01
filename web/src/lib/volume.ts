/**
 * Weekly swap-volume data layer.
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
 * Both also start at their own coverage date (DefiLlama ≈ 2026-06-26; GeckoTerminal
 * at pool creation), which is later than the chain's genesis. Callers surface
 * `coverageStart` rather than letting a short series read as a quiet week.
 */

// ─────────────────────────────────────────────────────────────────────────
// Pure week helpers
// ─────────────────────────────────────────────────────────────────────────

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/**
 * "YYYY-MM-DD" of the Monday starting the UTC week `tsSec` falls in.
 *
 * UTC, not local: both providers bucket their daily candles on UTC boundaries, so
 * re-bucketing them in local time would shift a day's volume into the wrong week
 * for any reader west of UTC. (The realized-PnL calendar keys on LOCAL days — it
 * buckets our own on-chain timestamps, where the user's day is the right frame.)
 */
export const weekKeyUTC = (tsSec: number): string => {
  const d = new Date(tsSec * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
};

/** Unix seconds at the start of a "YYYY-MM-DD" week key. */
export const weekStartSec = (weekKey: string): number => {
  const [y, m, d] = weekKey.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
};

/** "Jul 27 → Aug 02" — the inclusive day span a week key covers. */
export function weekLabel(weekKey: string): string {
  const start = weekStartSec(weekKey) * 1000;
  const end = start + 6 * 86400 * 1000;
  const f = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
  return `${f(start)} → ${f(end)}`;
}

/**
 * Every week key from `first` to `last` inclusive.
 *
 * Providers omit days with no volume, so a naive group-by silently closes the gap
 * and draws two non-adjacent weeks side by side. Filling the span keeps the x-axis
 * a real time axis: a zero week renders as zero, not as absent.
 */
export function weekSpan(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = weekStartSec(first); t <= weekStartSec(last); t += 7 * 86400) {
    out.push(weekKeyUTC(t));
  }
  return out;
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

export interface DailyPoint {
  ts: number; // unix seconds
  value: number;
}

/** Sum daily points into UTC weeks. Non-finite and negative values are dropped. */
export function bucketWeekly(days: DailyPoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of days) {
    if (!Number.isFinite(d.value) || d.value < 0) continue;
    const k = weekKeyUTC(d.ts);
    out.set(k, (out.get(k) ?? 0) + d.value);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared fetch plumbing
// ─────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 12_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Cache a provider response for the rest of the tab session.
 *
 * Daily candles only change once a day, and GeckoTerminal's free tier allows ~30
 * calls/minute — re-analysing the same wallet twice must not spend that budget
 * twice. Keyed by URL + UTC date so the cache self-expires at the day boundary.
 * A full/blocked sessionStorage is not an error: fall through to the network.
 */
async function getJsonCached(url: string): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `vol:${today}:${url}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit) as unknown;
  } catch { /* storage unavailable — treat as a miss */ }

  const body = await getJson(url);
  try { sessionStorage.setItem(key, JSON.stringify(body)); } catch { /* over quota — fine */ }
  return body;
}

// ─────────────────────────────────────────────────────────────────────────
// DefiLlama — chain-wide Uniswap V3 / V4
// ─────────────────────────────────────────────────────────────────────────

const LLAMA_URL =
  "https://api.llama.fi/overview/dexs/Robinhood%20Chain?excludeTotalDataChart=true";

/** DefiLlama's display names for the two adapters we chart. */
const LLAMA_V3 = "Uniswap V3";
const LLAMA_V4 = "Uniswap V4";

export interface ChainWeek {
  week: string;
  v3: number;
  v4: number;
}

export interface ChainVolume {
  weeks: ChainWeek[];
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

/** Chain-wide Uniswap v3 + v4 weekly volume (USD) on Robinhood Chain. */
export async function fetchChainWeekly(): Promise<ChainVolume> {
  const body = (await getJsonCached(LLAMA_URL)) as {
    totalDataChartBreakdown?: [number, Record<string, unknown>][];
  };
  const rows = body.totalDataChartBreakdown ?? [];
  if (!rows.length) return { weeks: [], coverageStart: null };

  const v3 = bucketWeekly(rows.map(([ts, by]) => ({ ts, value: llamaValue(by, LLAMA_V3) })));
  const v4 = bucketWeekly(rows.map(([ts, by]) => ({ ts, value: llamaValue(by, LLAMA_V4) })));

  const keys = [...new Set([...v3.keys(), ...v4.keys()])].sort();
  if (!keys.length) return { weeks: [], coverageStart: null };

  const weeks = weekSpan(keys[0], keys[keys.length - 1]).map((week) => ({
    week,
    v3: v3.get(week) ?? 0,
    v4: v4.get(week) ?? 0,
  }));
  const firstTs = Math.min(...rows.map(([ts]) => ts));
  return { weeks, coverageStart: new Date(firstTs * 1000).toISOString().slice(0, 10) };
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
  label: string; // "CASHCAT / WETH 1%" — provider name, falls back to our symbols
  version: "v3" | "v4";
}

export interface PoolWeek {
  week: string;
  total: number;
  byPool: Record<string, number>; // pool id → USD volume that week
}

export interface PoolVolume {
  weeks: PoolWeek[];
  covered: PoolRef[]; // pools the provider had data for
  missing: PoolRef[]; // pools it didn't (charted as absent, never as zero)
  coverageStart: string | null;
}

/** Daily candles for one pool. `null` when the provider doesn't know it. */
async function fetchPoolDaily(pool: PoolRef): Promise<DailyPoint[] | null> {
  const url = `${GT_BASE}/${pool.id}/ohlcv/day?aggregate=1&limit=365&currency=usd`;
  let body: unknown;
  try {
    body = await getJsonCached(url);
  } catch {
    return null; // 404 (unknown pool) or 429 (rate limited) — caller reports it as missing
  }
  const list = (body as { data?: { attributes?: { ohlcv_list?: number[][] } } })?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return null;
  // [ts, open, high, low, close, volume_usd]
  return list.map((row) => ({ ts: row[0], value: row[5] }));
}

/**
 * Weekly USD volume for the pools a wallet/position actually sits in.
 *
 * Pools are fetched two at a time: GeckoTerminal's free tier allows ~30 calls per
 * minute, and a wallet with many distinct pools would otherwise burn the budget in
 * one burst and get 429s that look like "pool not indexed".
 */
export async function fetchPoolsWeekly(
  pools: PoolRef[],
  onProgress?: (done: number, total: number) => void,
): Promise<PoolVolume> {
  const covered: PoolRef[] = [];
  const missing: PoolRef[] = [];
  const perPool = new Map<string, Map<string, number>>();
  let firstTs = Infinity;
  let done = 0;
  onProgress?.(0, pools.length);

  const CONCURRENCY = 2;
  const queue = [...pools];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const daily = await fetchPoolDaily(p);
      if (daily && daily.length) {
        covered.push(p);
        perPool.set(p.id, bucketWeekly(daily));
        firstTs = Math.min(firstTs, ...daily.map((d) => d.ts));
      } else {
        missing.push(p);
      }
      onProgress?.(++done, pools.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pools.length) }, worker));

  const keys = [...new Set([...perPool.values()].flatMap((m) => [...m.keys()]))].sort();
  if (!keys.length) return { weeks: [], covered, missing, coverageStart: null };

  const weeks = weekSpan(keys[0], keys[keys.length - 1]).map((week) => {
    const byPool: Record<string, number> = {};
    let total = 0;
    for (const [id, m] of perPool) {
      const v = m.get(week) ?? 0;
      byPool[id] = v;
      total += v;
    }
    return { week, total, byPool };
  });

  return {
    weeks,
    covered,
    missing,
    coverageStart: Number.isFinite(firstTs) ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null,
  };
}
