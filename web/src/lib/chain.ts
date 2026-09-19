/**
 * Browser data layer — same logic as the CLI live.ts, but returns structured
 * data instead of printing. Talks to the same-origin `/rpc` proxy (see
 * server.mjs), which does public-first → paid spillover and hides the paid key.
 * Override with VITE_RPC_URL at build time if needed.
 */
import { createPublicClient, http, defineChain, parseAbiItem, parseEventLogs, getAddress, isAddress, type Address, type Transport } from "viem";
import {
  computePnL, closedExitPrice, buildImpliedPriceFeed, exitTxHash, amountsFromLiquidity,
  isPriceableTick, priceAtTick, pricingTick,
  type ChainConfig, type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";
import { pickNumeraire, numerairePricePoint, totalsByNumeraire, type NumeraireKind, type PortfolioTotals } from "./numeraire";
import { getLogsChunked, getLogsFromGenesis, isPruned, findLogFloor } from "./rpc-logs";
import { isWalletScanAllowlisted } from "./wallet-scan-allowlist";
import { createRateLimitGate, rateLimitWaitMs } from "./rate-limit";
import { laned, laneUrl } from "./rpc-lane";
import { ownershipOf, heldAt, type NftTransfer } from "./ownership";
import { chunkIds } from "./transfers";
import { mapPool } from "./pool";
import { createChainCache, type ChainCache } from "./chain-cache";
import { createV4Client, type SharedPlumbing } from "./chain-v4";
import type { PoolRef } from "./volume";

export type { NumeraireKind };

/**
 * One position's raw lifecycle logs, before they are merged and timestamped.
 *
 * Defined structurally here rather than via `typeof lifecycleQuery.inc` (as in the
 * pre-factory, single-chain version of this file): `lifecycleQuery` is now built per
 * chain inside `createChainClient`'s closure (it calls `client.getLogs` against that
 * chain's own `NPM`), so a type declared at module level cannot name it directly.
 * Every consumer of these logs already narrows `.args` with its own explicit cast
 * (see `fetchLifecycle` below), so the loosened `args: unknown` here is exactly as
 * precise as the code that reads it — nothing downstream relied on more than this.
 */
type DecodedLog = { blockNumber: bigint | null; logIndex: number | null; transactionHash: `0x${string}` | null; args: unknown };
type LifecycleLogs = { inc: DecodedLog[]; dec: DecodedLog[]; col: DecodedLog[] };

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
  /**
   * False when an event's pool price could not be read from chain state and a fallback
   * stood in: the pool's genesis tick (nothing at all identified it — PnL unreliable),
   * or the last real trade before a swap drained the pool to its numerical price limit
   * (approximate). Either way the UI flags the position rather than presenting a
   * confident number.
   */
  tickComplete: boolean;
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
  gasKind: NumeraireKind; // what unit gasEth is actually in — "eth" on Robinhood, "usd" on Arc. See numeraire.ts's gasInNumeraire.
  result: PnLResult; // result.netPnlUsd is PRE-gas — gas is folded in at display time
}

export interface Portfolio {
  kind: "wallet" | "tx";
  query: string;
  positions: PositionPnL[];
  skipped: string[]; // tokenIds that couldn't be read (surfaced, never silently dropped)
  /**
   * Split by numeraire, because `netPnlUsd` is anchor-unit and a single sum across a
   * mixed wallet is in no unit at all. Collapsing the buckets into one figure needs an
   * ETH/USD rate and is the CALLER's job — the UI does it per position in `SummaryBar`.
   */
  totals: PortfolioTotals;
}

export interface ChainClient {
  analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio>;
  poolRefsFor(positions: PositionPnL[]): Promise<PoolRef[]>;
  /** Present only for a chain with an ETH leg (Robinhood). Arc has none — see ChainConfig.tokens.ethAnchors. */
  fetchEthUsd?(): Promise<number | null>;
  resetCaches(): Promise<void>;
  explorerUrl: string | null;
}

/**
 * Retry a transient failure, backing off 300/600/900 ms.
 *
 * `retryable` says which failures those are; it defaults to all of them. Some are facts
 * rather than hiccups — Blockscout reporting that a tx's trace is not indexed can change,
 * but on the scale of minutes, not milliseconds, and asking again immediately spends
 * three requests to learn the same thing three times. Worse, each of those is a 200, which
 * `fetchTraceCalls` counts toward WIDENING the explorer's rate budget: the amplification
 * lands exactly when the explorer is already behind. Such a failure still surfaces to the
 * caller; it is just not asked twice.
 *
 * Module-level and exported rather than built per-chain inside `createChainClient`: it is a
 * pure, chain-independent utility — it closes over nothing but its own arguments — and
 * `retry.test.ts` (part of the root `npm run verify` suite) imports it directly.
 */
export const retry = async <T>(
  fn: () => Promise<T>,
  attempts = 3,
  retryable: (e: unknown) => boolean = () => true,
): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!retryable(e)) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
};

export function createChainClient(chain: ChainConfig): ChainClient {
  const cache: ChainCache = createChainCache(chain);

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
    chain.rpcUrl;
  // Robinhood's rpcChainSlug is "" → base path is exactly "/rpc", byte-identical to
  // today's URL. Arc's is "arc" → "/rpc?chain=arc"; laneUrl() below adds "&lane=wallet"
  // on top of that via searchParams.set, which does not disturb the chain param.
  const proxyPath = chain.rpcChainSlug ? `/rpc?chain=${chain.rpcChainSlug}` : "/rpc";
  const RPC_URL =
    VITE_RPC ||
    (typeof window !== "undefined" ? new URL(proxyPath, window.location.origin).toString() : NODE_RPC);

  // The allowlist gating wallet scanning on every chain — see wallet-scan-allowlist.ts and
  // analyze() below. Same dual resolution as RPC_URL above: VITE_ for the browser bundle
  // (build-time only, not a runtime secret — this is a UX/access gate on a public read-only
  // tool, not a security boundary), a bare env var for Node smoke/repro.
  const WALLET_SCAN_ALLOWLIST =
    (import.meta.env && import.meta.env.VITE_WALLET_SCAN_ALLOWLIST) ||
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WALLET_SCAN_ALLOWLIST;

  const viemChain = defineChain({
    id: chain.chainId,
    name: chain.chainId === 4663 ? "Robinhood Chain" : "Arc",
    nativeCurrency: chain.nativeCurrency,
    // Point the default at the proxy too, so any viem fallback still avoids the
    // public RPC's broken CORS (never call chain.rpcUrl from the browser).
    rpcUrls: { default: { http: [RPC_URL] } },
    blockExplorers: chain.explorerUrl
      ? { default: { name: "Explorer", url: chain.explorerUrl } }
      : undefined,
  });

  // NPM/FACTORY are only meaningful when chain.uniswapV3 is set (Robinhood). On a v3-less
  // chain (Arc) they resolve to the zero address and are simply never reached: analyzeWallet
  // skips v3 enumeration entirely when chain.uniswapV3 is null (Step 3f), and no v4 event
  // log can ever match the zero address, so this is inert rather than special-cased.
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
  const NPM = chain.uniswapV3 ? getAddress(chain.uniswapV3.nonfungiblePositionManager) : ZERO_ADDRESS;
  const FACTORY = chain.uniswapV3 ? getAddress(chain.uniswapV3.factory) : ZERO_ADDRESS;
  const POSM_V4 = getAddress(chain.uniswapV4.positionManager);

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
    // The ceiling is the LIMITER's, not the constant's: a 429 narrows it and a clean run
    // widens it again, so the gate below cannot re-flood an endpoint that just refused.
    if (inflight < rateLimitGate.permitted()) { inflight++; return Promise.resolve(); }
    return new Promise<void>((resolve) => waiting.push(() => { inflight++; resolve(); }));
  }
  function releaseSlot(): void {
    inflight--;
    // Wake as many as the CURRENT permit allows — after a recovery step that can be more
    // than one, and after a 429 it may be none.
    while (waiting.length && inflight < rateLimitGate.permitted()) waiting.shift()!();
  }

  /**
   * The shared rate-limit pause. One for the whole client, both lanes included: the limit
   * is enforced per caller, not per lane, so pausing one while the other keeps firing would
   * not clear it.
   */
  const rateLimitGate = createRateLimitGate({ maxInflight: MAX_INFLIGHT });

  /**
   * How many times one request will sit out a rate limit before giving up. Four, against a
   * limit that states 60s, is a worst case of a few minutes for a request that would
   * otherwise have failed outright — and in practice the gate is shared, so only the first
   * caller waits and the rest queue behind it.
   */
  const RATE_LIMIT_ATTEMPTS = 4;

  /**
   * Wrap a transport so every request passes through the concurrency gate, and waits out a
   * rate limit rather than reporting it as a dead position.
   *
   * The slot is RELEASED before the pause — a request sleeping out someone else's 429 must
   * not also hold one of the eight in-flight slots, or the pause would throttle the recovery
   * as well as the burst.
   */
  function throttle(transport: Transport): Transport {
    return (params) => {
      const t = transport(params);
      const request: typeof t.request = async (...args) => {
        for (let attempt = 0; ; attempt++) {
          await rateLimitGate.wait();
          await acquireSlot();
          // Success is tracked by a flag rather than by binding the result: viem's request
          // is generic in its return type, and anything other than returning the call
          // expression directly widens that to `unknown` and stops type-checking.
          let threw = false;
          try {
            return await t.request(...args);
          } catch (e) {
            threw = true;
            const waitMs = rateLimitWaitMs(e);
            if (waitMs === null || attempt >= RATE_LIMIT_ATTEMPTS - 1) throw e;
            rateLimitGate.note(waitMs);
          } finally {
            releaseSlot();
            if (!threw) rateLimitGate.noteSuccess();
          }
        }
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

  /**
   * Which wallet the CURRENT analyze() call is for — set by analyze() around its single
   * call into analyzeWallet, null otherwise (including for analyzeTx). Read by
   * taggedRequest below to stamp `subject=` on every outgoing request for the duration.
   *
   * A viem `http()` transport is built ONCE, at client construction, with a fixed URL —
   * but which wallet is being analyzed is only known per analyze() call, long after this
   * client already exists (one client is reused for a whole page session). `onFetchRequest`
   * is the one viem hook that runs fresh on every actual request rather than once at
   * construction, so it is what makes a per-call, mutable value like this usable at all
   * without rebuilding the transport (or the client) on every analyze() call.
   *
   * The server (see rpc.ts's "Subject gate") is the real enforcement point regardless —
   * this only decides what the browser DECLARES, never what it is allowed to reach.
   */
  let walletLaneSubject: string | null = null;

  function taggedRequest(request: Request, init: RequestInit): void | (RequestInit & { url?: string }) {
    if (!walletLaneSubject) return undefined;
    try {
      const u = new URL(request.url);
      u.searchParams.set("subject", walletLaneSubject);
      // MUST spread `init`, not return a bare `{ url }` — viem's http transport uses
      // whatever this hook returns AS THE ENTIRE fetch() init when it returns anything at
      // all (see getHttpRpcClient: `(await onRequest?.(...)) ?? { ...init, url }` — the
      // merge-with-init only happens in the FALLBACK branch). A bare `{ url }` silently
      // dropped `method`/`body`/`headers`, so fetch() defaulted to a bodyless GET and every
      // allowlisted wallet scan's first call (eth_blockNumber) died against /rpc's
      // POST-only check with a 405 — on every chain, the moment a subject got attached.
      return { ...init, url: u.toString() };
    } catch {
      return undefined;
    }
  }

  const client = createPublicClient({
    chain: viemChain,
    // eth_getLogs goes out on the wallet lane, everything else on the ordinary one. The
    // split is by METHOD rather than by call site so a new heavy caller cannot forget it —
    // see rpc-lane.ts for why getLogs is the call that matters. THROTTLE WRAPS BOTH: the
    // concurrency gate exists because this endpoint answers heavy parallel load with
    // timeouts rather than backpressure, and splitting the lanes must not double the fan-out
    // the gate was measured against. onFetchRequest on BOTH transports so an allowlisted
    // wallet's ordinary-lane traffic (readContract, receipts, ...) also gets tagged, not
    // just its eth_getLogs calls — see rpc.ts's subject gate, which restricts BOTH lanes.
    transport: throttle(
      laned(
        http(RPC_URL, { retryCount: 2, retryDelay: 300, onFetchRequest: taggedRequest }),
        http(LANE_URL, { retryCount: 2, retryDelay: 300, onFetchRequest: taggedRequest }),
      ),
    ),
  });

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
  const blockTimestamp = (blockNumber: bigint): Promise<number> =>
    cache.cachedBlockTimestamp(blockNumber, async (bn) => Number((await client.getBlock({ blockNumber: bn })).timestamp));

  /**
   * A transaction receipt, remembered across page loads once its block has settled.
   *
   * This replaces a per-POSITION receipt map in chain-v4.ts, which was scoped that way
   * specifically so receipts would not accumulate across a wallet scan. That trade has been
   * reversed on purpose: persisting them is the whole point, and a page-lifetime map is the
   * cost of it. A large wallet's receipts are the same order of size as the position data
   * the page already holds. If that ever bites, the fix is an LRU here — not a second,
   * narrower cache next to it.
   */
  const receiptOf = (hash: string) =>
    cache.cachedReceipt(hash, (h) => client.getTransactionReceipt({ hash: h as `0x${string}` }));

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

  // fetchEthUsd is only ever called for a chain with an ETH leg (see the ChainClient
  // interface's optional fetchEthUsd, and App.tsx which never calls it for Arc). These
  // constants still need SOME value to construct without throwing on a chain with no
  // ethAnchors at all — ZERO_ADDRESS is inert there, same reasoning as NPM/FACTORY above.
  const WETH_ADDR = getAddress(chain.tokens.ethAnchors[0] ?? ZERO_ADDRESS);
  const USDG_ADDR = getAddress(chain.tokens.usdAnchors[0] ?? ZERO_ADDRESS);

  /**
   * Live ETH/USD from the most-liquid WETH/USDG v3 pool on Robinhood Chain — an
   * on-chain, archive-free, CORS-open source (same RPC the app already uses), so no
   * external price API. Returns null if no WETH/USDG pool has liquidity.
   */
  async function fetchEthUsd(): Promise<number | null> {
    const wethIsToken0 = WETH_ADDR.toLowerCase() < USDG_ADDR.toLowerCase();
    const dec0 = wethIsToken0 ? 18 : chain.tokens.usdDecimals;
    const dec1 = wethIsToken0 ? chain.tokens.usdDecimals : 18;
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
      cache.cachedLogsById("v3:inc", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.inc, b, f, t), tokenIdOf),
      cache.cachedLogsById("v3:dec", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.dec, b, f, t), tokenIdOf),
      cache.cachedLogsById("v3:col", ids, 0n, head, (b: bigint[], f: bigint, t: bigint) => batchByTokenId(lifecycleQuery.col, b, f, t), tokenIdOf),
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
  /**
   * The oldest block this RPC currently answers `eth_getLogs` for, memoized for the
   * client's lifetime once discovered. Most chains (Robinhood) have no such limit at all —
   * the probe below is a single narrow, cheap call, so a chain with no retention pays
   * nothing extra here. Discovered, never hardcoded: a provider's retention window is its
   * own operational fact, not this app's to guess or bake in (see rpc-logs.ts's PRUNED).
   *
   * `cachedLogsById` records whatever `from` it is actually asked for as the range it
   * covers — passing the discovered floor here (rather than clamping inside the fetch
   * callback) keeps that record honest. Clamping inside the callback instead would have
   * the cache believe it checked from block 0 when it only ever checked from the floor,
   * which is wrong forever, not just for this call.
   */
  let genesisFloor: bigint | null = null;
  async function resolveGenesisFloor(contract: Address, head: bigint): Promise<bigint> {
    if (genesisFloor !== null) return genesisFloor;
    const PROBE_WIDTH = 100n;
    const probe = async (from: bigint): Promise<boolean> => {
      try {
        await client.getLogs({ address: contract, fromBlock: from, toBlock: from + PROBE_WIDTH });
        return true;
      } catch (e) {
        if (isPruned(e)) return false;
        throw e; // a non-retention failure here is a real problem — surface it, don't mask it as "no floor"
      }
    };
    genesisFloor = (await probe(0n)) ? 0n : await findLogFloor(probe, 0n, head);
    return genesisFloor;
  }

  function ownershipLogs(contract: Address, ids: readonly bigint[], head: bigint) {
    return resolveGenesisFloor(contract, head).then((floor) =>
      cache.cachedLogsById(
        `xfer:${contract.toLowerCase()}`, ids, floor, head,
        (bucket: bigint[], from: bigint, to: bigint) => batchByTokenId(
          (tokenId, f, t) => client.getLogs({ address: contract, event: evTransfer, args: { tokenId }, fromBlock: f, toBlock: t }),
          bucket, from, to),
        tokenIdOf,
      ));
  }

  function toNftTransfer(l: { blockNumber: bigint | null; logIndex: number | null; args: unknown }): NftTransfer {
    const a = l.args as { from: string; to: string };
    return { blockNumber: l.blockNumber!, logIndex: l.logIndex!, from: a.from, to: a.to };
  }

  const shared: SharedPlumbing = { client, blockTimestamp, receiptOf, retry, ownershipLogs, toNftTransfer };
  const v4 = createV4Client(chain, cache, shared);

  async function restrictToOwner(
    nftContract: Address,
    tokenId: bigint,
    events: LiquidityEvent[],
    ctx: OwnerContext,
  ): Promise<{ events: LiquidityEvent[]; heldNow: boolean; soldAt?: bigint } | null> {
    // The prefetched history when the scan has one, otherwise a query for this id alone.
    // `??` and not `||`: a present-but-EMPTY array is an answer ("the chain has no Transfer
    // log for this id"), not a cache miss, and must not trigger a refetch.
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

  async function computePositionPnL(tokenId: bigint, ctx?: OwnerContext): Promise<PositionPnL> {
    const p = await client.readContract({ address: NPM, abi: [fnPositions], functionName: "positions", args: [tokenId] });
    const [, , token0, token1, fee, tickLower, tickUpper, liqNow, , , owed0, owed1] =
      p as unknown as [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

    // Cached per token address, not read per position: these four calls were ~900 of a
    // wallet scan's requests describing a few dozen tokens. decimals/symbol are immutable,
    // so the cache has no staleness to reason about — see token-meta.ts.
    const [m0, m1] = await Promise.all([
      cache.cachedTokenMetaPersistent(token0, readTokenMeta),
      cache.cachedTokenMetaPersistent(token1, readTokenMeta),
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
    /**
     * False once a live pool price has been refused for sitting at the AMM's numerical
     * limit. v3 otherwise never guesses a tick — it reads slot0 live and derives closed
     * prices from the burn's own geometry — so this is the only way it can go false.
     */
    let tickComplete = true;

    if (open) {
      const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [token0, token1, Number(fee)] })) as Address;
      const s0 = (await client.readContract({ address: pool, abi: [fnSlot0], functionName: "slot0" })) as unknown as [bigint, number];
      // A pool a swap has drained to its price limit quotes 1e-39 (or 1e39), and marking
      // to market against that turns the other token's balance into ~1e43. Fall back to
      // the range boundary the pool is pinned against, and flag it. The RAW tick still
      // drives `amountsFromLiquidity` below: at the limit that split is correct.
      const livePriced = isPriceableTick(s0[1]);
      priceT1perT0 = livePriced
        ? sqrtToPrice(s0[0], dec0, dec1)
        : priceAtTick(pricingTick(s0[1], tickLower, tickUpper), dec0, dec1);
      tickComplete = livePriced;
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
        // Same limit guard as the open branch above.
        const livePriced = isPriceableTick(s0[1]);
        priceT1perT0 = livePriced
          ? sqrtToPrice(s0[0], dec0, dec1)
          : priceAtTick(pricingTick(s0[1], tickLower, tickUpper), dec0, dec1);
        tickComplete = livePriced;
        priceBasis = "live-fallback";
      }
    }

    const num = pickNumeraire(chain, token0, token1, sym0, sym1);
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

    // v3 reads slot0 live and derives closed-position prices from the burn's own geometry —
    // it never falls back to a pool-genesis tick. `tickComplete` goes false only when that
    // live read landed on the AMM's price limit and the range boundary stood in for it.
    return {
      tokenId, version: "v3", sym0, sym1, fee: Number(fee), token0, token1, tickLower, tickUpper, open,
      numeraire: num.symbol, numeraireKind: num.kind, feesComplete: true, tickComplete, priceT1perT0, priceBasis,
      txHashes, soldAt, exitTx: exitTxHash(events), gasEth, gasKind: chain.gasIsUsdAnchor ? "usd" : "eth", result,
    };
  }

  async function analyzeTx(txHash: string): Promise<Portfolio> {
    // One extra call on a path that makes dozens, and without it this whole path caches
    // nothing: `isFinal` has no head to measure against. See analyzeWallet.
    cache.noteHead(await client.getBlockNumber());
    let receipt;
    try {
      receipt = await receiptOf(txHash);
    } catch (err) {
      // Arc's free public RPC has a confirmed gap in its by-hash tx/receipt index: a real,
      // confirmed transaction can be fully present in a block's body (eth_getBlockByNumber
      // lists it) while eth_getTransactionReceipt/eth_getTransactionByHash for that exact
      // hash return null — verified 2026-09-19 against a live Arc mainnet ModifyLiquidity
      // tx. There is no second Arc RPC configured to spill over to, so this is not
      // recoverable from here. The wallet-scan path does not depend on this lookup at all
      // (it enumerates positions via Transfer logs), so point the user there instead of
      // surfacing viem's raw "could not be found" message, which reads as a dead end.
      if (chain.rpcChainSlug === "arc") {
        throw new Error(
          `This RPC has no record of ${txHash} by hash, even though it may be a real, confirmed transaction — Arc's free public RPC has known gaps in its by-hash transaction index. Try pasting the wallet address instead; a wallet scan finds positions via event logs and does not depend on this lookup.`,
        );
      }
      throw err;
    }
    // v3 position event?
    const v3 = parseEventLogs({ abi: [evIncrease, evDecrease, evCollect], logs: receipt.logs });
    if (v3.length) {
      const tokenId = (v3[0].args as { tokenId: bigint }).tokenId;
      const pos = await computePositionPnL(tokenId);
      return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsByNumeraire([pos]) };
    }
    // v4 ModifyLiquidity on the PoolManager, sender == PositionManager → salt is the tokenId
    const v4Logs = parseEventLogs({ abi: [evModify], logs: receipt.logs }).filter((l) => getAddress((l.args as { sender: string }).sender) === POSM_V4);
    if (v4Logs.length) {
      const salt = (v4Logs[0].args as { salt: string }).salt;
      const tokenId = BigInt(salt);
      // Genesis-to-head, and the only thing standing between this tx and its mint block —
      // getLogsFromGenesis survives a provider that refuses to look back past its own
      // retention window (see rpc-logs.ts) instead of failing outright on a query that
      // merely NAMES `fromBlock: 0` over a chain far taller than what it retains, even
      // when the actual mint is well inside the readable range.
      const { logs: mints, truncatedAt } = await getLogsFromGenesis(
        (from, to) => client.getLogs({ address: POSM_V4, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: from, toBlock: to }),
        await client.getBlockNumber(),
      );
      if (!mints.length) {
        // Silence here is NOT "this token was never minted" — the tx we were handed proves
        // it exists. Defaulting to block 0 (as this line briefly did) would have quietly
        // priced the position as if it had existed since chain genesis.
        throw new Error(
          truncatedAt !== null
            ? `Token #${tokenId}'s mint is older than what this RPC currently retains (before block ${truncatedAt}) — its PnL cannot be computed.`
            : `Could not find a mint event for token #${tokenId}.`,
        );
      }
      const pos = await v4.computePositionPnLV4(tokenId, mints[0].blockNumber!);
      return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsByNumeraire([pos]) };
    }
    throw new Error("No Uniswap v3 or v4 position event in this transaction.");
  }

  async function analyzeWallet(
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
    cache.noteHead(head);
    const v3Ids: bigint[] = chain.uniswapV3
      ? [...new Set((await cache.cachedLogRange(
          `v3:owned:${wallet.toLowerCase()}`, 0n, head,
          (from, to) => getLogsChunked(
            (f, t) => client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: f, toBlock: t }),
            from, to,
          ),
        )).map((l) => (l.args as { tokenId: bigint }).tokenId))]
      : [];
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
          () => run(`v4:${tokenId}`, () => v4.computePositionPnLV4(tokenId, mintBlock, ctx))),
      ],
      POSITION_CONCURRENCY,
      (job) => job(),
    );
    positions.sort((a, b) => b.result.netPnlUsd - a.result.netPnlUsd);
    return { kind: "wallet", query: getAddress(wallet), positions, skipped, totals: totalsByNumeraire(positions) };
  }

  /** Enumerate a wallet's v4 positions via PositionManager ERC-721 Transfers it currently received. */
  async function analyzeWalletV4Positions(wallet: string, head: bigint): Promise<{ tokenId: bigint; mintBlock: bigint }[]> {
    const mints = await cache.cachedLogRange(
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
  async function poolRefsFor(positions: PositionPnL[]): Promise<PoolRef[]> {
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
  async function analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio> {
    const q = input.trim();
    // Cleared unconditionally before either branch: a stale subject from a PRIOR
    // analyzeWallet call must never leak into this one, whichever path it takes.
    walletLaneSubject = null;
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) return analyzeTx(q);
    if (isAddress(q)) {
      // Wallet scanning is restricted to WALLET_SCAN_ALLOWLIST, on every chain — not a
      // per-chain reliability gate (Arc's genesis-wide NFT-transfer scan is separately
      // rate-limit- and pruning-prone at scale, see rpc-logs.ts's getLogsFromGenesis, but
      // that is not why this check exists: it is a deliberate access restriction, true on
      // Robinhood too, where the underlying scan works fine). A single transaction's PnL
      // is unaffected — see analyzeTx.
      if (!isWalletScanAllowlisted(q, WALLET_SCAN_ALLOWLIST)) {
        throw new Error("Wallet scanning is restricted to allowlisted addresses right now — analyze a single transaction hash instead.");
      }
      // Tags every request for the rest of THIS call with ?subject=<wallet> (see
      // taggedRequest above) — the server-side gate (rpc.ts) checks it before honoring
      // the wallet tier or paid spillover at all. Cleared in `finally` so it cannot
      // outlive this call, success or failure.
      walletLaneSubject = q;
      try {
        return await analyzeWallet(q, onProgress);
      } finally {
        walletLaneSubject = null;
      }
    }
    throw new Error("Enter a wallet address (0x…40 chars) or a transaction hash (0x…64 chars).");
  }

  return {
    analyze,
    poolRefsFor,
    fetchEthUsd: chain.tokens.ethAnchors.length > 0 ? fetchEthUsd : undefined,
    resetCaches: cache.resetCaches,
    explorerUrl: chain.explorerUrl,
  };
}
