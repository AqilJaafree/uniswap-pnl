/**
 * Uniswap v4 browser data layer for Robinhood chain — mirrors chain.ts (v3) but
 * reads the v4 PoolManager / PositionManager / StateView. Reuses the shared viem
 * client and the pure engine + v4-decode helpers. Returns the same PositionPnL
 * shape as v3 so the UI is protocol-agnostic.
 */
import { parseAbiItem, getAddress, toHex } from "viem";
import { client, type PositionPnL } from "./chain";
import {
  computePnL, amountsFromLiquidity, exitTxHash, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlock, type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
} from "./v4-decode";

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const NATIVE = getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH);

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

/** Archive-free tick source: all Swaps for the pool since the position's mint + the Initialize tick. */
async function fetchTickSource(meta: V4Meta): Promise<{ swaps: V4SwapPoint[]; initTick: number }> {
  const [swapLogs, initLogs] = await Promise.all([
    client.getLogs({ address: PM, event: evSwap, args: { id: meta.poolId as `0x${string}` }, fromBlock: meta.mintBlock, toBlock: "latest" }),
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
  const logs = await client.getLogs({ address: PM, event: evModify, args: { id: meta.poolId as `0x${string}` }, fromBlock: meta.mintBlock, toBlock: "latest" });
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

export async function computePositionPnLV4(tokenId: bigint, mintBlock: bigint): Promise<PositionPnL> {
  const meta = await fetchMeta(tokenId, mintBlock);
  const num = pickNumeraire(meta.poolKey.currency0, meta.poolKey.currency1, meta.sym0, meta.sym1);
  if (!num) throw new Error(`unsupported v4 pair ${meta.sym0}/${meta.sym1}`);

  const { raw, tsByBlock } = await fetchV4Lifecycle(tokenId, meta);
  if (raw.length === 0) throw new Error(`no v4 liquidity events for #${tokenId}`);
  const sortedRaw = [...raw].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

  // tick from Swap logs (archive-free); fee-growth best-effort per event block
  const { swaps, initTick } = await fetchTickSource(meta);
  const eventBlocks = [...new Set(raw.map((r) => r.blockNumber))];
  const stateByBlock = new Map<bigint, BlockState>();
  await Promise.all(eventBlocks.map(async (bn) => {
    const fg = await feeGrowthAt(meta, bn);
    stateByBlock.set(bn, { tick: tickAtBlock(swaps, bn, initTick), fg0: fg?.fg0 ?? null, fg1: fg?.fg1 ?? null });
  }));

  const open = meta.liqNow > 0n;
  const built = buildV4Events(raw, stateByBlock, meta.dec0, meta.dec1, tokenId);
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
  const result = computePnL(events, pair, price, { gasUsd: Number(gasWei) / 1e18 });

  return {
    tokenId, sym0: meta.sym0, sym1: meta.sym1, fee: meta.poolKey.fee,
    tickLower: meta.tickLower, tickUpper: meta.tickUpper, open,
    numeraire: num.symbol, numeraireKind: num.kind, version: "v4", feesComplete,
    priceT1perT0, priceBasis, txHashes, exitTx: exitTxHash(events), result,
  };
}
