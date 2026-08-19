/**
 * How many pool-wide v4 logs a wallet's positions actually pull in — the number that
 * decides whether caching them is affordable at all.
 *
 * Written after the first run of scan-cache.smoke.ts died with a 4 GB heap: the cache was
 * holding whole viem log objects for every Swap in every pool the wallet touches, and
 * nothing in the unit tests or the request counts could show that. This answers it in
 * about a dozen requests instead of a forty-minute scan.
 *
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/v4-logvolume.smoke.ts [wallet]
 */
import { parseAbiItem, getAddress } from "viem";
import { client } from "./chain";
import { getLogsChunked } from "./rpc-logs";
import { computeV4PoolId, unpackPositionInfo, type PoolKey } from "./v4-decode";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

const WALLET = process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C";
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);

const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const evSwap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const fnGetPPI = parseAbiItem("function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)");

/** Rough retained size of one decoded log, measured the only way available in-process. */
function approxBytes(v: unknown): number {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))?.length ?? 0;
}

async function main() {
  const head = await client.getBlockNumber();
  const mints = await getLogsChunked(
    (f, t) => client.getLogs({ address: POSM, event: evTransfer, args: { to: getAddress(WALLET) }, fromBlock: f, toBlock: t }),
    0n, head);

  const earliestMint = new Map<bigint, bigint>();
  for (const l of mints) {
    const id = (l.args as { tokenId: bigint }).tokenId;
    const bn = l.blockNumber!;
    if (!earliestMint.has(id) || bn < earliestMint.get(id)!) earliestMint.set(id, bn);
  }
  console.log(`wallet ${WALLET}: ${earliestMint.size} v4 positions, head ${head}`);

  // Distinct (pool, mintBlock) pairs — that pairing IS the cache key, so it is what
  // decides how many separate copies of a pool's history get stored.
  const pairs = new Map<string, { poolId: string; mintBlock: bigint; ids: number }>();
  for (const [tokenId, mintBlock] of earliestMint) {
    const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [tokenId] })) as unknown as [PoolKey, bigint];
    const poolKey = { currency0: res[0].currency0, currency1: res[0].currency1, fee: Number(res[0].fee), tickSpacing: Number(res[0].tickSpacing), hooks: res[0].hooks };
    unpackPositionInfo(BigInt(res[1]));
    const poolId = computeV4PoolId(poolKey);
    const k = `${poolId}:${mintBlock}`;
    const hit = pairs.get(k);
    if (hit) hit.ids++; else pairs.set(k, { poolId, mintBlock, ids: 1 });
  }
  console.log(`  ${pairs.size} distinct (pool, mintBlock) cache keys across ${new Set([...pairs.values()].map((p) => p.poolId)).size} pools\n`);

  let swapTotal = 0, modTotal = 0, rawBytes = 0, projBytes = 0;
  for (const { poolId, mintBlock, ids } of pairs.values()) {
    const [swaps, mods] = await Promise.all([
      getLogsChunked((f, t) => client.getLogs({ address: PM, event: evSwap, args: { id: poolId as `0x${string}` }, fromBlock: f, toBlock: t }), mintBlock, head),
      getLogsChunked((f, t) => client.getLogs({ address: PM, event: evModify, args: { id: poolId as `0x${string}` }, fromBlock: f, toBlock: t }), mintBlock, head),
    ]);
    swapTotal += swaps.length; modTotal += mods.length;
    if (swaps.length) {
      const one = swaps[0];
      const proj = { blockNumber: one.blockNumber, logIndex: one.logIndex, tick: Number((one.args as { tick: number }).tick) };
      rawBytes += approxBytes(one) * swaps.length;
      projBytes += approxBytes(proj) * swaps.length;
    }
    console.log(`  ${poolId.slice(0, 12)}… mint ${mintBlock}  (${ids} position${ids > 1 ? "s" : ""}):  ${swaps.length} swaps, ${mods.length} modifies`);
  }

  console.log(`\ntotal cached log objects: ${swapTotal} swaps + ${modTotal} modifies`);
  console.log(`swap logs, whole viem object : ~${(rawBytes / 2 ** 20).toFixed(1)} MB of JSON`);
  console.log(`swap logs, projected         : ~${(projBytes / 2 ** 20).toFixed(1)} MB of JSON`);
  console.log(`reduction                    : ${rawBytes ? (rawBytes / Math.max(1, projBytes)).toFixed(1) : "n/a"}x`);
  console.log(`\n(JSON length is a proxy, not a heap measurement — V8 object overhead makes the`);
  console.log(` real retained size several times larger, which is how 4 GB happened.)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
