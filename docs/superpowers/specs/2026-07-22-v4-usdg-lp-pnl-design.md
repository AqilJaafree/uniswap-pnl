# Uniswap v4 + USDG-pair LP PnL — Design

Date: 2026-07-22
Project: `robinhood-v3-lp-pnl` (Robinhood chain, chainId 4663)
Status: Approved (design), pending implementation plan

## Goal

Extend the existing LP PnL calculator — today **Uniswap v3, ETH-pair, WETH numeraire** — to also compute PnL for:

1. **Uniswap v4** LP positions (new protocol architecture), and
2. **USDG-pair** positions (USD numeraire),

surfaced together in the **deployed web calculator UI**. A user pasting a wallet or tx hash sees v3 **and** v4, ETH-pair **and** USDG-pair positions merged into one portfolio view.

Reuse the existing pure PnL engine (tick math + `computePnL` decomposition) as much as possible; only the fetch/decode layer and the price-feed layer are protocol-specific.

## Non-goals

- No changes to the CLI (`src/live.ts`) or the `src/` engine copy in this iteration — work targets `web/src/lib/` and `web/src/App.tsx` only. (Engine-copy sync is a known follow-up, noted below.)
- No hook-aware fee modelling beyond flagging non-zero-hook pools as lower-confidence.
- No support for direct-PoolManager LPs that are not held via the v4 PositionManager NFT (those `sender`s are routers, not enumerable NFT positions).

## Background / on-chain facts (verified against Robinhood RPC)

- v4 **PoolManager** (singleton): `0x8366a39cc670b4001a1121b8f6a443a643e40951` (already in nautilus `src/robinhood/v4/config.ts`).
- v4 **PositionManager** (periphery ERC-721): `0x58daec3116aae6d93017baaea7749052e8a04fa7`
  - `name()` = "Uniswap v4 Positions NFT", `symbol()` = "UNI-V4-POSM".
  - Dominant `sender` on `ModifyLiquidity` logs (253/352 in a recent 8k-block window); other senders are direct-PoolManager routers, out of scope.
- v4 **StateView**: address TBD — discover during implementation (needed only for unclaimed fees on **open** positions).
- v3 NonfungiblePositionManager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`.
- Tokens: `USDG = 0x5fc5360d0400a0fd4f2af552add042d716f1d168` (6 decimals), `WETH = 0x0bd7d308f8e1639fab988df18a8011f41eacad73`, native ETH = `address(0)` in v4 PoolKeys.
- RPC capabilities: **`debug_traceTransaction` is NOT available**; **archive/historical state IS available**.

### Key v4 vs v3 differences that shape the design

| Aspect | v3 | v4 |
| --- | --- | --- |
| Position registry | NPM `positions()` + `Increase`/`Decrease`/`Collect` events | PositionManager ERC-721 + PoolManager `ModifyLiquidity` |
| Amounts in log | Yes (`amount0`/`amount1`) | **No** — only signed `liquidityDelta`, ticks, `salt` |
| Fee claim event | separate `Collect` | `ModifyLiquidity` with `liquidityDelta == 0` |
| Pool identity | pool address | `bytes32 poolId = keccak256(abi.encode(PoolKey))` |
| Tokens | token0/token1 addresses | currencies incl. native ETH (`address(0)`) |
| Log join | single NPM address | `Transfer` on PositionManager + `ModifyLiquidity` on PoolManager, joined via `salt == bytes32(tokenId)` and `sender == PositionManager` |
| Tick / liquidity math | `1.0001^tick`, piecewise amounts | **identical** |

`ModifyLiquidity` topic0 = `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec`
(signature `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)`; indexed: `id`, `sender`).

## Approach for v4 amounts (the crux)

Because `ModifyLiquidity` omits amounts and traces are unavailable, reconstruct amounts with a **hybrid** that reuses existing engine math:

- **Principal (deposits / withdrawals)** — geometric: `amountsFromLiquidity(|liquidityDelta|, tickLower, tickUpper, tickAtBlock)`, where `tickAtBlock` = pool `sqrtPriceX96`/tick read at the event's block via **archive** `slot0`/StateView. This is the same function the v3 engine already uses to mark open positions.
- **Fees** — realized token deltas: a `liquidityDelta == 0` event is a pure fee claim; on a decrease, fees = tokens actually received − geometric principal. Realized amounts come from the ERC-20 `Transfer` / native-value entries in the same tx.

Rejected alternative: reconstruct *everything* from token transfers. Simpler, but cannot cleanly separate principal from fees on a combined decrease+collect, which would corrupt the HODL/IL/fees decomposition.

## Architecture / components

All changes in `web/src/lib/` and `web/src/App.tsx`.

### `web/src/lib/chain-v4.ts` (new — v4 driver, mirrors `chain.ts`)
Responsibilities:
- Enumerate a wallet's v4 positions: `eth_getLogs` `Transfer(from,to,tokenId)` on the PositionManager; mints (`from == 0x0`) into `to`, then track transfers to confirm current holder.
- Per tokenId: `getPoolAndPositionInfo(tokenId)` → `PoolKey` (currency0/1 incl. native ETH, fee, tickSpacing, hooks) + `PositionInfo` (tickLower/tickUpper); compute `poolId = keccak256(abi.encode(PoolKey))`; resolve token decimals/symbols (native ETH → 18/"ETH").
- Fetch lifecycle: `eth_getLogs` on PoolManager filtered by `topic0 = ModifyLiquidity`, `topic1 = poolId`; decode `salt`/`sender` from data; keep rows where `salt == bytes32(tokenId)` && `sender == PositionManager`.
- Build `LiquidityEvent[]`: `liquidityDelta > 0` → `increase`, `< 0` → `decrease`, `== 0` → `collect`; amounts per the hybrid above; `timestamp` from block.
- Open position: current principal via `getPositionLiquidity(tokenId)` + live `slot0`; unclaimed fees via StateView fee-growth math (fallback: mark fees unavailable).

### `web/src/lib/uniswap-v3-pnl.ts` (extend the pure engine, do not fork)
- Generalize `resolveActions` so a zero-`liquidityDelta` v4 event maps to `kind:"collect"` with fee amounts from realized deltas (the v3 `Collect − Decrease` subtraction path stays for v3 inputs).
- Add a v4 config/address block (PositionManager, PoolManager, StateView-when-known) alongside `ROBINHOOD_CHAIN`.
- `computePnL`, tick math (`amountsFromLiquidity`, `priceAtTick`, `impliedInRangePrice`), and the PnL decomposition are unchanged.

### `web/src/lib/chain.ts` (merge v3 + v4)
- `analyze(input)` runs v3 and v4 enumeration and merges into one `Portfolio`: `positions` each tagged `version: 'v3' | 'v4'`, plus `skipped` and aggregate `totals`.
- Preserve existing retry + progress-callback behavior.

### Numeraire (decision C — support both)
- Generalize the `PriceFeed` construction: for **USDG pairs**, USDG = $1 and the paired token is priced in USD; for **ETH pairs**, keep today's WETH-relative behavior.
- Each position carries **both** an ETH-terms and a USD-terms figure where derivable, so the UI can show the natural unit per pair (Ξ for ETH pairs, $ for USDG pairs).

### `web/src/App.tsx`
- Position rows gain a **v3/v4 badge** and a **denom indicator** (Ξ vs $), consistent with the nautilus movers-board convention.
- Merged portfolio totals respect per-pair denomination.

## Open vs closed positions

- **Closed** v4 positions: fully covered; no StateView needed.
- **Open** v4 positions: principal marked-to-market via `getPositionLiquidity` + live `slot0` (engine reuse). Unclaimed fees require **StateView**; if its address can't be found, degrade gracefully — show principal MTM and mark fees "unavailable" rather than blocking the feature.

## Edge cases

- **Native ETH currency** (`address(0)`) as a pool leg — new vs v3; handle in decimals/symbol resolution and in native-value fee reads.
- **Non-zero hooks** — flag position as lower-confidence; the PoolKey fee may be a dynamic-fee sentinel.
- **Position transferred out** mid-life — enumeration must reflect current holder; PnL for the querying wallet covers its holding window.
- **USDG decimals (6)** vs WETH/ETH (18) — ensure amount scaling is per-token, not assumed 18.

## Testing

- Unit: v4 log/`salt` decode; generalized `resolveActions` (zero-delta ⇒ collect); native-ETH leg handling; USDG (6-dec) scaling.
- Reuse existing `exit-price.test.ts` / `trace.test.ts` style.
- Integration: a known Robinhood v4 wallet/tokenId end-to-end against live RPC.

## Known follow-ups (out of scope here)

- Sync the `src/uniswap-v3-pnl.ts` engine copy with the extended `web/src/lib/` copy (they are currently byte-identical).
- CLI (`src/live.ts`) parity for v4/USDG.
- Hook-aware fee modelling.
