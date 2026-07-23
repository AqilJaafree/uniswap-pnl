/**
 * Browser data layer — same logic as the CLI live.ts, but returns structured
 * data instead of printing. Talks to the same-origin `/rpc` proxy (see
 * server.mjs), which does public-first → paid spillover and hides the paid key.
 * Override with VITE_RPC_URL at build time if needed.
 */
import { createPublicClient, http, defineChain, parseAbiItem, parseEventLogs, getAddress, isAddress, type Address } from "viem";
import {
  computePnL, closedExitPrice, buildImpliedPriceFeed, exitTxHash, amountsFromLiquidity, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";
import { pickNumeraire, numerairePricePoint, type NumeraireKind } from "./numeraire";
import { computePositionPnLV4 } from "./chain-v4";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.chainId,
  name: "Robinhood Chain",
  nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
});
// Same-origin proxy by default; spillover across RPCs happens server-side, so
// keep client retries low (a throttled call spills upstream, not here).
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "/rpc";
export const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL, { retryCount: 2, retryDelay: 300 }) });

const retry = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
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

export interface PositionPnL {
  tokenId: bigint;
  version: "v3" | "v4";
  sym0: string; sym1: string; fee: number;
  tickLower: number; tickUpper: number;
  open: boolean;
  numeraire: string; // display symbol: "WETH" (Ξ) or "USD"
  numeraireKind: NumeraireKind;
  feesComplete: boolean; // false when some v4 fee-growth state was pruned (fees understated)
  priceT1perT0: number;
  priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";
  txHashes: string[];
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

async function fetchLifecycle(tokenId: bigint): Promise<LiquidityEvent[]> {
  const [inc, dec, col] = await Promise.all([
    client.getLogs({ address: NPM, event: evIncrease, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: NPM, event: evDecrease, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: NPM, event: evCollect, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const raw = [
    ...inc.map((l) => ({ kind: "increase" as const, l })),
    ...dec.map((l) => ({ kind: "decrease" as const, l })),
    ...col.map((l) => ({ kind: "collect" as const, l })),
  ].sort((a, b) => Number(a.l.blockNumber! - b.l.blockNumber!) || a.l.logIndex! - b.l.logIndex!);

  const blocks = [...new Set(raw.map((r) => r.l.blockNumber!))];
  const ts = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => ts.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp))));

  return raw.map(({ kind, l }) => ({
    kind, tokenId,
    txHash: l.transactionHash!, blockNumber: l.blockNumber!, timestamp: ts.get(l.blockNumber!)!,
    amount0: (l.args as { amount0: bigint }).amount0,
    amount1: (l.args as { amount1: bigint }).amount1,
    liquidity: (l.args as { liquidity?: bigint }).liquidity,
  }));
}

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
  const gasWei = (await Promise.all(txHashes.map((h) => client.getTransactionReceipt({ hash: h as `0x${string}` }))))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: sym0, symbol1: sym1, decimals0: dec0, decimals1: dec1, feeUnits: Number(fee) };
  // Gas is native ETH. Keep net PRE-gas here (engine can't price ETH→USD for a USD
  // pair with no WETH leg) and fold gas in at display via the UI's ETH/USD rate.
  const gasEth = Number(gasWei) / 1e18;
  const result = computePnL(events, pair, price);

  return { tokenId, version: "v3", sym0, sym1, fee: Number(fee), tickLower, tickUpper, open, numeraire: num.symbol, numeraireKind: num.kind, feesComplete: true, priceT1perT0, priceBasis, txHashes, exitTx: exitTxHash(events), gasEth, result };
}

function totalsOf(positions: PositionPnL[]) {
  const sum = (f: (r: PnLResult) => number) => positions.reduce((a, r) => a + f(r.result), 0);
  return {
    net: sum((r) => r.netPnlUsd), fees: sum((r) => r.feesUsd),
    il: sum((r) => r.ilUsd), gas: positions.reduce((a, p) => a + p.gasEth, 0), count: positions.length,
  };
}

export async function analyzeTx(txHash: string): Promise<Portfolio> {
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
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
    const mints = await client.getLogs({ address: POSM_V4, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: 0n, toBlock: "latest" });
    const pos = await computePositionPnLV4(tokenId, mints[0]?.blockNumber ?? 0n);
    return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsOf([pos]) };
  }
  throw new Error("No Uniswap v3 or v4 position event in this transaction.");
}

export async function analyzeWallet(
  wallet: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Portfolio> {
  const v3Logs = await client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: 0n, toBlock: "latest" });
  const v3Ids = [...new Set(v3Logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
  const v4Ids = await analyzeWalletV4Positions(wallet);

  const positions: PositionPnL[] = [];
  const skipped: string[] = [];
  const total = v3Ids.length + v4Ids.length;
  let done = 0;
  onProgress?.(0, total);

  for (const id of v3Ids) {
    try { positions.push(await retry(() => computePositionPnL(id))); }
    catch { skipped.push(`v3:${id}`); }
    onProgress?.(++done, total);
  }
  for (const { tokenId, mintBlock } of v4Ids) {
    try { positions.push(await retry(() => computePositionPnLV4(tokenId, mintBlock))); }
    catch { skipped.push(`v4:${tokenId}`); }
    onProgress?.(++done, total);
  }
  positions.sort((a, b) => b.result.netPnlUsd - a.result.netPnlUsd);
  return { kind: "wallet", query: getAddress(wallet), positions, skipped, totals: totalsOf(positions) };
}

/** Enumerate a wallet's v4 positions via PositionManager ERC-721 Transfers it currently received. */
async function analyzeWalletV4Positions(wallet: string): Promise<{ tokenId: bigint; mintBlock: bigint }[]> {
  const mints = await client.getLogs({ address: POSM_V4, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: 0n, toBlock: "latest" });
  const byId = new Map<bigint, bigint>();
  for (const l of mints) {
    const id = (l.args as { tokenId: bigint }).tokenId;
    const bn = l.blockNumber!;
    if (!byId.has(id) || bn < byId.get(id)!) byId.set(id, bn);
  }
  return [...byId.entries()].map(([tokenId, mintBlock]) => ({ tokenId, mintBlock }));
}

/** Route a single input: 66-char hash → tx, 42-char address → wallet. */
export async function analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio> {
  const q = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return analyzeTx(q);
  if (isAddress(q)) return analyzeWallet(q, onProgress);
  throw new Error("Enter a wallet address (0x…40 chars) or a transaction hash (0x…64 chars).");
}
