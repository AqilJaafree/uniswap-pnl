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

## Notes

- `web/src/lib/uniswap-v3-pnl.ts` is a copy of `src/uniswap-v3-pnl.ts` — after
  editing the core, run `npm run sync:core`.
- Verified against wallet `0x7e995decc404633CF2889968537D723c55ffEA2C`
  (3 positions, total net ≈ Ξ0.000965).
