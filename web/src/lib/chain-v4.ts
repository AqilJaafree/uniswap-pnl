/**
 * Uniswap v4 browser data layer for Robinhood chain — mirrors chain.ts (v3) but
 * reads the v4 PoolManager / PositionManager / StateView. Reuses the shared viem
 * client and the pure engine + v4-decode helpers. Returns the same PositionPnL
 * shape as v3 so the UI is protocol-agnostic.
 */
import { parseAbiItem, getAddress, toHex, decodeEventLog, type Address } from "viem";
import {
  blockTimestamp, client, ownershipLogs, receiptOf, retry, toNftTransfer,
  type PositionPnL, type OwnerContext,
} from "./chain";
import { ownershipOf, heldAt } from "./ownership";
import { cachedLogRange, cachedPoint, cachedTokenMetaPersistent, isFinal } from "./chain-cache";
import { cachedByKey } from "./promise-cache";
import { tokenBucket } from "./token-bucket";
import {
  computePnL, amountsFromLiquidity, exitTxHash, isPriceableTick, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { isPermanentReadFailure } from "./read-failure";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlockOrNull, tickFromAmounts, nativeFlowForOwner, resolvePriceTicks,
  reconcileRemovalTicks,
  feesFromGrowth,
  nativeFlowWithoutTrace,
  type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
  type ActualReceivedByTx, type TraceCall,
} from "./v4-decode";

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const NATIVE = getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH);

const evErc20T = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const evSwap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const evInitialize = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const fnGetPPI = parseAbiItem("function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)");
const fnGetLiq = parseAbiItem("function getPositionLiquidity(uint256 tokenId) view returns (uint128)");
const fnSlot0 = parseAbiItem("function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)");
const fnFGI = parseAbiItem("function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 fg0, uint256 fg1)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");

interface V4Meta {
  poolKey: PoolKey; poolId: string;
  tickLower: number; tickUpper: number;
  dec0: number; dec1: number; sym0: string; sym1: string;
  liqNow: bigint; mintBlock: bigint;
}

const isNative = (a: string) => getAddress(a) === NATIVE;

/**
 * Authoritative pool tick at a block via StateView; null when that block's state is pruned.
 *
 * Cached, and that is worth more here than speed: this node prunes state after ~14 days,
 * so a tick that is readable today is gone next month. A successful read written to disk
 * keeps a position accurate long after the chain stopped being able to answer for it —
 * the cache makes the app MORE correct over time, not just faster.
 *
 * A null is remembered for the session but never persisted: a pruned block stays pruned
 * while the page is open, but a later visit must be free to try again (the answer can
 * come back if the read failed for any reason other than pruning).
 */
function slot0TickAt(meta: V4Meta, blockNumber: bigint): Promise<number | null> {
  return cachedPoint(
    `v4:tick:${meta.poolId}:${blockNumber}`,
    async () => {
      try {
        const s0 = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [meta.poolId as `0x${string}`], blockNumber })) as readonly [bigint, number, number, number];
        return Number(s0[1]);
      } catch (e) {
        // Only a genuinely unavailable block becomes a null. A rate limit or a broken
        // route is NOT "pruned", and recording it as one is what sent this position's
        // tick down the fallback chain to the pool's genesis — a tick the comment in
        // computePositionPnLV4 calls frequently wrong. Rethrow instead, and let the
        // per-position `retry` in analyzeWallet decide; a position that never recovers is
        // skipped and bannered rather than silently mispriced. See read-failure.ts.
        if (!isPermanentReadFailure(e)) throw e;
        return null; // pruned (>~14 days) — caller falls back to the Swap-derived tick
      }
    },
    (tick) => tick !== null && isFinal(blockNumber),
  );
}

async function tokenMeta(addr: string): Promise<{ dec: number; sym: string }> {
  // Native ETH short-circuits BEFORE the cache: it has no contract to call, so caching it
  // would only add an entry that can never be read from the chain anyway.
  if (isNative(addr)) return { dec: 18, sym: "ETH" };
  // Shared with the v3 path — a token that appears in both a v3 and a v4 position is read
  // once for the whole scan, not once per position per version. See token-meta.ts.
  return cachedTokenMetaPersistent(addr, async (a) => {
    const [dec, sym] = (await Promise.all([
      client.readContract({ address: getAddress(a), abi: [fnDecimals], functionName: "decimals" }),
      client.readContract({ address: getAddress(a), abi: [fnSymbol], functionName: "symbol" }),
    ])) as [number, string];
    return { dec, sym };
  });
}

async function fetchMeta(tokenId: bigint, mintBlock: bigint): Promise<V4Meta> {
  const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [tokenId] })) as unknown as [PoolKey, bigint];
  const poolKey = { currency0: res[0].currency0, currency1: res[0].currency1, fee: Number(res[0].fee), tickSpacing: Number(res[0].tickSpacing), hooks: res[0].hooks };
  const { tickLower, tickUpper } = unpackPositionInfo(BigInt(res[1]));
  const liqNow = (await client.readContract({ address: POSM, abi: [fnGetLiq], functionName: "getPositionLiquidity", args: [tokenId] })) as bigint;
  const [m0, m1] = await Promise.all([tokenMeta(poolKey.currency0), tokenMeta(poolKey.currency1)]);
  return { poolKey, poolId: computeV4PoolId(poolKey), tickLower, tickUpper, dec0: m0.dec, dec1: m1.dec, sym0: m0.sym, sym1: m1.sym, liqNow, mintBlock };
}

/**
 * Pool tick from the Swap stream, for ONE block, computed only when it is actually needed.
 *
 * This used to fetch the pool's whole Swap history up front, for every position, and hold
 * it. Measured on a 133-position wallet that is ~29,000 Swap logs per position — ~3.9
 * million objects — to answer `tickAtBlockOrNull` for one to four blocks each. It is also
 * fallback THREE: StateView and the implied-from-spend tick answer first for most
 * positions, and when they do, none of that work was ever read.
 *
 * So the expensive scan now sits behind a lazy `poolSwaps`, and what gets written to disk
 * is the resolved tick — one small number per (pool, mint, block) instead of the stream it
 * came from. A second visit answers from those and never fetches the stream at all.
 *
 * The scan starts AT the mint block, so no swap precedes a mint and this cannot price one.
 * Widening it backwards would be exact — a tick only moves on a swap, so the last swap
 * before a block IS that block's tick over a contiguous range — but it was measured at
 * 5-40% extra wall clock per position, for a fallback that ground truth now reaches first
 * anyway. On this RPC extra load is not free: positions that exhaust their retries land in
 * `skipped` and quietly vanish from the wallet total. If a mint ever does need it, widen
 * lazily, for the blocks left without a tick, rather than for every pool.
 *
 * That start block therefore belongs in the key: the same block resolves differently from
 * a window that began earlier, so a record written under another start must not answer here.
 */
function poolSwaps(meta: V4Meta, head: bigint): Promise<V4SwapPoint[]> {
  // Shared for the page across positions in the same pool, and projected to the three
  // fields anything reads — holding whole viem logs here is what once cost 4 GB. Not
  // persisted: it is the input, and the tick below is the answer worth keeping.
  return cachedByKey(`v4:swaps:${meta.poolId}:${meta.mintBlock}:${head}`, async () =>
    (await getLogsChunked((f, t) => client.getLogs({ address: PM, event: evSwap, args: { id: meta.poolId as `0x${string}` }, fromBlock: f, toBlock: t }), meta.mintBlock, head))
      .map((l) => ({ blockNumber: l.blockNumber!, logIndex: l.logIndex!, tick: Number((l.args as { tick: number }).tick) })));
}

/** Tick of the last Swap at-or-before `blockNumber`; null when none precedes it. */
function swapTickAt(meta: V4Meta, head: bigint, blockNumber: bigint): Promise<number | null> {
  return cachedPoint(
    `v4:swaptick:${meta.poolId}:${meta.mintBlock}:${blockNumber}`,
    async () => tickAtBlockOrNull(await poolSwaps(meta, head), blockNumber),
    (t) => t !== null && isFinal(blockNumber),
  );
}

/**
 * The pool's genesis tick — last resort, and frequently wrong, so it is only ever reached
 * when every other source has failed.
 *
 * Keyed on the POOL alone and persisted unconditionally: Initialize fires once, at a block
 * that can never be inside a reorg window by the time anything holds a position in it.
 * Null (no Initialize found) is NOT written down — that is a query that came back empty,
 * not a fact about the pool, and baking it in would make a genuine miss permanent.
 */
function poolInitTick(meta: V4Meta, head: bigint): Promise<number | null> {
  return cachedPoint(
    `v4:inittick:${meta.poolId}`,
    async () => {
      // Genesis-to-head, and the chunker splits on a query TIMEOUT as well as a result
      // cap — unsplit, a timeout here costs the position its last-resort tick.
      const logs = await getLogsChunked((f, t) => client.getLogs({ address: PM, event: evInitialize, args: { id: meta.poolId as `0x${string}` }, fromBlock: f, toBlock: t }), 0n, head);
      return logs.length ? Number((logs[0].args as { tick: number }).tick) : null;
    },
    (t) => t !== null,
  );
}

/**
 * Best-effort fee-growth-inside at a block; null when that block's state is pruned.
 *
 * Cached on the same terms, and for the same reason, as slot0TickAt: this is the read
 * whose failure sets `feesComplete: false`, so preserving a successful one outlives the
 * node's ~14-day retention and keeps a position's fees exact.
 */
function feeGrowthAt(meta: V4Meta, blockNumber: bigint): Promise<{ fg0: bigint; fg1: bigint } | null> {
  return cachedPoint(
    `v4:fgi:${meta.poolId}:${meta.tickLower}:${meta.tickUpper}:${blockNumber}`,
    async () => {
      try {
        const fgi = (await client.readContract({ address: SV, abi: [fnFGI], functionName: "getFeeGrowthInside", args: [meta.poolId as `0x${string}`, meta.tickLower, meta.tickUpper], blockNumber })) as readonly [bigint, bigint];
        return { fg0: fgi[0], fg1: fgi[1] };
      } catch (e) {
        // Same rule as slot0TickAt, and it matters more here: a null makes an OPEN
        // position's unclaimed fees exactly 0 (see the `feesComplete = false` branch in
        // computePositionPnLV4), so a momentary rate limit used to erase real earnings
        // from the headline and put them back on the next scan.
        if (!isPermanentReadFailure(e)) throw e;
        return null; // missing trie node (pruned) — fees for this segment become approximate
      }
    },
    (fg) => fg !== null && isFinal(blockNumber),
  );
}

/**
 * Every field of a pool-wide ModifyLiquidity log that anything downstream reads.
 *
 * Same reason as the Swap projection: the cached copy is what is kept alive for the page,
 * so it holds the eight fields that get used, not the whole viem log around them.
 */
interface ModifyPoint {
  blockNumber: bigint; logIndex: number; txHash: string;
  tickLower: number; tickUpper: number; liquidityDelta: bigint;
}

/** The same, plus the two fields that say WHICH position a pool-wide log belongs to. */
interface PoolModifyPoint extends ModifyPoint { sender: string; salt: string }

/**
 * One pool's ModifyLiquidity events, projected and shared for the page.
 *
 * Shared because every position in a pool issues the identical query; PROJECTED because
 * what is shared is also what is RETAINED, and a page holding whole viem logs for every
 * ModifyLiquidity in every pool a wallet touches is the same mistake that cost 4 GB on the
 * Swap path. `sender` and `salt` are carried only so the per-position filter can run.
 */
function poolModifies(poolId: string, from: bigint, to: bigint): Promise<PoolModifyPoint[]> {
  return cachedByKey(`v4:modifypool:${poolId}:${from}:${to}`, async () =>
    (await getLogsChunked((f, t) => client.getLogs({ address: PM, event: evModify, args: { id: poolId as `0x${string}` }, fromBlock: f, toBlock: t }), from, to))
      .map((l) => {
        const a = l.args as { sender: string; salt: string; tickLower: number; tickUpper: number; liquidityDelta: bigint };
        return {
          blockNumber: l.blockNumber!, logIndex: l.logIndex!, txHash: l.transactionHash!,
          sender: a.sender, salt: a.salt.toLowerCase(),
          tickLower: Number(a.tickLower), tickUpper: Number(a.tickUpper), liquidityDelta: a.liquidityDelta,
        };
      }));
}

/** All ModifyLiquidity events for one tokenId (join by poolId + salt + sender). */
async function fetchV4Lifecycle(tokenId: bigint, meta: V4Meta, head: bigint): Promise<{ raw: V4RawEvent[]; tsByBlock: Map<bigint, number> }> {
  const saltHex = toHex(tokenId, { size: 32 }).toLowerCase();
  // Keyed and stored PER POSITION, filtered before it is written.
  //
  // The query is necessarily pool-wide — ModifyLiquidity indexes the pool, not the token —
  // but a hot pool emits over thirteen thousand of them and this position owns three. What
  // used to be cached was the pool's copy, once per (pool, mint block), which is both
  // enormous and duplicated: the same pool appears under as many keys as it has mints.
  // Filtering inside the fetch means the record holds only this position's events, so a
  // revisit costs one narrow tail query and reads back a handful of rows.
  //
  // The pool-wide fetch itself is still shared for the page by `cachedByKey`, so positions
  // that were minted in the same block in the same pool issue it once between them.
  const mine = await cachedLogRange<ModifyPoint>(`v4:modify:${meta.poolId}:${tokenId}`, meta.mintBlock, head, async (from, to) =>
    (await poolModifies(meta.poolId, from, to))
      .filter((l) => getAddress(l.sender) === POSM && l.salt === saltHex)
      .map(({ sender: _s, salt: _t, ...keep }) => keep));

  const blocks = [...new Set(mine.map((l) => l.blockNumber))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => tsByBlock.set(bn, await blockTimestamp(bn))));

  const raw: V4RawEvent[] = mine.map((l) => ({
    blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.txHash,
    timestamp: tsByBlock.get(l.blockNumber)!,
    tickLower: l.tickLower, tickUpper: l.tickUpper, liquidityDelta: l.liquidityDelta,
  }));
  return { raw, tsByBlock };
}

/**
 * The explorer served a trace with no frames at all — see `cachedTraceCalls`. Its own
 * class so `retry` can tell it apart from an overloaded explorer: this one is a fact
 * about the index, and asking again 300 ms later only triples the load on a host that is
 * already behind.
 */
export class UnindexedTrace extends Error {}

/**
 * A settled tx's trace, remembered across page loads.
 *
 * An internal-transaction list for a mined tx is as immutable as its receipt, and it is
 * the single most expensive thing this app asks any third party for: one request per
 * page per tx, against a host that starts shedding load under fan-out. Caching it is
 * what keeps a re-analysis of the same wallet from re-earning the CORS errors that
 * prompted this.
 *
 * Finality comes from the tx's own block, on the same rule as receipts -- see
 * chain-cache.ts. A trace read inside the reorg window is used but not persisted.
 *
 * ZERO FRAMES IS REFUSED, not cached. Every tx that reaches here is a v4 position tx,
 * which gets to the PoolManager through the PositionManager -- so its trace has frames
 * by construction and an empty list can only mean the explorer has not indexed it. That
 * distinction is the whole ballgame for a NATIVE-ETH leg, which emits no log and is
 * therefore knowable ONLY from the trace: read as a flow of zero, an unindexed exit tells
 * `reconcileRemovalTicks` that the chain paid out nothing, which refutes a correct pool
 * tick (live 2026-08-26, #892396: +10.24% reported as -97.52%). Throwing routes it into
 * the `retry` and the missing-key protocol both callers already implement, and keeps the
 * empty answer out of the session cache AND out of IndexedDB, so a scan run after the
 * explorer catches up gets the real trace instead of a remembered hole.
 */
export function cachedTraceCalls(txHash: string, blockNumber: bigint | null): Promise<TraceCall[]> {
  return cachedPoint(
    `trace:${txHash}`,
    async () => {
      const calls = await fetchTraceCalls(txHash);
      if (calls.length === 0) throw new UnindexedTrace(`blockscout: no trace frames for ${txHash} — not indexed`);
      return calls;
    },
    () => blockNumber !== null && isFinal(blockNumber),
    // Disowns the empty traces builds before this one persisted — see cachedPoint.
    (calls) => calls.length > 0,
  );
}

/** Signed net movement of both pool currencies for the position owner, per tx (positive = received). */
type OwnerFlows = Map<string, { amount0: bigint; amount1: bigint }>;

/**
 * The explorer's rate budget.
 *
 * Blockscout advertises its own allowance in the response: `x-ratelimit-limit: 180`.
 * We aim under it, and halve on refusal, because the ceiling that matters is not the
 * published number but the point at which the backend starts shedding load -- measured,
 * that arrives as 500s and dropped connections well before any 429 does.
 *
 * The bucket also serves as the concurrency bound. `fetchNativeFlowsByTx` fans out with
 * `Promise.all` over every tx of a position, and that is per position: a wallet with
 * several native-ETH v4 positions used to put dozens of simultaneous requests on this
 * host. Nothing here caps that fan-out, so the pacing has to.
 */
/** Only the parts of a Bucket this module uses, so a test can supply a plain object. */
interface ExplorerGate { take(): Promise<void>; slow(): number; ok(): void }

let explorerGate: ExplorerGate = tokenBucket({ perMinute: 120, floorPerMinute: 30, burst: 4 });

/** Test seam: swap the budget so tests need not sit through real pacing. */
export function setExplorerGate(gate: ExplorerGate): void {
  explorerGate = gate;
}

/**
 * Trace frames for one tx, from Blockscout.
 *
 * This chain's RPC exposes neither `debug_traceTransaction` nor `trace_transaction`,
 * and a native-ETH leg emits no log, so the explorer is the only way to see it. Unlike
 * every `blockNumber`-pinned read here it is NOT subject to state pruning, which is
 * what makes it usable for positions of any age.
 *
 * Blockscout indexes internal transactions from 1 — the top-level call is absent, and
 * `nativeFlowForOwner` adds it back from the tx's own `value`.
 */
export async function fetchTraceCalls(txHash: string): Promise<TraceCall[]> {
  const out: TraceCall[] = [];
  let query = "";
  for (let page = 0; page < 20; page++) {
    await explorerGate.take();
    let res: Response;
    try {
      res = await fetch(`${ROBINHOOD_CHAIN.explorer}/api/v2/transactions/${txHash}/internal-transactions${query}`);
    } catch (e) {
      // No readable response at all. Measured under a 50-way burst, this explorer answers
      // with a mix of 200s, 500s, dropped connections, and the occasional response that
      // arrives WITHOUT its CORS header -- which the browser refuses to expose, so it
      // surfaces here as an opaque TypeError and in the console as "blocked by CORS
      // policy". It is overload, not a misconfigured server: the same endpoint is
      // perfectly CORS-clean when asked one at a time.
      explorerGate.slow();
      throw e;
    }
    // 429 is the documented limit; a 5xx from this explorer is what overload looks like
    // before the limit is reached. Both mean "ask less often", and both are worth the
    // retry the caller wraps this in -- losing a MINT tx's trace costs the implied tick.
    if (res.status === 429 || res.status >= 500) explorerGate.slow();
    if (!res.ok) throw new Error(`blockscout ${res.status} for ${txHash}`);
    // Counts toward widening the rate again — see Bucket.ok. A wallet scan makes hundreds
    // of these, so a rate that only ever falls is one that spends the whole scan at the
    // floor.
    explorerGate.ok();
    const body = (await res.json()) as {
      items?: { type?: string; from?: { hash?: string }; to?: { hash?: string } | null; value?: string; success?: boolean; error?: string | null }[];
      next_page_params?: Record<string, unknown> | null;
    };
    for (const it of body.items ?? []) {
      out.push({
        type: String(it.type ?? ""),
        from: String(it.from?.hash ?? ""),
        to: it.to?.hash ? String(it.to.hash) : null,
        // Throwing here is deliberate: the caller drops the whole tx, which degrades to
        // the fee-growth path. Coercing a bad value to 0 would silently understate.
        value: BigInt(it.value ?? "0"),
        success: it.success !== false && !it.error,
      });
    }
    const next = body.next_page_params;
    if (!next) return out;
    query = "?" + new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString();
  }
  throw new Error(`blockscout: too many internal-transaction pages for ${txHash}`);
}

/**
 * Net native-ETH the owner moved in each tx (positive = received). Missing key = unreadable.
 *
 * Retried, because one transient explorer hiccup is not a cheap failure: losing a MINT
 * tx's flow costs the implied tick, and with no swap preceding a mint the tick then falls
 * all the way through to the pool's genesis. Observed live — the same position resolved
 * correctly on four runs and fell back on a fifth. The fallback is flagged
 * (`tickComplete: false`) rather than silent, so this is about how often a correct answer
 * is reachable, not about hiding a wrong one.
 *
 * When the trace cannot be read at all, the half of the answer the tx itself evidences is
 * still kept — see `nativeFlowWithoutTrace` for why that is sound in one direction only.
 */
async function fetchNativeFlowsByTx(owner: Address, txs: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  await Promise.all(txs.map(async (tx) => {
    // The tx first, because its block decides whether the trace may be written down --
    // and because an already-cached trace then costs the explorer nothing at all.
    const t = await client.getTransaction({ hash: tx as `0x${string}` }).catch(() => null);
    if (!t) return; // not even the tx — nothing about this one is knowable
    try {
      const calls = await retry(() => cachedTraceCalls(tx, t.blockNumber), 3, (e) => !(e instanceof UnindexedTrace));
      out.set(tx, nativeFlowForOwner(owner, { from: t.from, value: t.value }, calls));
    } catch {
      // Unreadable trace. An inflow is unknowable without it, so the key is left absent
      // and the caller drops the tx whole; an outflow the tx's own `value` evidences is
      // kept, which is what holds a single-sided ETH mint's deposit together when chain
      // state is pruned and nothing else can pin its tick.
      const spent = nativeFlowWithoutTrace(owner, { from: t.from, value: t.value });
      if (spent !== null) out.set(tx, spent);
    }
  }));
  return out;
}

/**
 * Ground-truth token movement for the position owner in each of the position's txs,
 * decoded from ERC20 Transfers. Two consumers:
 *   • removals → tokens RECEIVED, the authoritative fee source (fee = received −
 *     geometric principal), correcting a fee-growth reconstruction that over/under-
 *     states fees for positions minted with the price outside their range;
 *   • mints → tokens SPENT, from which the true pool tick is recovered when the
 *     block's chain state has been pruned (see `tickFromAmounts`).
 *
 * An ERC20 leg is read from the tx's Transfer logs; a native-ETH leg emits none, so it
 * is read from the tx's trace instead (`fetchNativeFlowsByTx`). Native pairs used to be
 * refused outright here, which threw away the ERC20 leg as well and cost them BOTH
 * mechanisms: their fees silently became 0 (pruned fee-growth makes collect == decrease)
 * and their mint tick fell through to the pool's genesis tick.
 *
 * `owner` is whose side of each transfer counts. On the wallet path it is the wallet
 * being analyzed; it used to be inferred as the NFT's CURRENT holder, which silently
 * measured the buyer's cashflows whenever a position had changed hands.
 */
async function fetchOwnerFlowsByTx(
  meta: V4Meta,
  raw: V4RawEvent[],
  owner: Address,
): Promise<OwnerFlows | undefined> {
  const c0 = getAddress(meta.poolKey.currency0), c1 = getAddress(meta.poolKey.currency1);
  const native0 = isNative(c0), native1 = isNative(c1);

  const txs = [...new Set(raw.map((r) => r.txHash))];
  const nativeFlows = native0 || native1 ? await fetchNativeFlowsByTx(owner, txs) : undefined;
  const map: OwnerFlows = new Map();
  await Promise.all(txs.map(async (tx) => {
    // A tx whose native leg could not be read must be dropped WHOLE. Keeping just the
    // ERC20 side would look like a one-sided flow and fabricate both the fee and the
    // implied tick; dropping it degrades to the fee-growth path, which is merely coarse.
    if (nativeFlows && !nativeFlows.has(tx)) return;
    const receipt = await receiptOf(tx);
    let a0 = 0n, a1 = 0n;
    for (const log of receipt.logs) {
      const addr = getAddress(log.address);
      if (addr !== c0 && addr !== c1) continue;
      let d: { args: { from: string; to: string; value?: bigint } };
      try { d = decodeEventLog({ abi: [evErc20T], data: log.data, topics: log.topics }) as typeof d; }
      catch { continue; } // ERC721 Transfer (indexed tokenId) or other — not an ERC20 value transfer
      if (typeof d.args.value !== "bigint") continue;
      const to = getAddress(d.args.to), from = getAddress(d.args.from);
      const sign = to === owner ? 1n : from === owner ? -1n : 0n;
      if (sign === 0n) continue;
      if (addr === c0) a0 += sign * d.args.value; else a1 += sign * d.args.value;
    }
    // The native leg, which no log can carry.
    if (native0) a0 = nativeFlows!.get(tx)!;
    if (native1) a1 = nativeFlows!.get(tx)!;
    if (a0 !== 0n || a1 !== 0n) map.set(tx, { amount0: a0, amount1: a1 });
  }));
  return map.size ? map : undefined;
}

/** Txs where the owner only RECEIVED tokens (withdrawals + fee claims). */
function inflowsOf(flows: OwnerFlows | undefined): ActualReceivedByTx | undefined {
  if (!flows) return undefined;
  const m: ActualReceivedByTx = new Map();
  for (const [tx, v] of flows) {
    if (v.amount0 >= 0n && v.amount1 >= 0n && (v.amount0 > 0n || v.amount1 > 0n)) m.set(tx, v);
  }
  return m.size ? m : undefined;
}

/** Txs where the owner only SPENT tokens (clean deposits), returned as positive amounts. */
function outflowsOf(flows: OwnerFlows | undefined): ActualReceivedByTx | undefined {
  if (!flows) return undefined;
  const m: ActualReceivedByTx = new Map();
  for (const [tx, v] of flows) {
    if (v.amount0 <= 0n && v.amount1 <= 0n && (v.amount0 < 0n || v.amount1 < 0n)) m.set(tx, { amount0: -v.amount0, amount1: -v.amount1 });
  }
  return m.size ? m : undefined;
}

/** Within 1% — tolerance for the round-trip check on a recovered tick. */
function nearlyEqual(a: bigint, b: bigint): boolean {
  if (a === b) return true;
  const d = a > b ? a - b : b - a;
  const m = a > b ? a : b;
  return m > 0n && d * 100n <= m;
}

/**
 * Pool tick at each MINT block, recovered from the tokens the owner actually spent.
 *
 * Needed because `slot0TickAt` returns null once a block's state is pruned (~14 days
 * on this RPC) and the Swap fallback cannot help at a mint: swaps are only fetched
 * from `mintBlock` onward, so nothing precedes it. The old code then fell through to
 * the pool's GENESIS tick — which, when it sits on the opposite side of the range
 * from the real price, reconstructs the deposit in the wrong token entirely.
 *
 * Each recovered tick is validated by round-tripping it back through the geometry;
 * a tx that also swapped or bundled another position won't reproduce the amounts and
 * is rejected rather than trusted.
 */
function impliedMintTicks(sortedRaw: V4RawEvent[], meta: V4Meta, spent: ActualReceivedByTx | undefined): Map<bigint, number> {
  const out = new Map<bigint, number>();
  if (!spent) return out;
  for (const ev of sortedRaw) {
    if (ev.liquidityDelta <= 0n) continue; // mints only; a removal's flow also carries fees
    const gt = spent.get(ev.txHash);
    if (!gt) continue;
    const t = tickFromAmounts(gt.amount0, gt.amount1, ev.liquidityDelta, meta.tickLower, meta.tickUpper);
    if (t == null) continue;
    const geo = amountsFromLiquidity(ev.liquidityDelta, meta.tickLower, meta.tickUpper, t);
    if (!nearlyEqual(geo.amount0, gt.amount0) || !nearlyEqual(geo.amount1, gt.amount1)) continue;
    out.set(ev.blockNumber, t);
  }
  return out;
}

export async function computePositionPnLV4(tokenId: bigint, mintBlock: bigint, ctx?: OwnerContext): Promise<PositionPnL> {
  const meta = await fetchMeta(tokenId, mintBlock);
  const num = pickNumeraire(meta.poolKey.currency0, meta.poolKey.currency1, meta.sym0, meta.sym1);
  if (!num) throw new Error(`unsupported v4 pair ${meta.sym0}/${meta.sym1}`);

  // The SCAN's head when there is one, otherwise this position's own read. Every wide
  // getLogs below needs a concrete upper bound to split on, and taking it from ctx means
  // every position in a wallet is read as of the same block instead of each drifting a few
  // blocks apart — which also makes the pool-log caching above shareable at all, since the
  // head is part of the in-scan key. (It is deliberately NOT part of the on-disk key: a
  // stored range is meant to be extended by the next visit's newer head, not orphaned by
  // it — see chain-cache.ts.)
  const head = ctx?.head ?? await client.getBlockNumber();

  const lifecycle = await fetchV4Lifecycle(tokenId, meta, head);
  const tsByBlock = lifecycle.tsByBlock;
  let raw = lifecycle.raw;
  if (raw.length === 0) throw new Error(`no v4 liquidity events for #${tokenId}`);

  // Who these cashflows belong to. Without a wallet context (the single-tx path) fall
  // back to the NFT's current holder, which is the best available guess there.
  // The scan's prefetched Transfer history for this NFT when it has one — analyzeWallet
  // fetches every enumerated v4 position's in a couple of batched queries. Without this
  // the prefetch was paid for and then ignored, and this query ran per position anyway.
  //
  // The prefetch covers 0..head rather than mintBlock..head; that is a superset, and a
  // superset is exactly what ownershipOf wants, since it walks transfers from the start.
  //
  // The fallback goes through the SAME cache records as that prefetch — same helper, same
  // key, same 0..head window — so a position looked up on its own reuses and extends what
  // an earlier wallet scan already stored for it. That also settles the window question:
  // this used to start at mintBlock, which cannot contain a transfer the wider scan does
  // not, so widening it changes no answer and buys the shared record.
  const prefetchedNft = ctx?.transfers?.get(POSM)?.get(tokenId);
  const nftTransfers = prefetchedNft
    ?? ((await ownershipLogs(POSM, [tokenId], head)).get(tokenId) ?? []).map(toNftTransfer);
  let soldAt: bigint | undefined;
  let heldNow = true;
  let owner: Address | undefined = ctx?.owner;
  if (ctx) {
    const own = ownershipOf(nftTransfers, ctx.owner);
    // No window at all means the Transfer log never shows this wallet receiving it —
    // don't truncate on a guess, just read the position as the chain sees it.
    if (own.windows.length) {
      raw = raw.filter((r) => heldAt(own, r.blockNumber));
      if (raw.length === 0) throw new Error(`#${tokenId} had no liquidity activity while ${ctx.owner} held it`);
      heldNow = own.heldNow;
      soldAt = own.soldAt ?? undefined;
    }
  } else if (nftTransfers.length) {
    // Latest transfer wins — the list is in chain order either way: a raw getLogs returns
    // it so, and cachedLogsById sorts every record by block then logIndex.
    owner = getAddress(nftTransfers[nftTransfers.length - 1].to as `0x${string}`);
  }

  const sortedRaw = [...raw].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  // Ground-truth token movement per tx. Inflows (removals) give authoritative fees;
  // outflows (mints) give the true tick when chain state is pruned. Undefined for
  // native-ETH pairs → fee-growth / swap fallbacks.
  const ownerFlows = owner ? await fetchOwnerFlowsByTx(meta, raw, owner) : undefined;
  const actualReceived = inflowsOf(ownerFlows);
  const actualSpent = outflowsOf(ownerFlows);

  const impliedTicks = impliedMintTicks(sortedRaw, meta, actualSpent);
  const eventBlocks = [...new Set(raw.map((r) => r.blockNumber))];
  const stateByBlock = new Map<bigint, BlockState>();
  let tickComplete = true;
  await Promise.all(eventBlocks.map(async (bn) => {
    const [fg, liveTick] = await Promise.all([feeGrowthAt(meta, bn), slot0TickAt(meta, bn)]);
    // A ModifyLiquidity event carries no tick, so the pool tick must be sourced. In
    // order of trust:
    //   1. StateView at the block — authoritative, but null once the block is pruned.
    //   2. The tick implied by the tokens the mint actually moved — archive-free and
    //      structurally incapable of landing on the wrong side of the range.
    //   3. The last Swap at-or-before the block.
    //   4. The pool's genesis tick — a last resort that is frequently WRONG; flag the
    //      position rather than present a confident number built on it.
    const implied = impliedTicks.get(bn) ?? null;
    // Sources 3 and 4 are the expensive ones — a pool-wide Swap scan and a genesis-to-head
    // Initialize scan — so they are asked for only once the two cheap ones have both
    // failed, which for most positions never happens.
    let tick = liveTick ?? implied;
    if (tick == null) {
      const swapTick = await swapTickAt(meta, head, bn);
      if (swapTick == null) tickComplete = false;
      tick = swapTick ?? (await poolInitTick(meta, head)) ?? 0;
    }
    stateByBlock.set(bn, { tick, fg0: fg?.fg0 ?? null, fg1: fg?.fg1 ?? null });
  }));

  // Last line of defence on the tick: whatever source won above, a REMOVAL's tick cannot
  // imply more principal than the chain actually paid out, because the payout is that
  // principal plus fees. Live, #134874's exit fell through to the pool's genesis tick,
  // which sat below the range — the geometry claimed 3.4x the ETH that was paid and lost
  // the token1 leg entirely, so the deposit came back a second time as "fees" and a
  // 353-second round trip read +591%. The payout refutes that tick and supplies a better
  // one; see reconcileRemovalTicks for why it errs toward zero fees.
  if (reconcileRemovalTicks(sortedRaw, stateByBlock, actualReceived, meta.tickLower, meta.tickUpper) > 0) {
    tickComplete = false;
  }

  // Live liquidity says the POSITION is open; it says nothing about whether this wallet
  // still owns it. A sold position is closed for its seller and must not be marked to
  // market — that would credit them a payout they never received.
  const open = meta.liqNow > 0n && heldNow;
  const built = buildV4Events(raw, stateByBlock, meta.dec0, meta.dec1, tokenId, actualReceived);
  const events: LiquidityEvent[] = built.events;
  let feesComplete = built.feesComplete;

  const priceBasis: PositionPnL["priceBasis"] = open ? "mark-to-market" : "in-range";
  // Whose tick anchors the headline price. Read AFTER the limit sanitation below, so a
  // pool sitting at its numerical floor doesn't anchor the position at 1e-39.
  let priceBlock: bigint;

  if (open) {
    const nowBlock = await client.getBlockNumber();
    const nowTs = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    // current tick/price + fee-growth from HEAD state (never pruned)
    const s0 = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [meta.poolId as `0x${string}`], blockNumber: nowBlock })) as readonly [bigint, number, number, number];
    const nowTick = Number(s0[1]);
    const nowFg = await feeGrowthAt(meta, nowBlock);
    stateByBlock.set(nowBlock, { tick: nowTick, fg0: nowFg?.fg0 ?? null, fg1: nowFg?.fg1 ?? null });
    tsByBlock.set(nowBlock, nowTs);
    priceBlock = nowBlock;

    // synthetic MTM: current principal + unclaimed fees since last checkpoint
    const lastBlock = sortedRaw[sortedRaw.length - 1].blockNumber;
    const lastFg = stateByBlock.get(lastBlock)!;
    let feeNow0 = 0n, feeNow1 = 0n;
    if (nowFg && lastFg.fg0 != null && lastFg.fg1 != null) {
      // Same wrapping subtraction as every other segment — see feesFromGrowth. This is
      // the site that produced v4#947153's -5.86e33: an OPEN position re-reads fee growth
      // at the head on every scan, so the unwrapped delta moved with the tick and the
      // headline moved with it.
      feeNow0 = feesFromGrowth(meta.liqNow, nowFg.fg0, lastFg.fg0);
      feeNow1 = feesFromGrowth(meta.liqNow, nowFg.fg1, lastFg.fg1);
    } else { feesComplete = false; }
    const cur = amountsFromLiquidity(meta.liqNow, meta.tickLower, meta.tickUpper, nowTick);
    events.push(
      { kind: "decrease", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0, amount1: cur.amount1 },
      { kind: "collect", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0 + feeNow0, amount1: cur.amount1 + feeNow1 },
    );
  } else {
    priceBlock = sortedRaw[sortedRaw.length - 1].blockNumber;
  }

  // A swap that exhausts a pool's last liquidity leaves it AT the AMM's price limit —
  // tick MIN_TICK / MAX_TICK - 1 — and it stays there until someone trades it back. That
  // is not a price, and dividing by it turns any amount of the other token into a
  // headline of ~1e43 (v4 #537173: 32,595 WOOF of fees on a 0.086 Ξ position). Price
  // those blocks from the pool's last real trade instead; the raw tick still drives the
  // withdrawal geometry, which at the limit is correct. Fetching the swap history is the
  // expensive part, so it is asked for only when some block actually sits at the limit.
  if ([...stateByBlock.values()].some((st) => !isPriceableTick(st.tick))) {
    const swaps = await poolSwaps(meta, head).catch(() => [] as V4SwapPoint[]);
    if (resolvePriceTicks(stateByBlock, swaps, meta.tickLower, meta.tickUpper) > 0) tickComplete = false;
  }
  const anchor = stateByBlock.get(priceBlock)!;
  const priceT1perT0 = tickToPrice(anchor.priceTick ?? anchor.tick, meta.dec0, meta.dec1);

  const price: PriceFeed = buildV4PriceFeed(stateByBlock, tsByBlock, num.anchorIsToken0, meta.dec0, meta.dec1);

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  // Same tx set `fetchOwnerFlowsByTx` already read — served from the cache, not refetched.
  const gasWei = (await Promise.all(txHashes.map(receiptOf)))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: meta.sym0, symbol1: meta.sym1, decimals0: meta.dec0, decimals1: meta.dec1, feeUnits: meta.poolKey.fee };
  // Gas is native ETH. Keep net PRE-gas; the UI prices gas via the ETH/USD rate so
  // it isn't dropped to 0 on a USD pair (e.g. PONS/USDG) that has no WETH leg.
  const gasEth = Number(gasWei) / 1e18;
  const result = computePnL(events, pair, price);

  return {
    tokenId, sym0: meta.sym0, sym1: meta.sym1, fee: meta.poolKey.fee,
    token0: meta.poolKey.currency0, token1: meta.poolKey.currency1, poolId: meta.poolId,
    tickLower: meta.tickLower, tickUpper: meta.tickUpper, open,
    numeraire: num.symbol, numeraireKind: num.kind, version: "v4", feesComplete, tickComplete,
    priceT1perT0, priceBasis, txHashes, soldAt, exitTx: exitTxHash(events), gasEth, result,
  };
}
