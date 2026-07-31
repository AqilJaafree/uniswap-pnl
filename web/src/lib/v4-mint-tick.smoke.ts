/**
 * ROOT-CAUSE PROBE for the inflated v4/USDG PnL.
 *
 * Hypothesis: the tick used to value a position's MINT is the pool's genesis
 * (Initialize) tick, not the real tick at the mint block. Two things combine:
 *   1. `slot0TickAt(mintBlock)` returns null once that block's state is pruned
 *      (~14 days on this RPC), so the authoritative source is unavailable.
 *   2. The fallback `tickAtBlock(swaps, mintBlock, initTick)` is fed swaps
 *      fetched from `mintBlock`..head — so NO swap exists strictly before the
 *      mint block, and it returns `initTick`.
 * Result: `amountsFromLiquidity` reconstructs the deposit on the wrong side of
 * the range, and `depositedUsd` is priced at a genesis price.
 *
 * Evidence printed per position: pruned?, swap window, initTick, fallback tick,
 * the resulting geometric deposit, and the ACTUAL ERC20 amounts the wallet spent
 * in the mint tx (ground truth).
 *
 * Run: RPC_URL=... npx tsx web/src/lib/v4-mint-tick.smoke.ts 247264 248557 251383
 */
import "./rpc-throttle.smoke";
import { parseAbiItem, getAddress, toHex, decodeEventLog, type Address } from "viem";
import { client } from "./chain";
import { ROBINHOOD_CHAIN, amountsFromLiquidity } from "./uniswap-v3-pnl";
import { computeV4PoolId, unpackPositionInfo, tickToPrice, tickAtBlock, type V4SwapPoint } from "./v4-decode";

const WALLET = getAddress("0x7e995decc404633CF2889968537D723c55ffEA2C");
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);

const evErc721 = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const evErc20 = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const evSwap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const evInit = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const fnGetPPI = parseAbiItem("function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)");
const fnSlot0 = parseAbiItem("function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");

const ids = process.argv.slice(2).map((s) => BigInt(s));

async function tok(a: Address) {
  const [sym, dec] = (await Promise.all([
    client.readContract({ address: a, abi: [fnSymbol], functionName: "symbol" }),
    client.readContract({ address: a, abi: [fnDecimals], functionName: "decimals" }),
  ])) as [string, number];
  return { sym, dec };
}

/** ERC20 amounts the wallet net-spent (negative) or received (positive) in one tx. */
async function flowsInTx(tx: string, c0: Address, c1: Address) {
  const r = await client.getTransactionReceipt({ hash: tx as `0x${string}` });
  let a0 = 0n, a1 = 0n;
  for (const log of r.logs) {
    let addr: Address;
    try { addr = getAddress(log.address); } catch { continue; }
    if (addr !== c0 && addr !== c1) continue;
    let d: { args: { from: string; to: string; value?: bigint } };
    try { d = decodeEventLog({ abi: [evErc20], data: log.data, topics: log.topics }) as typeof d; } catch { continue; }
    if (typeof d.args.value !== "bigint") continue;
    const to = getAddress(d.args.to), from = getAddress(d.args.from);
    const sign = to === WALLET ? 1n : from === WALLET ? -1n : 0n;
    if (sign === 0n) continue;
    if (addr === c0) a0 += sign * d.args.value; else a1 += sign * d.args.value;
  }
  return { a0, a1 };
}

async function main() {
  const head = await client.getBlockNumber();
  console.log(`head block ${head}\n`);

  for (const tokenId of ids) {
    const nftLogs = await client.getLogs({ address: POSM, event: evErc721, args: { tokenId }, fromBlock: 0n, toBlock: "latest" });
    const mintBlock = nftLogs[0]?.blockNumber ?? 0n;

    const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [tokenId] })) as unknown as [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint];
    const pk = { currency0: res[0].currency0, currency1: res[0].currency1, fee: Number(res[0].fee), tickSpacing: Number(res[0].tickSpacing), hooks: res[0].hooks };
    const poolId = computeV4PoolId(pk);
    const { tickLower, tickUpper } = unpackPositionInfo(BigInt(res[1]));
    const c0 = getAddress(pk.currency0), c1 = getAddress(pk.currency1);
    const [m0, m1] = await Promise.all([tok(c0), tok(c1)]);

    console.log(`${"=".repeat(74)}`);
    console.log(`#${tokenId}  ${m0.sym}/${m1.sym}  fee=${pk.fee}  mintBlock=${mintBlock}  (age ${head - mintBlock} blocks)`);
    console.log(`  range ticks [${tickLower}, ${tickUpper}] → price ${tickToPrice(tickLower, m0.dec, m1.dec).toExponential(4)} .. ${tickToPrice(tickUpper, m0.dec, m1.dec).toExponential(4)} ${m1.sym}/${m0.sym}`);

    // (1) is the mint block's state pruned?
    let prunedAtMint = false, liveTickAtMint: number | null = null;
    try {
      const s = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [poolId as `0x${string}`], blockNumber: mintBlock })) as readonly [bigint, number];
      liveTickAtMint = Number(s[1]);
    } catch { prunedAtMint = true; }
    console.log(`  [1] StateView.getSlot0 @ mintBlock : ${prunedAtMint ? "PRUNED (null) ← authoritative tick unavailable" : `tick=${liveTickAtMint}`}`);

    // (2) chain-v4 fetches swaps from `mintBlock`..head, then tickAtBlock keeps only
    // those with blockNumber <= mintBlock — i.e. ONLY swaps inside the mint block
    // itself can ever win. So querying that single block is sufficient and exact.
    const swapLogs = await client.getLogs({ address: PM, event: evSwap, args: { id: poolId as `0x${string}` }, fromBlock: mintBlock, toBlock: mintBlock });
    const swaps: V4SwapPoint[] = swapLogs.map((l) => ({ blockNumber: l.blockNumber!, logIndex: l.logIndex!, tick: Number((l.args as { tick: number }).tick) }));
    console.log(`  [2] swaps IN the mint block      : ${swaps.length}${swaps.length === 0 ? "  ← none, so tickAtBlock can only return initTick" : `  ticks=${swaps.map((s) => s.tick).join(",")}`}`);

    // (3) genesis tick
    const initLogs = await client.getLogs({ address: PM, event: evInit, args: { id: poolId as `0x${string}` }, fromBlock: 0n, toBlock: "latest" });
    const initTick = initLogs.length ? Number((initLogs[0].args as { tick: number }).tick) : 0;
    const fallback = tickAtBlock(swaps, mintBlock, initTick);
    console.log(`  [3] Initialize (genesis) tick     : ${initTick}   → price ${tickToPrice(initTick, m0.dec, m1.dec).toExponential(4)}`);
    console.log(`  [4] tick the code ACTUALLY uses   : ${prunedAtMint ? fallback : liveTickAtMint}${prunedAtMint && fallback === initTick ? "   ← GENESIS TICK (fallback hit)" : ""}`);

    // (5) mint's liquidityDelta → geometric deposit at that tick
    const mods = await client.getLogs({ address: PM, event: evModify, args: { id: poolId as `0x${string}` }, fromBlock: mintBlock, toBlock: mintBlock });
    const salt = toHex(tokenId, { size: 32 }).toLowerCase();
    const mine = mods.filter((l) => { const a = l.args as { sender: string; salt: string }; return getAddress(a.sender) === POSM && a.salt.toLowerCase() === salt; });
    if (mine.length) {
      const L = (mine[0].args as { liquidityDelta: bigint }).liquidityDelta;
      const usedTick = prunedAtMint ? fallback : liveTickAtMint!;
      const geo = amountsFromLiquidity(L < 0n ? -L : L, tickLower, tickUpper, usedTick);
      console.log(`  [5] geometric deposit @ used tick : ${(Number(geo.amount0) / 10 ** m0.dec).toFixed(4)} ${m0.sym} + ${(Number(geo.amount1) / 10 ** m1.dec).toFixed(4)} ${m1.sym}`);
      const gt = await flowsInTx(mine[0].transactionHash!, c0, c1);
      console.log(`  [6] ACTUAL spend in mint tx (GT)  : ${(Number(-gt.a0) / 10 ** m0.dec).toFixed(4)} ${m0.sym} + ${(Number(-gt.a1) / 10 ** m1.dec).toFixed(4)} ${m1.sym}`);
      // what tick would reproduce the actual deposit? scan the range for the best fit
      let bestTick = tickLower, bestErr = Infinity;
      for (let t = tickLower - 2000; t <= tickUpper + 2000; t += 10) {
        const g = amountsFromLiquidity(L < 0n ? -L : L, tickLower, tickUpper, t);
        const e = Math.abs(Number(g.amount0 + gt.a0)) / 10 ** m0.dec + Math.abs(Number(g.amount1 + gt.a1)) / 10 ** m1.dec;
        if (e < bestErr) { bestErr = e; bestTick = t; }
      }
      console.log(`  [7] tick implied by ACTUAL spend  : ~${bestTick}   (vs used ${usedTick}, delta ${bestTick - usedTick} ticks)`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
