/**
 * Live Robinhood Chain PnL.
 *
 *   pnpm add viem
 *   npx tsx live.ts 0x<txhash>        [--usd 3000]   # single position from a tx
 *   npx tsx live.ts wallet 0x<addr>   [--usd 3000]   # sweep every position
 *
 * Closed positions → realized PnL (exit price from the burn, archive-free).
 * Open positions   → marked-to-market at the current pool price + unclaimed fees.
 * Pricing is WETH-numeraire; --usd adds a dollar column at the given ETH price.
 */
import { createPublicClient, http, defineChain, parseAbiItem, parseEventLogs, getAddress, type Address } from "viem";
import {
  computePnL, formatCard, closedExitPrice, buildImpliedPriceFeed, amountsFromLiquidity, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.chainId,
  name: "Robinhood Chain",
  nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
});
export const client = createPublicClient({ chain: robinhoodChain, transport: http() });

const NPM = getAddress(ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager);
const FACTORY = getAddress(ROBINHOOD_CHAIN.uniswapV3.factory);
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73"); // Robinhood Chain WETH

const evIncrease = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evDecrease = parseAbiItem("event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evCollect  = parseAbiItem("event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)");
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const fnPositions = parseAbiItem("function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 f0, uint256 f1, uint128 owed0, uint128 owed1)");
const fnGetPool = parseAbiItem("function getPool(address,address,uint24) view returns (address)");
const fnSlot0 = parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");

const sqrtToPrice = (sqrtX96: bigint, dec0: number, dec1: number) => {
  const sp = Number(sqrtX96) / 2 ** 96;
  return sp * sp * 10 ** (dec0 - dec1); // whole token1 per whole token0
};

// ── Full lifecycle for a tokenId from NPM logs ──
async function fetchLifecycle(tokenId: bigint): Promise<LiquidityEvent[]> {
  const [inc, dec, col] = await Promise.all([
    client.getLogs({ address: NPM, event: evIncrease, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: NPM, event: evDecrease, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: NPM, event: evCollect,  args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const raw = [
    ...inc.map((l) => ({ kind: "increase" as const, l })),
    ...dec.map((l) => ({ kind: "decrease" as const, l })),
    ...col.map((l) => ({ kind: "collect"  as const, l })),
  ].sort((a, b) => Number(a.l.blockNumber! - b.l.blockNumber!) || (a.l.logIndex! - b.l.logIndex!));

  const blocks = [...new Set(raw.map((r) => r.l.blockNumber!))];
  const ts = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => ts.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp))));

  return raw.map(({ kind, l }) => ({
    kind, tokenId,
    txHash: l.transactionHash!, blockNumber: l.blockNumber!, timestamp: ts.get(l.blockNumber!)!,
    amount0: (l.args as any).amount0 as bigint,
    amount1: (l.args as any).amount1 as bigint,
    liquidity: (l.args as any).liquidity as bigint | undefined,
  }));
}

export interface PositionPnL {
  tokenId: bigint;
  sym0: string; sym1: string; fee: number;
  tickLower: number; tickUpper: number;
  open: boolean;
  numeraire: string;
  priceT1perT0: number;
  priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";
  result: PnLResult;
}

// ── Core: PnL for one position (closed = realized, open = marked-to-market) ──
export async function computePositionPnL(tokenId: bigint): Promise<PositionPnL> {
  const p = await client.readContract({ address: NPM, abi: [fnPositions], functionName: "positions", args: [tokenId] });
  const [, , token0, token1, fee, tickLower, tickUpper, liqNow, , , owed0, owed1] =
    p as unknown as [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

  const [dec0, dec1, sym0, sym1] = (await Promise.all([
    client.readContract({ address: token0, abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: token1, abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: token0, abi: [fnSymbol], functionName: "symbol" }),
    client.readContract({ address: token1, abi: [fnSymbol], functionName: "symbol" }),
  ])) as [number, number, string, string];

  const events = [...(await fetchLifecycle(tokenId))];
  const open = liqNow > 0n;
  let priceT1perT0: number;
  let priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";

  if (open) {
    // Mark-to-market: value current liquidity + unclaimed fees at the live pool price.
    const pool = (await client.readContract({ address: FACTORY, abi: [fnGetPool], functionName: "getPool", args: [token0, token1, Number(fee)] })) as Address;
    const s0 = (await client.readContract({ address: pool, abi: [fnSlot0], functionName: "slot0" })) as unknown as [bigint, number];
    priceT1perT0 = sqrtToPrice(s0[0], dec0, dec1);
    priceBasis = "mark-to-market";
    const nowTs = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    const cur = amountsFromLiquidity(liqNow, tickLower, tickUpper, s0[1]);
    events.push(
      { kind: "decrease", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0, amount1: cur.amount1 },
      { kind: "collect",  tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0 + owed0, amount1: cur.amount1 + owed1 },
    );
  } else {
    // Closed: exit price from the final burn. In-range → exact; out-of-range → pinned
    // to the boundary it crossed (archive-free, stable). Only fall back to the LIVE
    // price when there is no burn at all (e.g. NFT holds only claimed fees).
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

  const token0IsWeth = getAddress(token0) === WETH;
  // Price every event from its OWN geometry so the deposit is valued at
  // deposit-time price (not the exit price). `priceT1perT0` anchors the close.
  const markTs = events.reduce((m, e) => Math.max(m, e.timestamp), 0);
  const rawFeed = buildImpliedPriceFeed(events, tickLower, tickUpper, dec0, dec1, priceT1perT0, markTs);
  const price: PriceFeed = (ts) =>
    token0IsWeth ? { p0: 1, p1: 1 / rawFeed(ts) } : { p0: rawFeed(ts), p1: 1 };

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  const gasWei = (await Promise.all(txHashes.map((h) => client.getTransactionReceipt({ hash: h as `0x${string}` }))))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: sym0, symbol1: sym1, decimals0: dec0, decimals1: dec1, feeUnits: Number(fee) };
  const result = computePnL(events, pair, price, { gasUsd: Number(gasWei) / 1e18 });

  return { tokenId, sym0, sym1, fee: Number(fee), tickLower, tickUpper, open, numeraire: token0IsWeth ? sym0 : sym1, priceT1perT0, priceBasis, result };
}

// ── paste-a-tx-hash → one card ──
export async function pnlFromTxHash(txHash: `0x${string}`, ethUsd?: number) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const parsed = parseEventLogs({ abi: [evIncrease, evDecrease, evCollect], logs: receipt.logs });
  if (!parsed.length) throw new Error("no NonfungiblePositionManager liquidity event in this tx");
  const tokenId = (parsed[0].args as { tokenId: bigint }).tokenId;
  const pos = await computePositionPnL(tokenId);
  printCard(pos, ethUsd);
  return pos;
}

// ── sweep every position a wallet ever received ──
export async function pnlForWallet(wallet: string, ethUsd?: number) {
  const logs = await client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: 0n, toBlock: "latest" });
  const tokenIds = [...new Set(logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
  console.log(`${tokenIds.length} position NFT(s) ever received by ${getAddress(wallet)}\n`);

  const rows: PositionPnL[] = [];
  for (const id of tokenIds) {
    try { rows.push(await computePositionPnL(id)); }
    catch (e: any) { console.warn(`  #${id}  skipped: ${e.shortMessage || e.message}`); }
  }
  rows.sort((a, b) => b.result.netPnlUsd - a.result.netPnlUsd);

  console.log("  #tokenId   pair                status   net(Ξ)      fees(Ξ)     IL(Ξ)       PnL%");
  console.log("  " + "─".repeat(84));
  for (const r of rows) {
    const R = r.result;
    console.log(
      `  ${String(r.tokenId).padEnd(9)} ${(`${r.sym0}/${r.sym1} ${r.fee / 1e4}%`).padEnd(19)} ${(r.open ? "open" : "closed").padEnd(8)}` +
      `${sign(R.netPnlUsd)}  ${R.feesUsd.toFixed(6)}  ${R.ilUsd.toFixed(6)}  ${(R.pnlPct * 100).toFixed(1)}%${approxFlag(r)}`,
    );
  }
  if (rows.some(isApprox)) console.log(`  ≈ = out-of-range exit; IL priced at the range boundary crossed (exact exit price is unrecoverable without an archive).`);
  const sum = (f: (r: PnLResult) => number) => rows.reduce((a, r) => a + f(r.result), 0);
  const net = sum((r) => r.netPnlUsd), fees = sum((r) => r.feesUsd), il = sum((r) => r.ilUsd), gas = sum((r) => r.gasUsd), dep = sum((r) => r.depositedUsd);
  console.log("  " + "─".repeat(84));
  console.log(`  TOTAL (${rows.length} pos)  deposited Ξ${dep.toFixed(6)}   net ${sign(net)}   fees +Ξ${fees.toFixed(6)}   IL ${sign(il)}   gas Ξ${gas.toFixed(6)}`);
  if (ethUsd) console.log(`  at ETH=$${ethUsd}:  deposited $${(dep * ethUsd).toFixed(2)}   net ${net >= 0 ? "+" : "-"}$${Math.abs(net * ethUsd).toFixed(2)}   fees +$${(fees * ethUsd).toFixed(2)}`);
  return rows;
}

const sign = (w: number) => `${w >= 0 ? "+" : "-"}Ξ${Math.abs(w).toFixed(6)}`;
const isApprox = (p: PositionPnL) => p.priceBasis === "lower-boundary" || p.priceBasis === "upper-boundary" || p.priceBasis === "live-fallback";
const approxFlag = (p: PositionPnL) => (isApprox(p) ? " ≈" : "");

function printCard(pos: PositionPnL, ethUsd?: number) {
  const { result: r, numeraire: num } = pos;
  const sym = num === "WETH" ? "Ξ" : num;
  const basisNote = isApprox(pos) ? `  [exit ≈ ${pos.priceBasis}: out-of-range, IL approximate]` : "";
  console.log(`position ${pos.tokenId}  ${pos.sym0}/${pos.sym1} ${pos.fee / 1e4}%  ${pos.open ? "(OPEN — marked-to-market)" : "(closed)"}  ticks [${pos.tickLower}, ${pos.tickUpper}]  1 ${pos.sym0} = ${pos.priceT1perT0.toFixed(0)} ${pos.sym1}${basisNote}`);
  console.log(formatCard(r).replace(/\$/g, sym));
  console.log(`Net ${sym}${r.netPnlUsd.toFixed(6)} (${(r.pnlPct * 100).toFixed(2)}%)  ·  fees ${sym}${r.feesUsd.toFixed(6)}  ·  IL ${sym}${r.ilUsd.toFixed(6)}  ·  gas ${sym}${r.gasUsd.toFixed(6)}`);
  if (ethUsd) console.log(`— at ETH=$${ethUsd} —  deposited $${(r.depositedUsd * ethUsd).toFixed(2)}   net ${r.netPnlUsd >= 0 ? "+" : "-"}$${Math.abs(r.netPnlUsd * ethUsd).toFixed(2)}   fees +$${(r.feesUsd * ethUsd).toFixed(2)}`);
}

// ── CLI ──
const a = process.argv.slice(2);
const usdIdx = a.indexOf("--usd");
const ethUsd = usdIdx > -1 ? Number(a[usdIdx + 1]) : undefined;
const run =
  a[0] === "wallet" ? pnlForWallet(a[1], ethUsd)
  : a[0]?.startsWith("0x") ? pnlFromTxHash(a[0] as `0x${string}`, ethUsd)
  : Promise.resolve(a.length ? console.error("usage: live.ts 0x<txhash> | wallet 0x<addr> [--usd 3000]") : undefined);
run.catch((e: any) => { console.error("error:", e.shortMessage || e.message); process.exit(1); });
