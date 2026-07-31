/**
 * DIAGNOSTIC (live RPC): audit every USDG-quoted position of a wallet.
 *
 * For each position it prints (a) what the app computes and (b) an INDEPENDENT
 * ground truth built from raw ERC20 Transfer flows in the position's own txs.
 * For a fully-closed USDG position whose non-USDG leg nets to ~0, net PnL in USD
 * MUST equal the wallet's net USDG delta — that's an exact, assumption-free check.
 *
 * Also recomputes v3 pending (unclaimed) fees from feeGrowthInside to test whether
 * the app's use of `tokensOwed` alone understates fees on an OPEN v3 position.
 *
 * Run: RPC_URL=https://rpc.mainnet.chain.robinhood.com npx tsx web/src/lib/usdg-audit.smoke.ts [wallet]
 */
import "./rpc-throttle.smoke"; // MUST precede ./chain — installs the RPC throttle
import { parseAbiItem, getAddress, decodeEventLog, type Address } from "viem";
import { client, computePositionPnL, type PositionPnL } from "./chain";
import { computePositionPnLV4 } from "./chain-v4";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";
import { computeV4PoolId, unpackPositionInfo } from "./v4-decode";

const WALLET = getAddress(process.argv[2] ?? "0x7e995decc404633CF2889968537D723c55ffEA2C");
const USDG = getAddress(ROBINHOOD_CHAIN.tokens.USDG);
const NPM = getAddress(ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager);
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const FACTORY = getAddress(ROBINHOOD_CHAIN.uniswapV3.factory);

const evErc721 = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const evErc20 = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const fnPositions = parseAbiItem("function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 fg0Last, uint256 fg1Last, uint128 owed0, uint128 owed1)");
const fnGetPPI = parseAbiItem("function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)");
const fnGetPool = parseAbiItem("function getPool(address,address,uint24) view returns (address)");
const fnSlot0V3 = parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)");
const fnFgGlobal0 = parseAbiItem("function feeGrowthGlobal0X128() view returns (uint256)");
const fnFgGlobal1 = parseAbiItem("function feeGrowthGlobal1X128() view returns (uint256)");
const fnTicks = parseAbiItem("function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");
const fnGetLiqV4 = parseAbiItem("function getPositionLiquidity(uint256 tokenId) view returns (uint128)");
const fnFGIV4 = parseAbiItem("function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 fg0, uint256 fg1)");

const U256 = 1n << 256n;
const wrap = (a: bigint, b: bigint) => (a - b + U256) % U256; // v3 fee growth is intentionally overflowing
const f = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Net ERC20 delta for the wallet across a set of txs, for two specific tokens. */
async function netFlows(txs: string[], t0: Address, t1: Address) {
  let a0 = 0n, a1 = 0n, gas = 0n;
  for (const tx of txs) {
    const r = await client.getTransactionReceipt({ hash: tx as `0x${string}` });
    gas += r.gasUsed * r.effectiveGasPrice;
    for (const log of r.logs) {
      let addr: Address;
      try { addr = getAddress(log.address); } catch { continue; }
      if (addr !== t0 && addr !== t1) continue;
      let d: { args: { from: string; to: string; value?: bigint } };
      try { d = decodeEventLog({ abi: [evErc20], data: log.data, topics: log.topics }) as typeof d; } catch { continue; }
      if (typeof d.args.value !== "bigint") continue;
      const to = getAddress(d.args.to), from = getAddress(d.args.from);
      const sign = to === WALLET ? 1n : from === WALLET ? -1n : 0n;
      if (sign === 0n) continue;
      if (addr === t0) a0 += sign * d.args.value; else a1 += sign * d.args.value;
    }
  }
  return { a0, a1, gas };
}

/** True pending v3 fees from feeGrowthInside — what `tokensOwed` alone misses. */
async function pendingV3Fees(tokenId: bigint) {
  const p = (await client.readContract({ address: NPM, abi: [fnPositions], functionName: "positions", args: [tokenId] })) as unknown as
    [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
  const [, , token0, token1, fee, tickLower, tickUpper, liq, fg0Last, fg1Last, owed0, owed1] = p;
  if (liq === 0n) return null;
  const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [token0, token1, Number(fee)] })) as Address;
  const [s0, g0, g1, tl, tu] = await Promise.all([
    client.readContract({ address: pool, abi: [fnSlot0V3], functionName: "slot0" }) as Promise<readonly [bigint, number]>,
    client.readContract({ address: pool, abi: [fnFgGlobal0], functionName: "feeGrowthGlobal0X128" }) as Promise<bigint>,
    client.readContract({ address: pool, abi: [fnFgGlobal1], functionName: "feeGrowthGlobal1X128" }) as Promise<bigint>,
    client.readContract({ address: pool, abi: [fnTicks], functionName: "ticks", args: [tickLower] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
    client.readContract({ address: pool, abi: [fnTicks], functionName: "ticks", args: [tickUpper] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
  ]);
  const tick = Number(s0[1]);
  // feeGrowthInside = global - below - above  (all mod 2^256)
  const below0 = tick >= tickLower ? tl[2] : wrap(g0, tl[2]);
  const below1 = tick >= tickLower ? tl[3] : wrap(g1, tl[3]);
  const above0 = tick < tickUpper ? tu[2] : wrap(g0, tu[2]);
  const above1 = tick < tickUpper ? tu[3] : wrap(g1, tu[3]);
  const inside0 = wrap(wrap(g0, below0), above0);
  const inside1 = wrap(wrap(g1, below1), above1);
  const pend0 = (liq * wrap(inside0, fg0Last)) >> 128n;
  const pend1 = (liq * wrap(inside1, fg1Last)) >> 128n;
  return { token0, token1, owed0, owed1, pend0, pend1, tick, tickLower, tickUpper, liq };
}

/** True pending v4 fees from StateView fee-growth vs the position's last checkpoint. */
async function pendingV4Fees(tokenId: bigint, meta: { poolId: string; tickLower: number; tickUpper: number }) {
  const liq = (await client.readContract({ address: POSM, abi: [fnGetLiqV4], functionName: "getPositionLiquidity", args: [tokenId] })) as bigint;
  if (liq === 0n) return null;
  const fgi = (await client.readContract({ address: SV, abi: [fnFGIV4], functionName: "getFeeGrowthInside", args: [meta.poolId as `0x${string}`, meta.tickLower, meta.tickUpper] })) as readonly [bigint, bigint];
  return { liq, fg0: fgi[0], fg1: fgi[1] };
}

async function tokMeta(a: Address) {
  if (a === getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH)) return { dec: 18, sym: "ETH" };
  const [dec, sym] = (await Promise.all([
    client.readContract({ address: a, abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: a, abi: [fnSymbol], functionName: "symbol" }),
  ])) as [number, string];
  return { dec, sym };
}

async function main() {
  console.log(`wallet ${WALLET}\nRPC ${process.env.RPC_URL ?? "(default)"}\n`);

  const v3Logs = await client.getLogs({ address: NPM, event: evErc721, args: { to: WALLET }, fromBlock: 0n, toBlock: "latest" });
  const v3Ids = [...new Set(v3Logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
  const v4Logs = await client.getLogs({ address: POSM, event: evErc721, args: { to: WALLET }, fromBlock: 0n, toBlock: "latest" });
  const v4Map = new Map<bigint, bigint>();
  for (const l of v4Logs) {
    const id = (l.args as { tokenId: bigint }).tokenId;
    if (!v4Map.has(id) || l.blockNumber! < v4Map.get(id)!) v4Map.set(id, l.blockNumber!);
  }
  console.log(`v3 tokenIds: ${v3Ids.length}   v4 tokenIds: ${v4Map.size}\n`);

  type Row = { pos: PositionPnL; t0: Address; t1: Address; dec0: number; dec1: number };
  const rows: Row[] = [];

  // ── Phase 1: cheap classification. Which tokenIds are USDG pairs? ──
  const v3Usdg: { id: bigint; t0: Address; t1: Address; dec0: number; dec1: number }[] = [];
  for (const id of v3Ids) {
    try {
      const p = (await client.readContract({ address: NPM, abi: [fnPositions], functionName: "positions", args: [id] })) as unknown as [bigint, Address, Address, Address, number, number, number, bigint];
      const t0 = getAddress(p[2]), t1 = getAddress(p[3]);
      if (t0 !== USDG && t1 !== USDG) continue;
      const [m0, m1] = await Promise.all([tokMeta(t0), tokMeta(t1)]);
      v3Usdg.push({ id, t0, t1, dec0: m0.dec, dec1: m1.dec });
    } catch { /* burned */ }
  }
  const v4Usdg: { id: bigint; mintBlock: bigint; t0: Address; t1: Address; dec0: number; dec1: number }[] = [];
  for (const [id, mintBlock] of v4Map) {
    try {
      const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [id] })) as unknown as [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint];
      const t0 = getAddress(res[0].currency0), t1 = getAddress(res[0].currency1);
      if (t0 !== USDG && t1 !== USDG) continue;
      const [m0, m1] = await Promise.all([tokMeta(t0), tokMeta(t1)]);
      v4Usdg.push({ id, mintBlock, t0, t1, dec0: m0.dec, dec1: m1.dec });
    } catch { /* unreadable */ }
  }
  console.log(`USDG pairs → v3: ${v3Usdg.length}  v4: ${v4Usdg.length}\n${"=".repeat(78)}`);

  // ── Phase 2: compute + report ONE AT A TIME, streaming ──
  for (const { id, t0, t1, dec0, dec1 } of v3Usdg) {
    try {
      const pos = await computePositionPnL(id);
      rows.push({ pos, t0, t1, dec0, dec1 });
      await report(pos, t0, t1, dec0, dec1);
    } catch (e) { console.log(`\n  !! v3 #${id} FAILED: ${(e as Error).message.split("\n")[0].slice(0, 140)}`); }
  }
  for (const { id, mintBlock, t0, t1, dec0, dec1 } of v4Usdg) {
    try {
      const pos = await computePositionPnLV4(id, mintBlock);
      rows.push({ pos, t0, t1, dec0, dec1 });
      await report(pos, t0, t1, dec0, dec1);
    } catch (e) { console.log(`\n  !! v4 #${id} FAILED: ${(e as Error).message.split("\n")[0].slice(0, 140)}`); }
  }

  console.log(`\n${"=".repeat(78)}\nTOTALS (app): net=$${f(rows.reduce((a, x) => a + x.pos.result.netPnlUsd, 0))}  fees=$${f(rows.reduce((a, x) => a + x.pos.result.feesUsd, 0))}`);
}

async function report(pos: PositionPnL, t0: Address, t1: Address, dec0: number, dec1: number) {
  {
    const r = pos.result;
    const usdgIsT0 = t0 === USDG;
    const w = (raw: bigint, d: number) => Number(raw) / 10 ** d;
    console.log(`\n${pos.version} #${pos.tokenId}  ${pos.sym0}/${pos.sym1}  fee=${pos.fee}  ${pos.open ? "OPEN" : "CLOSED"}  basis=${pos.priceBasis}  feesComplete=${pos.feesComplete}`);
    console.log(`  ticks [${pos.tickLower}, ${pos.tickUpper}]  priceT1perT0=${pos.priceT1perT0}`);
    console.log(`  APP  dep=$${f(r.depositedUsd)}  wd=$${f(r.withdrawnUsd)}  fees=$${f(r.feesUsd)}  net=$${f(r.netPnlUsd)} (${f(r.pnlPct * 100)}%)  IL=$${f(r.ilUsd)}  gasEth=${r.gasUsd === 0 ? pos.gasEth.toExponential(3) : r.gasUsd}`);
    console.log(`  APP  tokens: dep ${f(r.deposited0, 4)} ${pos.sym0} + ${f(r.deposited1, 4)} ${pos.sym1} | wd ${f(r.withdrawn0, 4)} + ${f(r.withdrawn1, 4)} | fees ${f(r.fees0, 4)} + ${f(r.fees1, 4)}`);
    console.log(`  txs (${pos.txHashes.length}): ${pos.txHashes.map((h) => h.slice(0, 10)).join(" ")}`);

    const gt = await netFlows(pos.txHashes, t0, t1);
    const g0 = w(gt.a0, dec0), g1 = w(gt.a1, dec1);
    console.log(`  RAW  wallet net ERC20 flow across those txs: ${f(g0, 4)} ${pos.sym0} , ${f(g1, 4)} ${pos.sym1}   gasEth=${(Number(gt.gas) / 1e18).toExponential(3)}`);
    const usdgDelta = usdgIsT0 ? g0 : g1;
    const otherDelta = usdgIsT0 ? g1 : g0;
    if (!pos.open) {
      // Value the non-USDG residual at the position's exit price so the comparison is
      // apples-to-apples: a position can settle partly in the other token, and counting
      // only the USDG leg would understate the true result.
      // priceT1perT0 is token1-per-token0, so invert when USDG is token0.
      const otherUsd = usdgIsT0 ? otherDelta / pos.priceT1perT0 : otherDelta * pos.priceT1perT0;
      const trueNet = usdgDelta + otherUsd;
      console.log(`  GT   closed → true net = USDG ${f(usdgDelta)} + ${f(otherDelta, 4)} ${usdgIsT0 ? pos.sym1 : pos.sym0} @ exit ($${f(otherUsd)}) = $${f(trueNet)}`);
      console.log(`  DIFF app net $${f(r.netPnlUsd)} vs true $${f(trueNet)}  →  $${f(r.netPnlUsd - trueNet)}`);
    }

    if (pos.open && pos.version === "v3") {
      const pf = await pendingV3Fees(pos.tokenId);
      if (pf) {
        console.log(`  V3-FEE owed(app uses)=${f(w(pf.owed0, dec0), 6)} ${pos.sym0} / ${f(w(pf.owed1, dec1), 6)} ${pos.sym1}`);
        console.log(`  V3-FEE TRUE pending  =${f(w(pf.pend0, dec0), 6)} ${pos.sym0} / ${f(w(pf.pend1, dec1), 6)} ${pos.sym1}   (pool tick ${pf.tick})`);
        const missed0 = w(pf.pend0 - pf.owed0, dec0), missed1 = w(pf.pend1 - pf.owed1, dec1);
        console.log(`  V3-FEE MISSED        =${f(missed0, 6)} ${pos.sym0} / ${f(missed1, 6)} ${pos.sym1}`);
      }
    }
    if (pos.open && pos.version === "v4") {
      const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [pos.tokenId] })) as unknown as [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint];
      const pk = { currency0: res[0].currency0, currency1: res[0].currency1, fee: Number(res[0].fee), tickSpacing: Number(res[0].tickSpacing), hooks: res[0].hooks };
      const { tickLower, tickUpper } = unpackPositionInfo(BigInt(res[1]));
      const pf = await pendingV4Fees(pos.tokenId, { poolId: computeV4PoolId(pk), tickLower, tickUpper });
      if (pf) console.log(`  V4-FEE liq=${pf.liq} fgInside0=${pf.fg0} fgInside1=${pf.fg1}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
