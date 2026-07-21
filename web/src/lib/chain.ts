/**
 * Browser data layer — same logic as the CLI live.ts, but returns structured
 * data instead of printing. Calls the Robinhood Chain RPC directly (the RPC
 * sends `access-control-allow-origin: *`, so no proxy is needed).
 */
import { createPublicClient, http, defineChain, parseAbiItem, parseEventLogs, getAddress, isAddress, type Address } from "viem";
import {
  computePnL, closedExitPrice, amountsFromLiquidity, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.chainId,
  name: "Robinhood Chain",
  nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
});
export const client = createPublicClient({ chain: robinhoodChain, transport: http(undefined, { retryCount: 4, retryDelay: 250 }) });

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
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");

const evIncrease = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evDecrease = parseAbiItem("event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const evCollect = parseAbiItem("event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)");
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const fnPositions = parseAbiItem("function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 f0, uint256 f1, uint128 owed0, uint128 owed1)");
const fnGetPool = parseAbiItem("function getPool(address,address,uint24) view returns (address)");
const fnSlot0 = parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");

const sqrtToPrice = (sqrtX96: bigint, dec0: number, dec1: number) => {
  const sp = Number(sqrtX96) / 2 ** 96;
  return sp * sp * 10 ** (dec0 - dec1);
};

export interface PositionPnL {
  tokenId: bigint;
  sym0: string; sym1: string; fee: number;
  tickLower: number; tickUpper: number;
  open: boolean;
  numeraire: string; // symbol used as the value unit (WETH when a WETH pair)
  priceT1perT0: number;
  priceBasis: ExitPriceBasis | "mark-to-market" | "live-fallback";
  txHashes: string[];
  result: PnLResult;
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

  const token0IsWeth = getAddress(token0) === WETH;
  const price: PriceFeed = () => (token0IsWeth ? { p0: 1, p1: 1 / priceT1perT0 } : { p0: priceT1perT0, p1: 1 });

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  const gasWei = (await Promise.all(txHashes.map((h) => client.getTransactionReceipt({ hash: h as `0x${string}` }))))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: sym0, symbol1: sym1, decimals0: dec0, decimals1: dec1, feeUnits: Number(fee) };
  const result = computePnL(events, pair, price, { gasUsd: Number(gasWei) / 1e18 });

  return { tokenId, sym0, sym1, fee: Number(fee), tickLower, tickUpper, open, numeraire: token0IsWeth ? sym0 : sym1, priceT1perT0, priceBasis, txHashes, result };
}

function totalsOf(positions: PositionPnL[]) {
  const sum = (f: (r: PnLResult) => number) => positions.reduce((a, r) => a + f(r.result), 0);
  return {
    net: sum((r) => r.netPnlUsd), fees: sum((r) => r.feesUsd),
    il: sum((r) => r.ilUsd), gas: sum((r) => r.gasUsd), count: positions.length,
  };
}

export async function analyzeTx(txHash: string): Promise<Portfolio> {
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  const parsed = parseEventLogs({ abi: [evIncrease, evDecrease, evCollect], logs: receipt.logs });
  if (!parsed.length) throw new Error("No Uniswap position event in this transaction.");
  const tokenId = (parsed[0].args as { tokenId: bigint }).tokenId;
  const pos = await computePositionPnL(tokenId);
  return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsOf([pos]) };
}

export async function analyzeWallet(
  wallet: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Portfolio> {
  const logs = await client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: 0n, toBlock: "latest" });
  const tokenIds = [...new Set(logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
  const positions: PositionPnL[] = [];
  const skipped: string[] = [];
  let done = 0;
  onProgress?.(0, tokenIds.length);
  for (const id of tokenIds) {
    try { positions.push(await retry(() => computePositionPnL(id))); }
    catch { skipped.push(String(id)); } // burned NFT or persistent read error — surfaced, not hidden
    onProgress?.(++done, tokenIds.length);
  }
  positions.sort((a, b) => b.result.netPnlUsd - a.result.netPnlUsd);
  return { kind: "wallet", query: getAddress(wallet), positions, skipped, totals: totalsOf(positions) };
}

/** Route a single input: 66-char hash → tx, 42-char address → wallet. */
export async function analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio> {
  const q = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return analyzeTx(q);
  if (isAddress(q)) return analyzeWallet(q, onProgress);
  throw new Error("Enter a wallet address (0x…40 chars) or a transaction hash (0x…64 chars).");
}
