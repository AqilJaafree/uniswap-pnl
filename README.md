# Robinhood Chain — Uniswap v3 LP PnL

Reconstructs realized/unrealized PnL for **Uniswap v3** liquidity positions on
**Robinhood Chain** (chainId 4663): fees earned, impermanent loss, and net return
per position. Paste a wallet or a transaction hash.

> Covers Uniswap **v3 and v4** LP positions on Robinhood chain. ETH-pair positions
> are denominated in ETH (toggle to USD); USDG-pair positions are denominated in USD.
> v4 positions are read from the PoolManager / PositionManager / StateView, with
> principal reconstructed geometrically (archive-free, from Swap-log ticks) and fees
> from fee-growth accumulators (best-effort; flagged "fees partial" when the RPC's
> ~14-day state retention has pruned older fee-growth snapshots).

## Layout

```
src/
  uniswap-v3-pnl.ts   Pure PnL core (no deps): types, computePnL, formatCard,
                      fromMulticallTrace (paste-a-Blockscout-trace decoder),
                      Robinhood Chain config + Uniswap v3 addresses.
  live.ts             CLI over the live RPC (viem).
  trace.test.ts       13-assertion check of the trace decoder vs real txs.
  example.ts          Worked example (synthetic WETH/USDC position).
  realpnl.ts          Worked example from real decoded amounts.
web/                  Vite + React + Tailwind frontend (dark dashboard).
```

## CLI

```bash
npm install
npm run verify                         # 13/13 decoder assertions (offline)
npm run demo                           # synthetic worked example

npm run pnl -- 0x<txhash>   -- --usd 3000   # single position from a tx
npm run pnl -- wallet 0x<address> --usd 3000 # sweep every position
```

Pasting any tx that touches a position re-derives the full lifecycle from the
position's event logs, so the exit tx (or even the mint) is enough.

## Web

```bash
npm run web:install
npm run web:dev        # http://localhost:5173
```

Calls the Robinhood Chain RPC directly from the browser (the RPC sends
`access-control-allow-origin: *`, so no backend/proxy is needed).

## How PnL is computed

- **Fees** isolated as `Collect − DecreaseLiquidity` within a tx (a lone `Collect`
  = a pure fee claim).
- **Exit price** derived archive-free from the burn: `√P = √pa + amount1 / L`.
- **WETH numeraire** (no USD oracle on Robinhood yet); USD is a flat `× ETH price`.
- **Open positions** are marked-to-market via `amountsFromLiquidity` + pool `slot0`
  + unclaimed `tokensOwed`.
- Positions that can't be read after retries are **surfaced, never silently dropped**.

## Scan cache (browser)

A wallet scan is latency-bound, so settled chain history is cached in IndexedDB and a
repeat scan asks only for the blocks that did not exist last time. Cached: log ranges
(per tokenId — for v4 ModifyLiquidity too, filtered to the position before it is stored),
block timestamps, receipts, token decimals/symbols, and the v4 archive reads — those last
for **accuracy**, since this RPC prunes state after ~14 days and a snapshot kept on disk
outlives it.

What is deliberately **not** cached is the pool-wide Swap stream. A hot pool emits tens of
thousands of Swaps, and they exist to resolve a tick for a position's handful of event
blocks — as the third fallback, behind StateView and the implied-from-spend tick. So the
scan is lazy, and what persists is the resolved tick rather than the stream: one number per
(pool, mint, block). Caching the input there instead of the answer once put a 133-position
wallet into a 4 GB heap.

Provider volume data (GeckoTerminal daily candles, DefiLlama chain-wide) is cached the
same way, keyed by URL and stamped with the UTC day it was fetched, so a reload costs no
requests. That provider limits by the MINUTE (~30 calls), and exceeding it does not look
like a rate limit from the browser: a light burst returns a 429 you can read, but
sustained load is refused at Cloudflare's edge with **no CORS header at all**, so `fetch`
rejects opaquely and the console blames CORS. Requests are therefore paced by a
per-minute token bucket rather than by concurrency, and the first refusal stops the batch
— asking again inside the same minute cannot succeed and only deepens the block. Pools
that were never asked about are reported as such, separately from pools that genuinely
failed.

Nothing is written until it is 512 blocks behind the head, so the cache cannot hold a log
the chain has since disowned. To bypass it: **Rescan from chain** in the UI, or load with
`?nocache=1`. If IndexedDB is unavailable the app behaves exactly as it did before — a
cache that cannot open is a slow scan, never a broken one.

- `web/src/lib/idb.ts` storage, `log-cache.ts` the range arithmetic (pure, unit-tested),
  `chain-cache.ts` the wiring and the finality rule.

## Notes

- `web/src/lib/uniswap-v3-pnl.ts` is a copy of `src/uniswap-v3-pnl.ts` — after
  editing the core, run `npm run sync:core`.
- Verified against wallet `0x7e995decc404633CF2889968537D723c55ffEA2C`
  (3 positions, total net ≈ Ξ0.000965).
