/**
 * Browser data layer — same logic as the CLI live.ts, but returns structured
 * data instead of printing. Talks to the same-origin `/rpc` proxy (see
 * server.mjs), which does public-first → paid spillover and hides the paid key.
 * Override with VITE_RPC_URL at build time if needed.
 */
import { createPublicClient, http, defineChain, parseAbiItem, parseEventLogs, getAddress, isAddress, type Address, type Transport } from "viem";
import {
  computePnL, closedExitPrice, buildImpliedPriceFeed, exitTxHash, amountsFromLiquidity, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";
import { pickNumeraire, numerairePricePoint, type NumeraireKind } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { laned, laneUrl } from "./rpc-lane";
import { ownershipOf, heldAt, type NftTransfer } from "./ownership";
import { chunkIds } from "./transfers";
import { mapPool } from "./pool";
import {
  cachedBlockTimestamp, cachedLogRange, cachedLogsById, cachedReceipt,
  cachedTokenMetaPersistent, noteHead,
} from "./chain-cache";
import { computePositionPnLV4 } from "./chain-v4";
import type { PoolRef } from "./volume";

// RPC endpoint. Browser: same-origin ABSOLUTE /rpc proxy — viem's http() can't
// parse a relative path ("/rpc" → new URL() throws) and silently falls back to
// the chain's default rpcUrl (the public RPC) and its broken CORS, so resolve
// /rpc against the current origin. Node (tsx smoke/repro): import.meta.env is
// undefined, window is undefined — use the RPC_URL env override, else the
// public RPC directly. Spillover is server-side, so keep client retries low.
const VITE_RPC = (import.meta.env && import.meta.env.VITE_RPC_URL) || "";
// Access `process` as a property of globalThis (cast) — the web build has no
// @types/node, so referencing the bare `process` global fails tsc on Railway's
// isolated install (TS2580); this shape-cast compiles without it.
const NODE_RPC =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RPC_URL ||
  ROBINHOOD_CHAIN.rpcUrl;
const RPC_URL =
  VITE_RPC ||
  (typeof window !== "undefined" ? new URL("/rpc", window.location.origin).toString() : NODE_RPC);

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.chainId,
  name: "Robinhood Chain",
  nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
  // Point the default at the proxy too, so any viem fallback still avoids the
  // public RPC's broken CORS (never call ROBINHOOD_CHAIN.rpcUrl from the browser).
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
});
/**
 * Cap concurrent JSON-RPC requests.
 *
 * `analyzeWallet` fans out hard — every position reads logs, receipts and block
 * timestamps, mostly via Promise.all — and the public RPC answers heavy parallel
 * load with timeouts rather than backpressure. Unthrottled, whole positions fail
 * their retries and land in `skipped`, so a wallet's headline total silently
 * under-reports. Queueing turns a correctness bug into a latency cost.
 *
 * MEASURED, on the 232-position wallet, 240s budget each, same endpoint, each run
 * gated on the endpoint answering fast twice first:
 *
 *   positions=1  inflight=4    115 pos   2.09 s/pos    0 x 429
 *   positions=3  inflight=8    137 pos   1.75 s/pos    0 x 429   <- current
 *   positions=6  inflight=12    48 pos   5.00 s/pos   46 x 429
 *
 * The jump to 6/12 does not buy throughput, it buys rate-limiting, and every 429 costs a
 * retry — spillover to the paid endpoint does not rescue that, because the retry has
 * already been paid by the time it happens. 3/8 sits below that cliff.
 *
 * If you raise these again, judge it on POSITIONS COMPLETED and the 429 COUNT. Do NOT
 * judge it on requests-per-position: that metric is confounded by which positions the
 * budget happened to reach. This wallet is 112 v3 positions and then 120 v4, and only the
 * v3 lifecycle is batched, so a faster run reaches more v4 positions and its
 * requests-per-position RISES even though nothing got worse.
 */
const MAX_INFLIGHT = 8;

/**
 * How many POSITIONS are computed at once.
 *
 * THREE. Six was tried first and halved throughput by driving the public node into
 * rate-limiting (see the table above); one was the safe fallback while call volume was
 * still 13.3 requests per position. Batching the ownership and lifecycle queries and
 * caching token metadata cut that to ~7 for a v3 position, which is what made a middle
 * setting viable: the same concurrency against half the requests.
 *
 * The remaining cost is LATENCY, not volume — at 7 calls a position and ~0.7s a call,
 * what is left is round trips, which is why this knob moved the clock when cutting
 * requests barely did. The next real win is batching the v4 lifecycle the way the v3 one
 * already is; half of a full scan is still unbatched v4 work.
 */
const POSITION_CONCURRENCY = 3;
let inflight = 0;
const waiting: (() => void)[] = [];
function acquireSlot(): Promise<void> {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise<void>((resolve) => waiting.push(() => { inflight++; resolve(); }));
}
function releaseSlot(): void {
  inflight--;
  waiting.shift()?.();
}

/** Wrap a transport so every request passes through the concurrency gate. */
function throttle(transport: Transport): Transport {
  return (params) => {
    const t = transport(params);
    const request: typeof t.request = async (...args) => {
      await acquireSlot();
      try { return await t.request(...args); } finally { releaseSlot(); }
    };
    return { ...t, request };
  };
}

/**
 * The same proxy, tagged for the wallet lane. The PROXY decides what that resolves to
 * (see WALLET_RPC_URL in netlify/edge-functions/rpc.ts) — the browser never learns the
 * endpoint, which is the point: an Alchemy URL's path is an API key and the bundle is
 * public. Locally, where RPC_URL points straight at an upstream, the parameter is inert.
 */
const LANE_URL = laneUrl(RPC_URL);

export const client = createPublicClient({
  chain: robinhoodChain,
  // eth_getLogs goes out on the wallet lane, everything else on the ordinary one. The
  // split is by METHOD rather than by call site so a new heavy caller cannot forget it —
  // see rpc-lane.ts for why getLogs is the call that matters. THROTTLE WRAPS BOTH: the
  // concurrency gate exists because this endpoint answers heavy parallel load with
  // timeouts rather than backpressure, and splitting the lanes must not double the fan-out
  // the gate was measured against.
  transport: throttle(
    laned(
      http(RPC_URL, { retryCount: 2, retryDelay: 300 }),
      http(LANE_URL, { retryCount: 2, retryDelay: 300 }),
    ),
  ),
});

export const retry = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
};
export const EXPLORER = ROBINHOOD_CHAIN.explorer;

const NPM = getAddress(ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager);
const FACTORY = getAddress(ROBINHOOD_CHAIN.uniswapV3.factory);
const POSM_V4 = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);

const evIncrease = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evDecrease = parseAbiItem("event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evCollect = parseAbiItem("event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)");
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const fnPositions = parseAbiItem("function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 f0, uint256 f1, uint128 owed0, uint128 owed1)");
const fnGetPool = parseAbiItem("function getPool(address,address,uint24) view returns (address)");
const fnSlot0 = parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)");
const fnLiquidity = parseAbiItem("function liquidity() view returns (uint128)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");

/**
 * A block's timestamp. Every lifecycle event needs one, most of a wallet's events share
 * blocks with each other, and a block's timestamp never changes once it is settled — so
 * this is the single highest-volume thing a scan can stop re-asking for. Exported shape
 * kept trivial so chain-v4.ts uses the same records.
 */
export const blockTimestamp = (blockNumber: bigint): Promise<number> =>
  cachedBlockTimestamp(blockNumber, async (bn) => Number((await client.getBlock({ blockNumber: bn })).timestamp));

/** A transaction receipt, remembered across page loads once its block has settled. */
export const receiptOf = (hash: string) =>
  cachedReceipt(hash, (h) => client.getTransactionReceipt({ hash: h as `0x${string}` }));

/** One token's immutable metadata, straight from the chain. Wrapped by cachedTokenMeta. */
async function readTokenMeta(address: string): Promise<{ dec: number; sym: string }> {
  const [dec, sym] = (await Promise.all([
    client.readContract({ address: address as Address, abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: address as Address, abi: [fnSymbol], functionName: "symbol" }),
  ])) as [number, string];
  return { dec, sym };
}

const sqrtToPrice = (sqrtX96: bigint, dec0: number, dec1: number) => {
  const sp = Number(sqrtX96) / 2 ** 96;
  return sp * sp * 10 ** (dec0 - dec1);
};

const WETH_ADDR = getAddress(ROBINHOOD_CHAIN.tokens.WETH);
const USDG_ADDR = getAddress(ROBINHOOD_CHAIN.tokens.USDG);

/**
 * Live ETH/USD from the most-liquid WETH/USDG v3 pool on Robinhood Chain — an
 * on-chain, archive-free, CORS-open source (same RPC the app already uses), so no
 * external price API. Returns null if no WETH/USDG pool has liquidity.
 */
export async function fetchEthUsd(): Promise<number | null> {
  const wethIsToken0 = WETH_ADDR.toLowerCase() < USDG_ADDR.toLowerCase();
  const dec0 = wethIsToken0 ? 18 : ROBINHOOD_CHAIN.tokens.USDG_DECIMALS;
  const dec1 = wethIsToken0 ? ROBINHOOD_CHAIN.tokens.USDG_DECIMALS : 18;
  let best: { liq: bigint; price: number } | null = null;
  for (const fee of [100, 500, 3000]) {
    try {
      const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [WETH_ADDR, USDG_ADDR, fee] })) as Address;
      if (pool === "0x0000000000000000000000000000000000000000") continue;
      const [s0, liq] = (await Promise.all([
        client.readContract({ address: pool, abi: [fnSlot0], functionName: "slot0" }),
        client.readContract({ address: pool, abi: [fnLiquidity], functionName: "liquidity" }),
      ])) as unknown as [readonly [bigint, number], bigint];
      if (liq <= 0n) continue; // ignore empty tiers (stale price)
      const t1perT0 = sqrtToPrice(s0[0], dec0, dec1);
      const ethUsd = wethIsToken0 ? t1perT0 : 1 / t1perT0; // USDG per whole WETH
      if (Number.isFinite(ethUsd) && ethUsd > 0 && (!best || liq > best.liq)) best = { liq, price: ethUsd };
    } catch { /* skip this tier */ }
  }
  return best?.price ?? null;
}

export type { NumeraireKind };

/**
 * Who the position is being analyzed FOR, plus the head block every ownership scan
 * splits against.
 *
 * Absent (the single-transaction path, which names no wallet) the position is read as
 * the chain sees it: whole lifecycle, current holder. Present, it is read as that
 * wallet's own cashflows — see ownership.ts.
 */
export interface OwnerContext {
  owner: Address;
  head: bigint;
  /**
   * Every enumerated position's ERC-721 Transfer history, fetched ONCE for the whole scan
   * and keyed by tokenId — see transfers.ts for why. Absent on the single-transaction
   * path, which names one position and has nothing to batch; restrictToOwner then falls
   * back to querying for the one id it was given.
   *
   * An id present with an EMPTY array means "asked, and the chain has no Transfer log for
   * it" — which restrictToOwner reads as "cannot establish ownership". An id MISSING from
   * the map means "not prefetched", which is a different thing and is queried for.
   */
  transfers?: Map<Address, Map<bigint, NftTransfer[]>>;
  /**
   * Every enumerated v3 position's lifecycle logs, fetched once for the scan. Absent on
   * the single-transaction path; fetchLifecycle then queries for the one id it was given.
   */
  lifecycle?: Map<bigint, LifecycleLogs>;
}

export interface PositionPnL {
  tokenId: bigint;
  version: "v3" | "v4";
  sym0: string; sym1: string; fee: number;
  token0: string; token1: string; // pool currencies — identify the pool for volume lookups
  poolId?: string; // v4 only: PoolManager poolId (v4 pools have no address of their own)
  tickLower: number; tickUpper: number;
  open: boolean;
  numeraire: string; // display symbol: "WETH" (Ξ) or "USD"
  numeraireKind: NumeraireKind;
  feesComplete: boolean; // false when some v4 fee-growth state was pruned (fees understated)
  tickComplete: boolean; // false when an event's pool tick fell back to the pool's genesis tick (PnL unreliable)
  priceT1perT0: number;
  priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";
  txHashes: string[];
  /**
   * Block at which the analyzed wallet transferred this NFT to someone else. Set only
   * on the wallet path, and only for a genuine hand-off (a burn is an ordinary close).
   * When set, everything above covers just that wallet's tenure and the PnL is
   * REALIZED-ONLY: liquidity still in the position at the hand-off is not counted,
   * because nothing from it ever reached the wallet.
   */
  soldAt?: bigint;
  exitTx?: string; // tx that closed the position (undefined while open / never burned)
  gasEth: number; // native gas spent (whole ETH); priced into net at display via the ETH/USD rate
  result: PnLResult; // result.netPnlUsd is PRE-gas — gas is folded in at display time
}

export interface Portfolio {
  kind: "wallet" | "tx";
  query: string;
  positions: PositionPnL[];
  skipped: string[]; // tokenIds that couldn't be read (surfaced, never silently dropped)
  totals: { net: number; fees: number; il: number; gas: number; count: number };
}

/**
 * The three lifecycle queries, as functions, so BOTH the batched prefetch and the
 * single-position fallback issue exactly the same query and the log types flow from one
 * definition instead of being restated (and drifting) in two places.
 *
 * `args.tokenId` takes one id or MANY: viem turns an array into a topic array, which is
 * what makes the batching possible at all.
 */
const lifecycleQuery = {
  inc: (tokenId: bigint | bigint[], fromBlock: bigint, toBlock: bigint) =>
    client.getLogs({ address: NPM, event: evIncrease, args: { tokenId }, fromBlock, toBlock }),
  dec: (tokenId: bigint | bigint[], fromBlock: bigint, toBlock: bigint) =>
    client.getLogs({ address: NPM, event: evDecrease, args: { tokenId }, fromBlock, toBlock }),
  col: (tokenId: bigint | bigint[], fromBlock: bigint, toBlock: bigint) =>
    client.getLogs({ address: NPM, event: evCollect, args: { tokenId }, fromBlock, toBlock }),
};

/** One position's raw lifecycle logs, before they are merged and timestamped. */
type LifecycleLogs = {
  inc: Awaited<ReturnType<typeof lifecycleQuery.inc>>;
  dec: Awaited<ReturnType<typeof lifecycleQuery.dec>>;
  col: Awaited<ReturnType<typeof lifecycleQuery.col>>;
};

/**
 * Every enumerated position's lifecycle logs, in 3 x ceil(n/50) queries instead of 3 per
 * position — the same topic-array batching as prefetchTransfers, applied to the three
 * events keyed by indexed tokenId. Measured at ~3.2 getLogs per position before this: the
 * largest remaining block of a scan, and the most expensive call type in it.
 *
 * Bounded at `head` rather than "latest", which is a deliberate (tiny) change: every
 * position in a scan is now read as of the SAME block instead of each racing the chain tip
 * separately. The ownership prefetch already worked this way.
 *
 * getLogsChunked applies per chunk, so a range that trips the 10k-result cap still splits.
 * The per-position version had no such protection.
 */
async function prefetchLifecycle(
  ids: readonly bigint[], head: bigint,
): Promise<Map<bigint, LifecycleLogs>> {
  const out = new Map<bigint, LifecycleLogs>();
  for (const id of ids) out.set(id, { inc: [], dec: [], col: [] });
  if (!ids.length) return out;

  // Three explicit passes rather than one generic helper: the three events have distinct
  // log types (their non-indexed fields differ), so a single parameterised gather cannot
  // be typed without erasing exactly the `args` typing that makes the grouping safe.
  //
  // Each pass goes through the persistent cache PER TOKENID rather than per chunk. Chunk
  // membership depends on which ids the wallet happens to hold, so one new position would
  // reshuffle every chunk and miss the lot; a record per id survives that, and a revisit
  // costs one narrow tail query per event for the whole wallet. See chain-cache.ts.
  const [inc, dec, col] = await Promise.all([
    cachedLogsById("v3:inc", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.inc, b, f, t), tokenIdOf),
    cachedLogsById("v3:dec", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.dec, b, f, t), tokenIdOf),
    cachedLogsById("v3:col", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.col, b, f, t), tokenIdOf),
  ]);
  for (const id of ids) {
    out.set(id, { inc: inc.get(id) ?? [], dec: dec.get(id) ?? [], col: col.get(id) ?? [] });
  }
  return out;
}

/** The indexed tokenId a lifecycle or Transfer log belongs to. */
const tokenIdOf = (l: { args: { tokenId?: bigint } }) => l.args.tokenId!;

/**
 * One event, many tokenIds, over one block range — the topic-array batching from
 * transfers.ts applied to whichever lifecycle query it is handed.
 *
 * getLogsChunked still applies per chunk, so a range that trips the 10k-result cap splits
 * rather than failing the whole prefetch.
 */
async function batchByTokenId<L>(
  query: (tokenId: bigint | bigint[], fromBlock: bigint, toBlock: bigint) => Promise<L[]>,
  ids: readonly bigint[], from: bigint, to: bigint,
): Promise<L[]> {
  const per = await Promise.all(chunkIds(ids).map((chunk) =>
    getLogsChunked((f, t) => query(chunk, f, t), from, to)));
  return per.flat();
}

async function fetchLifecycle(tokenId: bigint, pre?: LifecycleLogs): Promise<LiquidityEvent[]> {
  // The prefetched logs when the scan has them, otherwise this position's own queries —
  // the single-transaction path names one position and has nothing to batch. It goes
  // through prefetchLifecycle anyway, with a list of one: same cache records as a wallet
  // scan, so the two paths warm and extend each other instead of keeping rival copies.
  // (It also used to ask for the head three times, once per event.)
  const own = pre ?? (await prefetchLifecycle([tokenId], await client.getBlockNumber())).get(tokenId)!;
  const [inc, dec, col] = [own.inc, own.dec, own.col];
  const raw = [
    ...inc.map((l) => ({ kind: "increase" as const, l })),
    ...dec.map((l) => ({ kind: "decrease" as const, l })),
    ...col.map((l) => ({ kind: "collect" as const, l })),
  ].sort((a, b) => Number(a.l.blockNumber! - b.l.blockNumber!) || a.l.logIndex! - b.l.logIndex!);

  const blocks = [...new Set(raw.map((r) => r.l.blockNumber!))];
  const ts = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => ts.set(bn, await blockTimestamp(bn))));

  return raw.map(({ kind, l }) => ({
    kind, tokenId,
    txHash: l.transactionHash!, blockNumber: l.blockNumber!, timestamp: ts.get(l.blockNumber!)!,
    amount0: (l.args as { amount0: bigint }).amount0,
    amount1: (l.args as { amount1: bigint }).amount1,
    liquidity: (l.args as { liquidity?: bigint }).liquidity,
  }));
}

/**
 * Restrict a position's lifecycle to the span the analyzed wallet actually held it.
 *
 * v3 lifecycle events are keyed by tokenId alone, so they carry no owner — a wallet
 * that sold a position would otherwise keep booking the buyer's deposits and
 * withdrawals as its own. Returns `null` when ownership can't be established (no
 * Transfer log at all), in which case the caller keeps the unfiltered lifecycle
 * rather than guessing.
 */
/**
 * Every enumerated position's Transfer history for one NFT contract, in a handful of
 * queries rather than one per position — see transfers.ts. The chunks are independent, so
 * they go out together and the transport's gate decides how many actually fly at once.
 */
async function prefetchTransfers(
  contract: Address, ids: readonly bigint[], head: bigint,
): Promise<Map<bigint, NftTransfer[]>> {
  if (!ids.length) return new Map();
  const byId = await ownershipLogs(contract, ids, head);
  const out = new Map<bigint, NftTransfer[]>();
  for (const id of ids) out.set(id, (byId.get(id) ?? []).map(toNftTransfer));
  return out;
}

/**
 * Cached Transfer logs for a set of tokenIds on one NFT contract, keyed per id.
 *
 * The single-position path calls this with ONE id and the same key prefix as the wallet
 * prefetch, so a position looked up on its own reuses — and extends — whatever an earlier
 * wallet scan already wrote for it.
 *
 * Grouping, ordering and the every-id-is-present guarantee all come from cachedLogsById;
 * `restrictToOwner` still reads an empty array as "asked, and the chain has nothing",
 * which is what stops it truncating a lifecycle on a guess.
 */
export function ownershipLogs(contract: Address, ids: readonly bigint[], head: bigint) {
  return cachedLogsById(
    `xfer:${contract.toLowerCase()}`, ids, 0n, head,
    (bucket: bigint[], from: bigint, to: bigint) => batchByTokenId(
      (tokenId, f, t) => client.getLogs({ address: contract, event: evTransfer, args: { tokenId }, fromBlock: f, toBlock: t }),
      bucket, from, to),
    tokenIdOf,
  );
}

export function toNftTransfer(l: { blockNumber: bigint | null; logIndex: number | null; args: unknown }): NftTransfer {
  const a = l.args as { from: string; to: string };
  return { blockNumber: l.blockNumber!, logIndex: l.logIndex!, from: a.from, to: a.to };
}

async function restrictToOwner(
  nftContract: Address,
  tokenId: bigint,
  events: LiquidityEvent[],
  ctx: OwnerContext,
): Promise<{ events: LiquidityEvent[]; heldNow: boolean; soldAt?: bigint } | null> {
  // The prefetched history when the scan has one, otherwise a query for this id alone.
  // `?? undefined` on the inner lookup is deliberate: a present-but-empty array is an
  // answer ("no Transfer logs exist"), not a cache miss, and must NOT trigger a refetch.
  const prefetched = ctx.transfers?.get(nftContract)?.get(tokenId);
  const transfers: NftTransfer[] = prefetched
    ?? ((await ownershipLogs(nftContract, [tokenId], ctx.head)).get(tokenId) ?? []).map(toNftTransfer);
  const own = ownershipOf(transfers, ctx.owner);
  if (!own.windows.length) return null; // never held per the log — don't truncate on a guess
  return {
    events: events.filter((e) => heldAt(own, e.blockNumber)),
    heldNow: own.heldNow,
    soldAt: own.soldAt ?? undefined,
  };
}

export async function computePositionPnL(tokenId: bigint, ctx?: OwnerContext): Promise<PositionPnL> {
  const p = await client.readContract({ address: NPM, abi: [fnPositions], functionName: "positions", args: [tokenId] });
  const [, , token0, token1, fee, tickLower, tickUpper, liqNow, , , owed0, owed1] =
    p as unknown as [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

  // Cached per token address, not read per position: these four calls were ~900 of a
  // wallet scan's requests describing a few dozen tokens. decimals/symbol are immutable,
  // so the cache has no staleness to reason about — see token-meta.ts.
  const [m0, m1] = await Promise.all([
    cachedTokenMetaPersistent(token0, readTokenMeta),
    cachedTokenMetaPersistent(token1, readTokenMeta),
  ]);
  const [dec0, dec1, sym0, sym1] = [m0.dec, m1.dec, m0.sym, m1.sym];

  let events = [...(await fetchLifecycle(tokenId, ctx?.lifecycle?.get(tokenId)))];
  let soldAt: bigint | undefined;
  let heldNow = true;
  if (ctx) {
    const scoped = await restrictToOwner(NPM, tokenId, events, ctx);
    if (scoped) {
      // A wallet can hold an LP NFT across a span in which it never adds or removes
      // liquidity. There is no cost basis and no proceeds to report, so surface it as
      // its own outcome instead of handing computePnL an empty event list.
      if (!scoped.events.length) throw new Error(`#${tokenId} had no liquidity activity while ${ctx.owner} held it`);
      events = scoped.events;
      heldNow = scoped.heldNow;
      soldAt = scoped.soldAt;
    }
  }
  // Live liquidity says the POSITION is open; it says nothing about whether this
  // wallet still owns it. A sold position is closed as far as its seller is concerned,
  // and must not be marked to market — that would credit them a payout they never got.
  const open = liqNow > 0n && heldNow;
  let priceT1perT0: number;
  let priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";

  if (open) {
    const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [token0, token1, Number(fee)] })) as Address;
    const s0 = (await client.readContract({ address: pool, abi: [fnSlot0], functionName: "slot0" })) as unknown as [bigint, number];
    priceT1perT0 = sqrtToPrice(s0[0], dec0, dec1);
    priceBasis = "mark-to-market";
    const nowTs = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    const cur = amountsFromLiquidity(liqNow, tickLower, tickUpper, s0[1]);
    events.push(
      { kind: "decrease", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0, amount1: cur.amount1 },
      { kind: "collect", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0 + owed0, amount1: cur.amount1 + owed1 },
    );
  } else {
    // Closed: in-range burn → exact price; out-of-range burn → boundary price it crossed
    // (stable, archive-free). Live pool price is only a last resort when there is no burn.
    const { price, basis } = closedExitPrice(events, tickLower, tickUpper, dec0, dec1);
    if (Number.isFinite(price)) {
      priceT1perT0 = price;
      priceBasis = basis;
    } else {
      const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [token0, token1, Number(fee)] })) as Address;
      const s0 = (await client.readContract({ address: pool, abi: [fnSlot0], functionName: "slot0" })) as unknown as [bigint, number];
      priceT1perT0 = sqrtToPrice(s0[0], dec0, dec1);
      priceBasis = "live-fallback";
    }
  }

  const num = pickNumeraire(token0, token1, sym0, sym1);
  if (!num) throw new Error(`unsupported pair ${sym0}/${sym1}`);
  // Price every event from its OWN geometry so the deposit is valued at
  // deposit-time price (not the exit price). `priceT1perT0` anchors the close.
  const markTs = events.reduce((m, e) => Math.max(m, e.timestamp), 0);
  const rawFeed = buildImpliedPriceFeed(events, tickLower, tickUpper, dec0, dec1, priceT1perT0, markTs);
  const price: PriceFeed = (ts) => numerairePricePoint(rawFeed(ts), num.anchorIsToken0);

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  const gasWei = (await Promise.all(txHashes.map(receiptOf)))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: sym0, symbol1: sym1, decimals0: dec0, decimals1: dec1, feeUnits: Number(fee) };
  // Gas is native ETH. Keep net PRE-gas here (engine can't price ETH→USD for a USD
  // pair with no WETH leg) and fold gas in at display via the UI's ETH/USD rate.
  const gasEth = Number(gasWei) / 1e18;
  const result = computePnL(events, pair, price);

  // v3 reads slot0 live and derives closed-position prices from the burn's own
  // geometry — it never falls back to a pool-genesis tick, so ticks are always sound.
  return { tokenId, version: "v3", sym0, sym1, fee: Number(fee), token0, token1, tickLower, tickUpper, open, numeraire: num.symbol, numeraireKind: num.kind, feesComplete: true, tickComplete: true, priceT1perT0, priceBasis, txHashes, soldAt, exitTx: exitTxHash(events), gasEth, result };
}

function totalsOf(positions: PositionPnL[]) {
  const sum = (f: (r: PnLResult) => number) => positions.reduce((a, r) => a + f(r.result), 0);
  return {
    net: sum((r) => r.netPnlUsd), fees: sum((r) => r.feesUsd),
    il: sum((r) => r.ilUsd), gas: positions.reduce((a, p) => a + p.gasEth, 0), count: positions.length,
  };
}

export async function analyzeTx(txHash: string): Promise<Portfolio> {
  // One extra call on a path that makes dozens, and without it this whole path caches
  // nothing: `isFinal` has no head to measure against. See analyzeWallet.
  noteHead(await client.getBlockNumber());
  const receipt = await receiptOf(txHash);
  // v3 position event?
  const v3 = parseEventLogs({ abi: [evIncrease, evDecrease, evCollect], logs: receipt.logs });
  if (v3.length) {
    const tokenId = (v3[0].args as { tokenId: bigint }).tokenId;
    const pos = await computePositionPnL(tokenId);
    return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsOf([pos]) };
  }
  // v4 ModifyLiquidity on the PoolManager, sender == PositionManager → salt is the tokenId
  const v4 = parseEventLogs({ abi: [evModify], logs: receipt.logs }).filter((l) => getAddress((l.args as { sender: string }).sender) === POSM_V4);
  if (v4.length) {
    const salt = (v4[0].args as { salt: string }).salt;
    const tokenId = BigInt(salt);
    // Genesis-to-head, and the only thing standing between this tx and its mint block —
    // chunked so a query timeout degrades into more calls rather than a failed analysis.
    const mints = await getLogsChunked(
      (from, to) => client.getLogs({ address: POSM_V4, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: from, toBlock: to }),
      0n, await client.getBlockNumber(),
    );
    const pos = await computePositionPnLV4(tokenId, mints[0]?.blockNumber ?? 0n);
    return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsOf([pos]) };
  }
  throw new Error("No Uniswap v3 or v4 position event in this transaction.");
}

export async function analyzeWallet(
  wallet: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Portfolio> {
  // These two scans sit ABOVE the per-position try/catch, so unlike a position they have
  // no `skipped` bucket to fall into: if either one trips the RPC's result cap or its
  // query timeout, the whole wallet throws and every position disappears at once. Chunk
  // them for the same reason the per-pool scans are chunked.
  const head = await client.getBlockNumber();
  // Everything downstream decides what may be written to disk by asking how far behind
  // THIS head a block is. Until it is told, nothing is final and nothing persists — so a
  // path that forgets this call is merely slow. See chain-cache.ts.
  noteHead(head);
  const v3Logs = await cachedLogRange(
    `v3:owned:${wallet.toLowerCase()}`, 0n, head,
    (from, to) => getLogsChunked(
      (f, t) => client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: f, toBlock: t }),
      from, to,
    ),
  );
  const v3Ids = [...new Set(v3Logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
  const v4Ids = await analyzeWalletV4Positions(wallet, head);

  const positions: PositionPnL[] = [];
  const skipped: string[] = [];
  const total = v3Ids.length + v4Ids.length;
  let done = 0;
  onProgress?.(0, total);

  // Every position below is computed AS THIS WALLET: its lifecycle is clipped to the
  // wallet's own tenure, so a position it has since sold reports what the wallet put in
  // and took out, not what the buyer went on to do with it.
  //
  // Both contracts' Transfer histories are fetched ONCE here, before any position is
  // computed, rather than once per position inside restrictToOwner. That is the difference
  // between a couple of queries and one per position — 112 of them on the wallet that
  // prompted this.
  const [v3Transfers, v4Transfers, v3Lifecycle] = await Promise.all([
    prefetchTransfers(NPM, v3Ids, head),
    prefetchTransfers(POSM_V4, v4Ids.map((v) => v.tokenId), head),
    prefetchLifecycle(v3Ids, head),
  ]);
  const ctx: OwnerContext = {
    owner: getAddress(wallet),
    head,
    transfers: new Map([[NPM, v3Transfers], [POSM_V4, v4Transfers]]),
    lifecycle: v3Lifecycle,
  };

  // CONCURRENT, but bounded. Positions used to be awaited one at a time, so a wallet paid
  // the full latency of each in series while the transport's gate — which bounds REQUESTS
  // — never had more than one position's work to bound. The two limits compose: this one
  // decides how many positions are in flight, MAX_INFLIGHT how many requests they may have
  // out between them.
  //
  // Failures stay per-position: one unreadable position lands in `skipped` exactly as
  // before, and does not take the pool down with it.
  const run = async (label: string, job: () => Promise<PositionPnL>): Promise<void> => {
    try { positions.push(await retry(job)); }
    catch { skipped.push(label); }
    onProgress?.(++done, total);
  };
  await mapPool(
    [
      ...v3Ids.map((id) => () => run(`v3:${id}`, () => computePositionPnL(id, ctx))),
      ...v4Ids.map(({ tokenId, mintBlock }) =>
        () => run(`v4:${tokenId}`, () => computePositionPnLV4(tokenId, mintBlock, ctx))),
    ],
    POSITION_CONCURRENCY,
    (job) => job(),
  );
  positions.sort((a, b) => b.result.netPnlUsd - a.result.netPnlUsd);
  return { kind: "wallet", query: getAddress(wallet), positions, skipped, totals: totalsOf(positions) };
}

/** Enumerate a wallet's v4 positions via PositionManager ERC-721 Transfers it currently received. */
async function analyzeWalletV4Positions(wallet: string, head: bigint): Promise<{ tokenId: bigint; mintBlock: bigint }[]> {
  const mints = await cachedLogRange(
    `v4:owned:${wallet.toLowerCase()}`, 0n, head,
    (from, to) => getLogsChunked(
      (f, t) => client.getLogs({ address: POSM_V4, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: f, toBlock: t }),
      from, to,
    ),
  );
  const byId = new Map<bigint, bigint>();
  for (const l of mints) {
    const id = (l.args as { tokenId: bigint }).tokenId;
    const bn = l.blockNumber!;
    if (!byId.has(id) || bn < byId.get(id)!) byId.set(id, bn);
  }
  return [...byId.entries()].map(([tokenId, mintBlock]) => ({ tokenId, mintBlock }));
}

/**
 * The distinct pools a portfolio sits in, keyed the way GeckoTerminal keys them:
 * the pool ADDRESS for v3, the poolId for v4.
 *
 * v4 carries its poolId already. v3 has to ask the factory — but once per distinct
 * (token0, token1, fee) triple, not once per position: a wallet with 56 v3 NFTs
 * across 7 pools costs 7 calls, not 56. A tier that fails to resolve is dropped
 * rather than charted, so a pool never silently contributes zero volume.
 */
export async function poolRefsFor(positions: PositionPnL[]): Promise<PoolRef[]> {
  const labelOf = (p: PositionPnL) => `${p.sym0} / ${p.sym1} ${(p.fee / 1e4).toFixed(2)}%`;
  const out = new Map<string, PoolRef>();
  const v3Triples = new Map<string, PositionPnL>();

  for (const p of positions) {
    if (p.version === "v4") {
      if (p.poolId) out.set(p.poolId.toLowerCase(), { id: p.poolId, label: labelOf(p), version: "v4" });
    } else {
      v3Triples.set(`${p.token0.toLowerCase()}:${p.token1.toLowerCase()}:${p.fee}`, p);
    }
  }

  await Promise.all([...v3Triples.values()].map(async (p) => {
    try {
      const pool = (await client.readContract({
        address: FACTORY, abi: [fnGetPool], functionName: "getPool",
        args: [getAddress(p.token0), getAddress(p.token1), p.fee],
      })) as Address;
      if (pool === "0x0000000000000000000000000000000000000000") return;
      out.set(pool.toLowerCase(), { id: pool.toLowerCase(), label: labelOf(p), version: "v3" });
    } catch { /* unresolvable tier — omitted, not charted as zero */ }
  }));

  return [...out.values()];
}

/** Route a single input: 66-char hash → tx, 42-char address → wallet. */
export async function analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio> {
  const q = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return analyzeTx(q);
  if (isAddress(q)) return analyzeWallet(q, onProgress);
  throw new Error("Enter a wallet address (0x…40 chars) or a transaction hash (0x…64 chars).");
}
