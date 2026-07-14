# Robinhood Chain — Uniswap v3 LP PnL

Reconstructs realized/unrealized PnL for **Uniswap v3** liquidity positions on
**Robinhood Chain** (chainId 4663): fees earned, impermanent loss, and net return
per position. Paste a wallet or a transaction hash.

> **v3 only.** This tool targets the Uniswap **v3** NonfungiblePositionManager
> (`0x7399…de0d3`). The wallet's Uniswap **v4** positions are a different protocol
> (singleton PoolManager + flash accounting) and are **not** covered here yet.

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
