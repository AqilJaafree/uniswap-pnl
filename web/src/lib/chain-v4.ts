/**
 * Uniswap v4 browser data layer for Robinhood chain — mirrors chain.ts (v3) but
 * reads the v4 PoolManager / PositionManager / StateView. Reuses the shared viem
 * client and the pure engine + v4-decode helpers. Returns the same PositionPnL
 * shape as v3 so the UI is protocol-agnostic.
 */
import { parseAbiItem, getAddress, toHex, decodeEventLog, type Address } from "viem";
import { client, retry, type PositionPnL } from "./chain";
import {
  computePnL, amountsFromLiquidity, exitTxHash, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlockOrNull, tickFromAmounts, nativeFlowForOwner,
  type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
  type ActualReceivedByTx, type TraceCall,
} from "./v4-decode";

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const NATIVE = getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH);

const evErc20T = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const evErc721T = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
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
 * getLogs over [fromBlock, toBlock] that survives the RPC's 10k-results-per-query
 * cap by recursively halving the block range on that error. Normal pools resolve
 * in one call; only hot pools (e.g. an active memecoin/USDG pair) split.
 */
async function getLogsChunked<TLog>(
  makeCall: (fromBlock: bigint, toBlock: bigint) => Promise<TLog[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TLog[]> {
  try {
    return await makeCall(fromBlock, toBlock);
  } catch (e) {
    const msg = String((e as { details?: string; shortMessage?: string; message?: string })?.details ?? (e as Error)?.message ?? "");
    // Split on both symptoms of a too-large query: the result-count cap and a query timeout.
    if (!/exceeds limit|10000|too many|range too|timed out|timeout/i.test(msg) || toBlock - fromBlock < 1n) throw e;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [a, b] = await Promise.all([getLogsChunked(makeCall, fromBlock, mid), getLogsChunked(makeCall, mid + 1n, toBlock)]);
    return [...a, ...b];
  }
}

/** Authoritative pool tick at a block via StateView; null when that block's state is pruned. */
async function slot0TickAt(meta: V4Meta, blockNumber: bigint): Promise<number | null> {
  try {
    const s0 = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [meta.poolId as `0x${string}`], blockNumber })) as readonly [bigint, number, number, number];
    return Number(s0[1]);
  } catch { return null; } // pruned (>~14 days) — caller falls back to the Swap-derived tick
}

async function tokenMeta(addr: string): Promise<{ dec: number; sym: string }> {
  if (isNative(addr)) return { dec: 18, sym: "ETH" };
  const [dec, sym] = (await Promise.all([
    client.readContract({ address: getAddress(addr), abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: getAddress(addr), abi: [fnSymbol], functionName: "symbol" }),
  ])) as [number, string];
  return { dec, sym };
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
 * Archive-free tick source: all Swaps for the pool since the position's mint + the
 * Initialize tick.
 *
 * The scan deliberately starts AT `mintBlock`, so no swap precedes a mint and the swap
 * fallback cannot price one. Widening it backwards would be exact — a tick only moves
 * on a swap, so the last swap before a block IS that block's tick over a contiguous
 * range — but measured at 5-40% extra wall-clock per position for a fallback that
 * ground truth (see `fetchOwnerFlowsByTx`) now reaches first anyway. On this RPC extra
 * load is not free: `analyzeWallet` positions that exhaust their retries land in
 * `skipped` and quietly vanish from the wallet total. If a mint ever does need it,
 * widen lazily — only for the blocks left without a tick — rather than for every pool.
 */
async function fetchTickSource(meta: V4Meta): Promise<{ swaps: V4SwapPoint[]; initTick: number }> {
  const head = await client.getBlockNumber();
  const [swapLogs, initLogs] = await Promise.all([
    getLogsChunked((from, to) => client.getLogs({ address: PM, event: evSwap, args: { id: meta.poolId as `0x${string}` }, fromBlock: from, toBlock: to }), meta.mintBlock, head),
    client.getLogs({ address: PM, event: evInitialize, args: { id: meta.poolId as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const swaps: V4SwapPoint[] = swapLogs.map((l) => ({ blockNumber: l.blockNumber!, logIndex: l.logIndex!, tick: Number((l.args as { tick: number }).tick) }));
  const initTick = initLogs.length ? Number((initLogs[0].args as { tick: number }).tick) : 0;
  return { swaps, initTick };
}

/** Best-effort fee-growth-inside at a block; null when that block's state is pruned. */
async function feeGrowthAt(meta: V4Meta, blockNumber: bigint): Promise<{ fg0: bigint; fg1: bigint } | null> {
  try {
    const fgi = (await client.readContract({ address: SV, abi: [fnFGI], functionName: "getFeeGrowthInside", args: [meta.poolId as `0x${string}`, meta.tickLower, meta.tickUpper], blockNumber })) as readonly [bigint, bigint];
    return { fg0: fgi[0], fg1: fgi[1] };
  } catch { return null; } // missing trie node (pruned) — fees for this segment become approximate
}

/** All ModifyLiquidity events for one tokenId (join by poolId + salt + sender). */
async function fetchV4Lifecycle(tokenId: bigint, meta: V4Meta): Promise<{ raw: V4RawEvent[]; tsByBlock: Map<bigint, number> }> {
  const saltHex = toHex(tokenId, { size: 32 }).toLowerCase();
  const head = await client.getBlockNumber();
  const logs = await getLogsChunked((from, to) => client.getLogs({ address: PM, event: evModify, args: { id: meta.poolId as `0x${string}` }, fromBlock: from, toBlock: to }), meta.mintBlock, head);
  const mine = logs.filter((l) => {
    const a = l.args as { sender: string; salt: string };
    return getAddress(a.sender) === POSM && a.salt.toLowerCase() === saltHex;
  });

  const blocks = [...new Set(mine.map((l) => l.blockNumber!))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => tsByBlock.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp))));

  const raw: V4RawEvent[] = mine.map((l) => {
    const a = l.args as { tickLower: number; tickUpper: number; liquidityDelta: bigint };
    return { blockNumber: l.blockNumber!, logIndex: l.logIndex!, txHash: l.transactionHash!, timestamp: tsByBlock.get(l.blockNumber!)!, tickLower: Number(a.tickLower), tickUpper: Number(a.tickUpper), liquidityDelta: a.liquidityDelta };
  });
  return { raw, tsByBlock };
}

/** Signed net movement of both pool currencies for the position owner, per tx (positive = received). */
type OwnerFlows = Map<string, { amount0: bigint; amount1: bigint }>;

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
async function fetchTraceCalls(txHash: string): Promise<TraceCall[]> {
  const out: TraceCall[] = [];
  let query = "";
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`${ROBINHOOD_CHAIN.explorer}/api/v2/transactions/${txHash}/internal-transactions${query}`);
    if (!res.ok) throw new Error(`blockscout ${res.status} for ${txHash}`);
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
 */
async function fetchNativeFlowsByTx(owner: Address, txs: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  await Promise.all(txs.map(async (tx) => {
    try {
      const [calls, t] = await Promise.all([
        retry(() => fetchTraceCalls(tx)),
        client.getTransaction({ hash: tx as `0x${string}` }),
      ]);
      out.set(tx, nativeFlowForOwner(owner, { from: t.from, value: t.value }, calls));
    } catch { /* unreadable — left absent so the caller drops the tx entirely */ }
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
 */
async function fetchOwnerFlowsByTx(meta: V4Meta, raw: V4RawEvent[], tokenId: bigint): Promise<OwnerFlows | undefined> {
  const c0 = getAddress(meta.poolKey.currency0), c1 = getAddress(meta.poolKey.currency1);
  const native0 = isNative(c0), native1 = isNative(c1);

  // NFT holder = counterparty of the deposits/withdrawals (positions are analyzed for the holder)
  const nft = await client.getLogs({ address: POSM, event: evErc721T, args: { tokenId }, fromBlock: meta.mintBlock, toBlock: "latest" });
  if (!nft.length) return undefined;
  const owner = getAddress((nft[nft.length - 1].args as { to: string }).to);

  const txs = [...new Set(raw.map((r) => r.txHash))];
  const nativeFlows = native0 || native1 ? await fetchNativeFlowsByTx(owner, txs) : undefined;
  const map: OwnerFlows = new Map();
  await Promise.all(txs.map(async (tx) => {
    // A tx whose native leg could not be read must be dropped WHOLE. Keeping just the
    // ERC20 side would look like a one-sided flow and fabricate both the fee and the
    // implied tick; dropping it degrades to the fee-growth path, which is merely coarse.
    if (nativeFlows && !nativeFlows.has(tx)) return;
    const receipt = await client.getTransactionReceipt({ hash: tx as `0x${string}` });
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

export async function computePositionPnLV4(tokenId: bigint, mintBlock: bigint): Promise<PositionPnL> {
  const meta = await fetchMeta(tokenId, mintBlock);
  const num = pickNumeraire(meta.poolKey.currency0, meta.poolKey.currency1, meta.sym0, meta.sym1);
  if (!num) throw new Error(`unsupported v4 pair ${meta.sym0}/${meta.sym1}`);

  const { raw, tsByBlock } = await fetchV4Lifecycle(tokenId, meta);
  if (raw.length === 0) throw new Error(`no v4 liquidity events for #${tokenId}`);
  const sortedRaw = [...raw].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  // Ground-truth token movement per tx. Inflows (removals) give authoritative fees;
  // outflows (mints) give the true tick when chain state is pruned. Undefined for
  // native-ETH pairs → fee-growth / swap fallbacks.
  const ownerFlows = await fetchOwnerFlowsByTx(meta, raw, tokenId);
  const actualReceived = inflowsOf(ownerFlows);
  const actualSpent = outflowsOf(ownerFlows);

  // tick from Swap logs (archive-free); fee-growth best-effort per event block
  const { swaps, initTick } = await fetchTickSource(meta);
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
    const swapTick = tickAtBlockOrNull(swaps, bn);
    const implied = impliedTicks.get(bn) ?? null;
    if (liveTick == null && implied == null && swapTick == null) tickComplete = false;
    stateByBlock.set(bn, { tick: liveTick ?? implied ?? swapTick ?? initTick, fg0: fg?.fg0 ?? null, fg1: fg?.fg1 ?? null });
  }));

  const open = meta.liqNow > 0n;
  const built = buildV4Events(raw, stateByBlock, meta.dec0, meta.dec1, tokenId, actualReceived);
  const events: LiquidityEvent[] = built.events;
  let feesComplete = built.feesComplete;

  const priceBasis: PositionPnL["priceBasis"] = open ? "mark-to-market" : "in-range";
  let priceT1perT0: number;

  if (open) {
    const nowBlock = await client.getBlockNumber();
    const nowTs = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    // current tick/price + fee-growth from HEAD state (never pruned)
    const s0 = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [meta.poolId as `0x${string}`], blockNumber: nowBlock })) as readonly [bigint, number, number, number];
    const nowTick = Number(s0[1]);
    const nowFg = await feeGrowthAt(meta, nowBlock);
    stateByBlock.set(nowBlock, { tick: nowTick, fg0: nowFg?.fg0 ?? null, fg1: nowFg?.fg1 ?? null });
    tsByBlock.set(nowBlock, nowTs);
    priceT1perT0 = tickToPrice(nowTick, meta.dec0, meta.dec1);

    // synthetic MTM: current principal + unclaimed fees since last checkpoint
    const lastBlock = sortedRaw[sortedRaw.length - 1].blockNumber;
    const lastFg = stateByBlock.get(lastBlock)!;
    let feeNow0 = 0n, feeNow1 = 0n;
    if (nowFg && lastFg.fg0 != null && lastFg.fg1 != null) {
      feeNow0 = (meta.liqNow * (nowFg.fg0 - lastFg.fg0)) >> 128n;
      feeNow1 = (meta.liqNow * (nowFg.fg1 - lastFg.fg1)) >> 128n;
    } else { feesComplete = false; }
    const cur = amountsFromLiquidity(meta.liqNow, meta.tickLower, meta.tickUpper, nowTick);
    events.push(
      { kind: "decrease", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0, amount1: cur.amount1 },
      { kind: "collect", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0 + feeNow0, amount1: cur.amount1 + feeNow1 },
    );
  } else {
    priceT1perT0 = tickToPrice(stateByBlock.get(sortedRaw[sortedRaw.length - 1].blockNumber)!.tick, meta.dec0, meta.dec1);
  }

  const price: PriceFeed = buildV4PriceFeed(stateByBlock, tsByBlock, num.anchorIsToken0, meta.dec0, meta.dec1);

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  const gasWei = (await Promise.all(txHashes.map((h) => client.getTransactionReceipt({ hash: h as `0x${string}` }))))
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
    priceT1perT0, priceBasis, txHashes, exitTx: exitTxHash(events), gasEth, result,
  };
}
