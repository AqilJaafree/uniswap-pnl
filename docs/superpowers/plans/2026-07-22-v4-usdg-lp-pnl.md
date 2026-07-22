# Uniswap v4 + USDG-pair LP PnL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the deployed web LP-PnL calculator so a wallet/tx surfaces Uniswap **v4** positions and **USDG-pair** (USD-denominated) positions alongside the existing v3/ETH-pair positions, reusing the pure PnL engine.

**Architecture:** The pure engine (`uniswap-v3-pnl.ts`: tick math + `computePnL` + HODL/IL/fees decomposition) is **unchanged** — the v4 driver constructs `LiquidityEvent[]` in the same v3 shape (a decrease carries geometric principal; a paired collect carries principal+fees, so the engine's `fee = collect − decrease` identity still holds). New pure decoders + a viem driver read v4 data from three verified contracts, and a small numeraire helper generalizes the WETH-only value unit to also cover USD (USDG). The UI gains v3/v4 badges and per-position numeraire-aware money display.

**Tech Stack:** TypeScript, viem, React, Vite/Tailwind (web). Tests are plain `tsx` scripts (no test runner) using the repo's existing PASS/FAIL harness style. Engine core is synced `src/ → web/src/lib/` via `npm run sync:core`.

---

## Reference — verified on-chain facts (Robinhood chain, chainId 4663)

All addresses/interfaces below were verified live against `https://rpc.mainnet.chain.robinhood.com` on 2026-07-22.

| Contract | Address | Used for |
| --- | --- | --- |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | `ModifyLiquidity` logs (liquidity lifecycle) |
| v4 PositionManager (ERC-721) | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | enumerate positions, `getPoolAndPositionInfo`, `getPositionLiquidity` |
| v4 StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | `getSlot0`, `getFeeGrowthInside` (historical via archive) |
| USDG token | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` (6 dec) | USD numeraire anchor |
| WETH token | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (18 dec) | ETH numeraire anchor |
| native ETH | `0x0000000000000000000000000000000000000000` (18 dec, "ETH") | v4 currency0 can be native |

- `nextTokenId()` on PositionManager ≈ 268773 — positions are ERC-721, ids from 1, enumerated via `Transfer(from,to,tokenId)` logs.
- `getPoolAndPositionInfo(uint256)` → `((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)`.
- `PositionInfo` packing: `tickLower = signExtend24(info >> 8)`, `tickUpper = signExtend24(info >> 32)`.
- `poolId = keccak256(encodeAbiParameters([address,address,uint24,int24,address], [c0,c1,fee,tickSpacing,hooks]))` — verified to match `ModifyLiquidity` `topic1`.
- `ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)`, topic0 `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec`. Periphery-managed positions have `sender == PositionManager` and `salt == bytes32(tokenId)`.
- `StateView.getSlot0(bytes32) → (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)`; `StateView.getFeeGrowthInside(bytes32,int24,int24) → (uint256 fg0X128, uint256 fg1X128)`. `debug_traceTransaction` is NOT available.
- **State retention is ~14 days, NOT full archive.** Verified 2026-07-22: `eth_call`/`getBalance` succeed at −12,000,000 blocks (~14 d) but fail at −15,000,000 (~17.5 d) with `-32000 missing trie node`. The chain launched 2026-07-01, so a position with lifecycle events older than ~14 days has **pruned state** — `getSlot0`/`getFeeGrowthInside` at those blocks throw. **Event/Swap logs are retained regardless** (`getLogs` works at any depth, subject to range limits), so anything derivable from logs is archive-free.

### v4 amount reconstruction (the mechanism)

Because state older than ~14 days is pruned, **price/tick is derived from Swap logs (archive-free), and fees are best-effort from fee-growth state**:

- **tick / price at a block** — from v4 **Swap logs** for the poolId: the `tick` (data word 4) / `sqrtPriceX96` (word 2) of the last Swap at-or-before that block; fall back to the pool's `Initialize` sqrtPriceX96 if no prior swap. This is retained at any depth, so principal + price PnL stay **exact for all positions regardless of age**.
- **principal** (tokens in on increase, out on decrease): `amountsFromLiquidity(|liquidityDelta|, tickLower, tickUpper, tickAtBlock)` — the engine's existing v3 function, raw base units.
- **fees** realized in the segment ending at an event: `feeToken = (liquidityHeldDuringSegment × (feeGrowthInside_now − feeGrowthInside_lastCheckpoint)) >> 128`, per token, from `StateView.getFeeGrowthInside(poolId, tickLower, tickUpper)` snapshots. **Best-effort:** if an event block's state is pruned, that snapshot is `null`, the segment's fee is treated as 0, and the position is flagged `feesComplete = false` (principal/IL/price PnL remain exact). Most positions on this young chain are fully within the retained window.

Engine mapping (no engine change): `liquidityDelta > 0` → `increase(principal)` (+`collect(fee)` if any accrued); `< 0` → `decrease(principal)` + `collect(principal + fee)`; `== 0` → `collect(fee)`. Open positions append synthetic `decrease`/`collect` at "now" (txHash `"0xopen"`, current head state — never pruned), mirroring the existing v3 open-position handling.

v4 **Swap** decode (reused from nautilus): `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`, topic0 `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f`. `Initialize` topic0 `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` (sqrtPriceX96 = data word 3, tick = word 4).

### Numeraire model (decision C — support both)

Engine `*Usd` fields are actually **numeraire-unit** values (the anchor leg is priced at 1). Anchor selection, USDG takes precedence over ETH:
- pair contains USDG → `kind:"usd"`, anchor = USDG leg, values are **dollars** (USDG ≈ $1).
- else pair contains WETH/native-ETH → `kind:"eth"`, anchor = ETH leg, values are **ETH units** (UI multiplies by user-entered `ethUsd`).
- else → unsupported pair (skip, surfaced in `skipped`).

`PricePoint` construction is identical to today: anchor-is-token0 → `{p0:1, p1:1/priceT1perT0}`, else `{p0:priceT1perT0, p1:1}`.

---

## File Structure

**New (all pure/browser, in `web/src/lib/`):**
- `web/src/lib/numeraire.ts` — anchor/numeraire selection + PricePoint + USD conversion. Pure.
- `web/src/lib/numeraire.test.ts` — unit tests.
- `web/src/lib/v4-decode.ts` — pure v4 helpers: `computeV4PoolId`, `unpackPositionInfo`, `buildV4Events`, `buildV4PriceFeed`. Pure (viem `keccak256`/`encodeAbiParameters` only).
- `web/src/lib/v4-decode.test.ts` — unit tests (the core value).
- `web/src/lib/chain-v4.ts` — viem network driver (enumerate, fetch lifecycle + StateView snapshots, compute PnL).
- `web/src/lib/chain-v4.smoke.ts` — manual integration smoke against live RPC.

**Modified:**
- `src/uniswap-v3-pnl.ts` → add `USDG` + `uniswapV4` addresses to `ROBINHOOD_CHAIN`; `npm run sync:core` to `web/src/lib/uniswap-v3-pnl.ts`. No logic change.
- `web/src/lib/chain.ts` → `PositionPnL` gains `version` + `numeraireKind`; v3 path uses `numeraire.ts`; `analyze` merges v3 + v4.
- `web/src/App.tsx` → v3/v4 badge, per-position numeraire-aware money, USD-normalized totals for mixed portfolios.
- `package.json` → `verify` script runs the new `tsx` tests.

---

## Task 1: Add v4 + USDG addresses to the engine config

**Files:**
- Modify: `src/uniswap-v3-pnl.ts:261-275` (the `ROBINHOOD_CHAIN` object)
- Test: `src/config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

```typescript
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

eq("USDG address", (ROBINHOOD_CHAIN as any).tokens.USDG, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
eq("USDG decimals", (ROBINHOOD_CHAIN as any).tokens.USDG_DECIMALS, 6);
eq("WETH address", (ROBINHOOD_CHAIN as any).tokens.WETH, "0x0bd7d308f8e1639fab988df18a8011f41eacad73");
eq("v4 PoolManager", ROBINHOOD_CHAIN.uniswapV4.poolManager, "0x8366a39cc670b4001a1121b8f6a443a643e40951");
eq("v4 PositionManager", ROBINHOOD_CHAIN.uniswapV4.positionManager, "0x58daec3116aae6d93017baaea7749052e8a04fa7");
eq("v4 StateView", ROBINHOOD_CHAIN.uniswapV4.stateView, "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b");

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/config.test.ts`
Expected: FAIL — `uniswapV4` / `tokens` are undefined.

- [ ] **Step 3: Add the config**

In `src/uniswap-v3-pnl.ts`, extend the `ROBINHOOD_CHAIN` object (after the `uniswapV3` block, before the closing `} as const;` at line 275):

```typescript
  tokens: {
    WETH: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    USDG_DECIMALS: 6,
    NATIVE_ETH: "0x0000000000000000000000000000000000000000",
  },
  uniswapV4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    // ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
    modifyLiquidityTopic0: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  },
```

- [ ] **Step 4: Sync to web + run test**

Run: `npm run sync:core && npx tsx src/config.test.ts`
Expected: `6/6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/uniswap-v3-pnl.ts web/src/lib/uniswap-v3-pnl.ts src/config.test.ts
git commit -m "feat(config): add v4 + USDG addresses to ROBINHOOD_CHAIN"
```

---

## Task 2: `numeraire.ts` — anchor selection & USD conversion (pure, TDD)

**Files:**
- Create: `web/src/lib/numeraire.ts`
- Test: `web/src/lib/numeraire.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/numeraire.test.ts`:

```typescript
import { pickNumeraire, numerairePricePoint, toUsd, type NumeraireKind } from "./numeraire";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const approx = (name: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want≈${want}`);
  ok ? pass++ : fail++;
};

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NATIVE = "0x0000000000000000000000000000000000000000";
const FOO = "0x00000000000000000000000000000000000000ff";

// USDG beats WETH; USDG as token1 → anchor is token1
eq("usdg pair kind", pickNumeraire(WETH, USDG, "WETH", "USDG").kind, "usd");
eq("usdg anchor is token1", pickNumeraire(WETH, USDG, "WETH", "USDG").anchorIsToken0, false);
eq("usdg symbol", pickNumeraire(WETH, USDG, "WETH", "USDG").symbol, "USD");
// USDG as token0 → anchor is token0
eq("usdg token0 anchor", pickNumeraire(USDG, FOO, "USDG", "FOO").anchorIsToken0, true);
// ETH pair (native) → eth kind, anchor token0
eq("native eth kind", pickNumeraire(NATIVE, FOO, "ETH", "FOO").kind, "eth");
eq("native eth anchor token0", pickNumeraire(NATIVE, FOO, "ETH", "FOO").anchorIsToken0, true);
eq("weth token1 kind", pickNumeraire(FOO, WETH, "FOO", "WETH").kind, "eth");
// unsupported pair
eq("unsupported", pickNumeraire(FOO, "0x00000000000000000000000000000000000000ee", "A", "B"), null);

// PricePoint: anchor token1 → {p0: price, p1: 1}; anchor token0 → {p0:1, p1:1/price}
{ const pp = numerairePricePoint(2000, false); approx("anchorT1 p0", pp.p0, 2000); approx("anchorT1 p1", pp.p1, 1); }
{ const pp = numerairePricePoint(2000, true); approx("anchorT0 p0", pp.p0, 1); approx("anchorT0 p1", pp.p1, 1 / 2000); }

// toUsd: usd kind is identity; eth kind multiplies by ethUsd (null → NaN sentinel not used, returns value)
eq("toUsd usd", toUsd(50, "usd", 3000), 50);
eq("toUsd eth", toUsd(2, "eth", 3000), 6000);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx web/src/lib/numeraire.test.ts`
Expected: FAIL — module not found / exports undefined.

- [ ] **Step 3: Implement `numeraire.ts`**

Create `web/src/lib/numeraire.ts`:

```typescript
/**
 * Numeraire selection for a pool pair. The PnL engine prices the "anchor" leg at
 * 1, so its USD/ETH-labelled figures are really *anchor-unit* figures. USDG pairs
 * anchor on the dollar (values already USD); ETH pairs anchor on ETH (UI ×ethUsd).
 */
import { getAddress } from "viem";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

export type NumeraireKind = "eth" | "usd";
export interface Numeraire {
  kind: NumeraireKind;
  anchorIsToken0: boolean;
  symbol: string; // "USD" for usd; "WETH" for eth (drives the Ξ glyph in format.ts)
}

const norm = (a: string) => a.toLowerCase();
const USDG = norm(ROBINHOOD_CHAIN.tokens.USDG);
const ETHSET = new Set([norm(ROBINHOOD_CHAIN.tokens.WETH), norm(ROBINHOOD_CHAIN.tokens.NATIVE_ETH)]);

/** Choose the value unit for a pair. USDG (USD) beats ETH. null = unsupported pair. */
export function pickNumeraire(token0: string, token1: string, _sym0: string, _sym1: string): Numeraire | null {
  const t0 = norm(token0), t1 = norm(token1);
  if (t0 === USDG || t1 === USDG) return { kind: "usd", anchorIsToken0: t0 === USDG, symbol: "USD" };
  if (ETHSET.has(t0) || ETHSET.has(t1)) return { kind: "eth", anchorIsToken0: ETHSET.has(t0), symbol: "WETH" };
  return null;
}

/** PricePoint (USD/anchor-unit of each whole token) given token1-per-token0 price. */
export function numerairePricePoint(priceT1perT0: number, anchorIsToken0: boolean): { p0: number; p1: number } {
  return anchorIsToken0 ? { p0: 1, p1: 1 / priceT1perT0 } : { p0: priceT1perT0, p1: 1 };
}

/** Convert an anchor-unit value to USD. usd → identity; eth → ×ethUsd (falls back to value when ethUsd null). */
export function toUsd(valueInNumeraire: number, kind: NumeraireKind, ethUsd: number | null): number {
  if (kind === "usd") return valueInNumeraire;
  return ethUsd == null ? valueInNumeraire : valueInNumeraire * ethUsd;
}

// re-export so callers don't need viem directly
export { getAddress };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx web/src/lib/numeraire.test.ts`
Expected: all PASS, `14/14 passed`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/numeraire.ts web/src/lib/numeraire.test.ts
git commit -m "feat(numeraire): pure anchor selection + USD conversion helper"
```

---

## Task 3: `v4-decode.ts` — poolId + PositionInfo unpacking (pure, TDD)

**Files:**
- Create: `web/src/lib/v4-decode.ts`
- Test: `web/src/lib/v4-decode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/v4-decode.test.ts`:

```typescript
import { computeV4PoolId, unpackPositionInfo } from "./v4-decode";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

// Verified live: PositionManager #1 poolKey → this poolId (matches ModifyLiquidity topic1).
eq("poolId #1", computeV4PoolId({
  currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  currency1: "0x42bcDF8d4116545d04dd5b76F48b614450f18B1B",
  fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000",
}), "0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d33cbd7249413a5");

// PositionInfo packing: tickLower at bits 8-31, tickUpper at bits 32-55 (signed 24-bit).
// Full-range spacing-60 position #1 => [-887220, 887220].
{
  // reconstruct a packed info: tickUpper(887220) << 32 | tickLower(-887220 as u24) << 8
  const u24 = (n: number) => BigInt(n & 0xffffff);
  const info = (u24(887220) << 32n) | (u24(-887220) << 8n);
  const r = unpackPositionInfo(info);
  eq("tickLower", r.tickLower, -887220);
  eq("tickUpper", r.tickUpper, 887220);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: FAIL — exports undefined.

- [ ] **Step 3: Implement poolId + unpack**

Create `web/src/lib/v4-decode.ts`:

```typescript
/**
 * Pure v4 decoders/assembly. No network — takes already-fetched log/state data
 * and produces engine LiquidityEvent[] (v3 shape) so computePnL is reused as-is.
 */
import { keccak256, encodeAbiParameters, getAddress } from "viem";
import { amountsFromLiquidity, type LiquidityEvent, type PriceFeed } from "./uniswap-v3-pnl";
import { numerairePricePoint } from "./numeraire";

export interface PoolKey {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}

/** poolId = keccak256(abi.encode(PoolKey)). Verified against on-chain ModifyLiquidity topic1. */
export function computeV4PoolId(k: PoolKey): string {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [getAddress(k.currency0), getAddress(k.currency1), k.fee, k.tickSpacing, getAddress(k.hooks)],
  ));
}

const signExtend24 = (v: bigint): number => {
  const masked = v & 0xffffffn;
  return masked >= 0x800000n ? Number(masked - 0x1000000n) : Number(masked);
};

/** PositionInfo packed uint256: tickLower at bits 8-31, tickUpper at bits 32-55. */
export function unpackPositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return { tickLower: signExtend24(info >> 8n), tickUpper: signExtend24(info >> 32n) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: all PASS, `3/3 passed`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/v4-decode.ts web/src/lib/v4-decode.test.ts
git commit -m "feat(v4-decode): poolId + PositionInfo unpacking (pure)"
```

---

## Task 4: `buildV4Events` — geometric principal + fee-growth fees → engine events (pure, TDD)

This is the core of the feature. Given a position's raw modify events plus per-block price(tick) and fee-growth snapshots, produce `LiquidityEvent[]` in v3 shape.

**Files:**
- Modify: `web/src/lib/v4-decode.ts`
- Test: `web/src/lib/v4-decode.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/v4-decode.test.ts` (before the final `console.log`):

```typescript
import { buildV4Events, type V4RawEvent, type BlockState } from "./v4-decode";

// Scenario: mint (add L=1e12 in-range), then full burn one segment later, with fees.
// tick=0 for simplicity → amountsFromLiquidity gives both legs. dec0=dec1=18.
{
  const L = 1_000_000_000_000n;
  const raw: V4RawEvent[] = [
    { blockNumber: 100n, logIndex: 0, txHash: "0xa".padEnd(66, "0"), timestamp: 1000, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 200n, logIndex: 0, txHash: "0xb".padEnd(66, "0"), timestamp: 2000, tickLower: -60, tickUpper: 60, liquidityDelta: -L },
  ];
  // fee growth: +X128 between block 100 and 200 → fees = L * delta >> 128
  const oneToken = (1n << 128n); // >>128 of L*this = L
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 0, fg0: oneToken, fg1: 2n * oneToken }],
  ]);
  const { events, feesComplete } = buildV4Events(raw, state, 18, 18);

  const kinds = events.map((e) => e.kind).join(",");
  eq("event kinds", kinds, "increase,decrease,collect");
  eq("feesComplete when all fg present", feesComplete, true);
  const dec = events.find((e) => e.kind === "decrease")!;
  const col = events.find((e) => e.kind === "collect")!;
  // fees = L*(1<<128)>>128 = L (token0), 2L (token1)
  eq("collect0 = principal + feeL", col.amount0, dec.amount0 + L);
  eq("collect1 = principal + fee2L", col.amount1, dec.amount1 + 2n * L);
  eq("decrease same tx as collect", dec.txHash, col.txHash);
}

// Scenario: exit block's fee-growth pruned (null) → feesComplete false, fee=principal only.
{
  const L = 1_000_000_000_000n;
  const raw: V4RawEvent[] = [
    { blockNumber: 100n, logIndex: 0, txHash: "0xe".padEnd(66, "0"), timestamp: 1000, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 200n, logIndex: 0, txHash: "0xf".padEnd(66, "0"), timestamp: 2000, tickLower: -60, tickUpper: 60, liquidityDelta: -L },
  ];
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 0, fg0: null, fg1: null }], // pruned
  ]);
  const { events, feesComplete } = buildV4Events(raw, state, 18, 18);
  eq("feesComplete false when pruned", feesComplete, false);
  const dec = events.find((e) => e.kind === "decrease")!;
  const col = events.find((e) => e.kind === "collect")!;
  eq("collect0 = principal only (fee=0)", col.amount0, dec.amount0);
}

// Scenario: pure fee claim (liquidityDelta == 0) after a mint.
{
  const L = 1_000_000_000_000n;
  const oneToken = (1n << 128n);
  const raw: V4RawEvent[] = [
    { blockNumber: 10n, logIndex: 0, txHash: "0xc".padEnd(66, "0"), timestamp: 100, tickLower: -60, tickUpper: 60, liquidityDelta: L },
    { blockNumber: 20n, logIndex: 0, txHash: "0xd".padEnd(66, "0"), timestamp: 200, tickLower: -60, tickUpper: 60, liquidityDelta: 0n },
  ];
  const state = new Map<bigint, BlockState>([
    [10n, { tick: 0, fg0: 0n, fg1: 0n }],
    [20n, { tick: 0, fg0: oneToken, fg1: 0n }],
  ]);
  const { events } = buildV4Events(raw, state, 18, 18);
  const claim = events.filter((e) => e.kind === "collect");
  eq("one fee-claim collect", claim.length, 1);
  eq("fee-claim amount0 = L", claim[0].amount0, L);
  eq("fee-claim has no decrease in tx", events.some((e) => e.kind === "decrease"), false);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: FAIL — `buildV4Events` not exported.

- [ ] **Step 3: Implement `buildV4Events`**

Append to `web/src/lib/v4-decode.ts`:

```typescript
/** One decoded ModifyLiquidity log already joined to a single tokenId. */
export interface V4RawEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  timestamp: number;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint; // signed
}

/**
 * Pool state snapshot at a block. `tick` comes from Swap logs (archive-free, always
 * present). `fg0`/`fg1` come from StateView and are `null` when that block's state is
 * pruned (>~14 days old) — the segment's fee is then treated as 0 and feesComplete=false.
 */
export interface BlockState {
  tick: number;
  fg0: bigint | null; // feeGrowthInside0X128, null = pruned
  fg1: bigint | null; // feeGrowthInside1X128, null = pruned
}

const absBig = (n: bigint) => (n < 0n ? -n : n);

/**
 * Convert a position's raw ModifyLiquidity events into engine LiquidityEvent[]:
 *   • principal = amountsFromLiquidity(|Δ|, ticks, tickAtBlock)  (geometric, raw units)
 *   • fee for the segment ending at this event = liqHeld * (fgNow − fgLast) >> 128,
 *     but 0 (and feesComplete=false) if either endpoint's fee-growth is pruned (null).
 *   • increase → increase(principal) [+ collect(fee) if any accrued]
 *     decrease → decrease(principal) + collect(principal + fee)
 *     delta==0 → collect(fee)
 * Events must all belong to ONE tokenId. tickLower/tickUpper are constant per position.
 */
export function buildV4Events(
  raw: V4RawEvent[],
  stateByBlock: Map<bigint, BlockState>,
  decimals0: number,
  decimals1: number,
  tokenId: bigint = 0n,
): { events: LiquidityEvent[]; feesComplete: boolean } {
  const sorted = [...raw].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  const out: LiquidityEvent[] = [];
  if (sorted.length === 0) return { events: out, feesComplete: true };

  const tickLower = sorted[0].tickLower;
  const tickUpper = sorted[0].tickUpper;
  let curLiq = 0n;
  let fgLast0 = stateByBlock.get(sorted[0].blockNumber)!.fg0;
  let fgLast1 = stateByBlock.get(sorted[0].blockNumber)!.fg1;
  let feesComplete = true;

  for (const ev of sorted) {
    const st = stateByBlock.get(ev.blockNumber)!;
    // segment fee only when both the previous checkpoint and this block have fee-growth
    let fee0 = 0n, fee1 = 0n;
    if (st.fg0 != null && st.fg1 != null && fgLast0 != null && fgLast1 != null) {
      fee0 = (curLiq * (st.fg0 - fgLast0)) >> 128n;
      fee1 = (curLiq * (st.fg1 - fgLast1)) >> 128n;
    } else if (curLiq > 0n) {
      feesComplete = false; // an active segment's fees couldn't be measured
    }
    fgLast0 = st.fg0; fgLast1 = st.fg1;

    const L = absBig(ev.liquidityDelta);
    const principal = amountsFromLiquidity(L, tickLower, tickUpper, st.tick);
    const base = { tokenId, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp };

    if (ev.liquidityDelta > 0n) {
      out.push({ ...base, kind: "increase", amount0: principal.amount0, amount1: principal.amount1, liquidity: L });
      if (fee0 > 0n || fee1 > 0n) out.push({ ...base, kind: "collect", amount0: fee0, amount1: fee1 });
      curLiq += L;
    } else if (ev.liquidityDelta < 0n) {
      out.push({ ...base, kind: "decrease", amount0: principal.amount0, amount1: principal.amount1, liquidity: L });
      out.push({ ...base, kind: "collect", amount0: principal.amount0 + fee0, amount1: principal.amount1 + fee1 });
      curLiq -= L;
    } else {
      out.push({ ...base, kind: "collect", amount0: fee0, amount1: fee1 });
    }
  }
  return { events: out, feesComplete };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: all PASS (prior 3 + new assertions).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/v4-decode.ts web/src/lib/v4-decode.test.ts
git commit -m "feat(v4-decode): buildV4Events — geometric principal + fee-growth fees"
```

---

## Task 5: `buildV4PriceFeed` — per-event numeraire price feed (pure, TDD)

**Files:**
- Modify: `web/src/lib/v4-decode.ts`
- Test: `web/src/lib/v4-decode.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/v4-decode.test.ts`:

```typescript
import { buildV4PriceFeed, tickToPrice, tickAtBlock, type V4SwapPoint } from "./v4-decode";

{
  // anchor token1 (e.g. USDG=token1). price at tick t = 1.0001^t (dec0==dec1).
  const state = new Map<bigint, BlockState>([
    [100n, { tick: 0, fg0: 0n, fg1: 0n }],
    [200n, { tick: 6932, fg0: 0n, fg1: 0n }], // ~2x
  ]);
  const tsByBlock = new Map<bigint, number>([[100n, 1000], [200n, 2000]]);
  const feed = buildV4PriceFeed(state, tsByBlock, /*anchorIsToken0*/ false, 18, 18);
  approx("price@1000 p0≈1", feed(1000).p0, 1);
  approx("price@2000 p0≈2", feed(2000).p0, tickToPrice(6932, 18, 18), 1e-6);
  approx("price@2000 p1==1", feed(2000).p1, 1);
  // query between/after known timestamps → nearest ≤
  approx("price@1500 uses 1000", feed(1500).p0, 1);
  approx("price@9999 uses 2000", feed(9999).p0, tickToPrice(6932, 18, 18), 1e-6);
}

// tickAtBlock: last Swap at-or-before the block; Initialize tick before any swap.
{
  const swaps: V4SwapPoint[] = [
    { blockNumber: 150n, logIndex: 2, tick: 10 },
    { blockNumber: 150n, logIndex: 5, tick: 11 },
    { blockNumber: 300n, logIndex: 0, tick: 20 },
  ];
  eq("tick before any swap = init", tickAtBlock(swaps, 100n, -7), -7);
  eq("tick at 150 = last in-block", tickAtBlock(swaps, 150n, -7), 11);
  eq("tick at 250 = 150's", tickAtBlock(swaps, 250n, -7), 11);
  eq("tick at 999 = 300's", tickAtBlock(swaps, 999n, -7), 20);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: FAIL — `buildV4PriceFeed` / `tickToPrice` not exported.

- [ ] **Step 3: Implement**

Append to `web/src/lib/v4-decode.ts`:

```typescript
/** Whole-token price token1-per-token0 at a tick, decimal-adjusted. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

/** A decoded v4 Swap: the pool's tick after the swap, keyed by block+logIndex. */
export interface V4SwapPoint { blockNumber: bigint; logIndex: number; tick: number; }

/** Pool tick at a block = tick of the last Swap at-or-before it; `initTick` if none prior. */
export function tickAtBlock(swaps: V4SwapPoint[], blockNumber: bigint, initTick: number): number {
  const sorted = [...swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  let t = initTick;
  for (const s of sorted) { if (s.blockNumber <= blockNumber) t = s.tick; else break; }
  return t;
}

/**
 * PriceFeed over the position's event timestamps. Each event block's tick →
 * numeraire PricePoint; a query returns the price at the nearest timestamp ≤ query
 * (computePnL only ever queries at event timestamps).
 */
export function buildV4PriceFeed(
  stateByBlock: Map<bigint, BlockState>,
  timestampByBlock: Map<bigint, number>,
  anchorIsToken0: boolean,
  decimals0: number,
  decimals1: number,
): PriceFeed {
  const points = [...stateByBlock.entries()]
    .map(([bn, st]) => ({ ts: timestampByBlock.get(bn)!, price: tickToPrice(st.tick, decimals0, decimals1) }))
    .filter((p) => p.ts != null)
    .sort((a, b) => a.ts - b.ts);

  return (ts: number) => {
    let chosen = points[0];
    for (const p of points) { if (p.ts <= ts) chosen = p; else break; }
    return numerairePricePoint(chosen.price, anchorIsToken0);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx web/src/lib/v4-decode.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/v4-decode.ts web/src/lib/v4-decode.test.ts
git commit -m "feat(v4-decode): buildV4PriceFeed over event timestamps"
```

---

## Task 6: `chain-v4.ts` — enumerate positions + fetch metadata (viem driver)

Network code (not unit-tested); verified by the smoke test in Task 8.

**Files:**
- Create: `web/src/lib/chain-v4.ts`

- [ ] **Step 1: Implement enumeration + metadata**

Create `web/src/lib/chain-v4.ts`:

```typescript
/**
 * Uniswap v4 browser data layer for Robinhood chain — mirrors chain.ts (v3) but
 * reads the v4 PoolManager / PositionManager / StateView. Reuses the shared viem
 * client and the pure engine + v4-decode helpers. Returns the same PositionPnL
 * shape as v3 so the UI is protocol-agnostic.
 */
import { parseAbiItem, getAddress, toHex, type Address } from "viem";
import { client, type PositionPnL } from "./chain";
import {
  computePnL, amountsFromLiquidity, exitTxHash, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlock, type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
} from "./v4-decode";

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const NATIVE = getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH);

const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const fnGetPPI = parseAbiItem("function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)");
const fnGetLiq = parseAbiItem("function getPositionLiquidity(uint256 tokenId) view returns (uint128)");
const fnSlot0 = parseAbiItem("function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)");
const fnFGI = parseAbiItem("function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 fg0, uint256 fg1)");
const fnDecimals = parseAbiItem("function decimals() view returns (uint8)");
const fnSymbol = parseAbiItem("function symbol() view returns (string)");

interface V4Meta {
  poolKey: PoolKey; poolId: string;
  tickLower: number; tickUpper: number;
  dec0: number; dec1: number; sym0: string; sym1: string;
  liqNow: bigint; mintBlock: bigint;
}

const isNative = (a: string) => getAddress(a) === NATIVE;

async function tokenMeta(addr: string): Promise<{ dec: number; sym: string }> {
  if (isNative(addr)) return { dec: 18, sym: "ETH" };
  const [dec, sym] = (await Promise.all([
    client.readContract({ address: getAddress(addr), abi: [fnDecimals], functionName: "decimals" }),
    client.readContract({ address: getAddress(addr), abi: [fnSymbol], functionName: "symbol" }),
  ])) as [number, string];
  return { dec, sym };
}

async function fetchMeta(tokenId: bigint, mintBlock: bigint): Promise<V4Meta> {
  const res = (await client.readContract({ address: POSM, abi: [fnGetPPI], functionName: "getPoolAndPositionInfo", args: [tokenId] })) as unknown as [PoolKey, bigint];
  const poolKey = { currency0: res[0].currency0, currency1: res[0].currency1, fee: Number(res[0].fee), tickSpacing: Number(res[0].tickSpacing), hooks: res[0].hooks };
  const { tickLower, tickUpper } = unpackPositionInfo(BigInt(res[1]));
  const liqNow = (await client.readContract({ address: POSM, abi: [fnGetLiq], functionName: "getPositionLiquidity", args: [tokenId] })) as bigint;
  const [m0, m1] = await Promise.all([tokenMeta(poolKey.currency0), tokenMeta(poolKey.currency1)]);
  return { poolKey, poolId: computeV4PoolId(poolKey), tickLower, tickUpper, dec0: m0.dec, dec1: m1.dec, sym0: m0.sym, sym1: m1.sym, liqNow, mintBlock };
}
```

- [ ] **Step 2: Commit (full type-check deferred to Task 7)**

This file is built across Tasks 6–7; several engine imports above are consumed only in Task 7, so `tsc` would flag them as unused now. Do the full `tsc --noEmit` after Task 7. Just confirm the file is syntactically saved here.

```bash
git add web/src/lib/chain-v4.ts
git commit -m "feat(chain-v4): v4 position enumeration + metadata reads"
```

---

## Task 7: `chain-v4.ts` — lifecycle fetch, StateView snapshots, computePositionPnLV4

**Files:**
- Modify: `web/src/lib/chain-v4.ts`

- [ ] **Step 1: Add Swap/Initialize ABI + tick source**

Append to `web/src/lib/chain-v4.ts`:

```typescript
const evSwap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const evInitialize = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");

/** Archive-free tick source: all Swaps for the pool since the position's mint + the Initialize tick. */
async function fetchTickSource(meta: V4Meta): Promise<{ swaps: V4SwapPoint[]; initTick: number }> {
  const [swapLogs, initLogs] = await Promise.all([
    client.getLogs({ address: PM, event: evSwap, args: { id: meta.poolId as `0x${string}` }, fromBlock: meta.mintBlock, toBlock: "latest" }),
    client.getLogs({ address: PM, event: evInitialize, args: { id: meta.poolId as `0x${string}` }, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const swaps: V4SwapPoint[] = swapLogs.map((l) => ({ blockNumber: l.blockNumber!, logIndex: l.logIndex!, tick: Number((l.args as { tick: number }).tick) }));
  const initTick = initLogs.length ? Number((initLogs[0].args as { tick: number }).tick) : 0;
  return { swaps, initTick };
}

/** Best-effort fee-growth-inside at a block; null when that block's state is pruned. */
async function feeGrowthAt(meta: V4Meta, blockNumber: bigint): Promise<{ fg0: bigint; fg1: bigint } | null> {
  try {
    const fgi = (await client.readContract({ address: SV, abi: [fnFGI], functionName: "getFeeGrowthInside", args: [meta.poolId as `0x${string}`, meta.tickLower, meta.tickUpper], blockNumber })) as readonly [bigint, bigint];
    return { fg0: fgi[0], fg1: fgi[1] };
  } catch { return null; } // missing trie node (pruned) — fees for this segment become approximate
}
```

- [ ] **Step 2: Implement lifecycle + PnL**

Append to `web/src/lib/chain-v4.ts`:

```typescript
/** All ModifyLiquidity events for one tokenId (join by poolId + salt + sender). */
async function fetchV4Lifecycle(tokenId: bigint, meta: V4Meta): Promise<{ raw: V4RawEvent[]; tsByBlock: Map<bigint, number> }> {
  const saltHex = toHex(tokenId, { size: 32 }).toLowerCase();
  const logs = await client.getLogs({ address: PM, event: evModify, args: { id: meta.poolId as `0x${string}` }, fromBlock: meta.mintBlock, toBlock: "latest" });
  const mine = logs.filter((l) => {
    const a = l.args as { sender: string; salt: string };
    return getAddress(a.sender) === POSM && a.salt.toLowerCase() === saltHex;
  });

  const blocks = [...new Set(mine.map((l) => l.blockNumber!))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => tsByBlock.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp))));

  const raw: V4RawEvent[] = mine.map((l) => {
    const a = l.args as { tickLower: number; tickUpper: number; liquidityDelta: bigint };
    return { blockNumber: l.blockNumber!, logIndex: l.logIndex!, txHash: l.transactionHash!, timestamp: tsByBlock.get(l.blockNumber!)!, tickLower: Number(a.tickLower), tickUpper: Number(a.tickUpper), liquidityDelta: a.liquidityDelta };
  });
  return { raw, tsByBlock };
}

export async function computePositionPnLV4(tokenId: bigint, mintBlock: bigint): Promise<PositionPnL> {
  const meta = await fetchMeta(tokenId, mintBlock);
  const num = pickNumeraire(meta.poolKey.currency0, meta.poolKey.currency1, meta.sym0, meta.sym1);
  if (!num) throw new Error(`unsupported v4 pair ${meta.sym0}/${meta.sym1}`);

  const { raw, tsByBlock } = await fetchV4Lifecycle(tokenId, meta);
  if (raw.length === 0) throw new Error(`no v4 liquidity events for #${tokenId}`);

  // tick from Swap logs (archive-free); fee-growth best-effort per event block
  const { swaps, initTick } = await fetchTickSource(meta);
  const eventBlocks = [...new Set(raw.map((r) => r.blockNumber))];
  const stateByBlock = new Map<bigint, BlockState>();
  await Promise.all(eventBlocks.map(async (bn) => {
    const fg = await feeGrowthAt(meta, bn);
    stateByBlock.set(bn, { tick: tickAtBlock(swaps, bn, initTick), fg0: fg?.fg0 ?? null, fg1: fg?.fg1 ?? null });
  }));

  const open = meta.liqNow > 0n;
  const built = buildV4Events(raw, stateByBlock, meta.dec0, meta.dec1, tokenId);
  const events: LiquidityEvent[] = built.events;
  let feesComplete = built.feesComplete;

  const priceBasis: PositionPnL["priceBasis"] = open ? "mark-to-market" : "in-range";
  let priceT1perT0: number;

  if (open) {
    const nowBlock = await client.getBlockNumber();
    const nowTs = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    // current tick/price + fee-growth from HEAD state (never pruned)
    const s0 = (await client.readContract({ address: SV, abi: [fnSlot0], functionName: "getSlot0", args: [meta.poolId as `0x${string}`] })) as readonly [bigint, number, number, number];
    const nowTick = Number(s0[1]);
    const nowFg = await feeGrowthAt(meta, nowBlock);
    stateByBlock.set(nowBlock, { tick: nowTick, fg0: nowFg?.fg0 ?? null, fg1: nowFg?.fg1 ?? null });
    tsByBlock.set(nowBlock, nowTs);
    priceT1perT0 = tickToPrice(nowTick, meta.dec0, meta.dec1);

    // synthetic MTM: current principal + unclaimed fees since last checkpoint
    const lastBlock = raw[raw.length - 1].blockNumber;
    const lastFg = stateByBlock.get(lastBlock)!;
    let feeNow0 = 0n, feeNow1 = 0n;
    if (nowFg && lastFg.fg0 != null && lastFg.fg1 != null) {
      feeNow0 = (meta.liqNow * (nowFg.fg0 - lastFg.fg0)) >> 128n;
      feeNow1 = (meta.liqNow * (nowFg.fg1 - lastFg.fg1)) >> 128n;
    } else { feesComplete = false; }
    const cur = amountsFromLiquidity(meta.liqNow, meta.tickLower, meta.tickUpper, nowTick);
    events.push(
      { kind: "decrease", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0, amount1: cur.amount1 },
      { kind: "collect", tokenId, txHash: "0xopen", blockNumber: 0n, timestamp: nowTs, amount0: cur.amount0 + feeNow0, amount1: cur.amount1 + feeNow1 },
    );
  } else {
    priceT1perT0 = tickToPrice(stateByBlock.get(raw[raw.length - 1].blockNumber)!.tick, meta.dec0, meta.dec1);
  }

  const price: PriceFeed = buildV4PriceFeed(stateByBlock, tsByBlock, num.anchorIsToken0, meta.dec0, meta.dec1);

  const txHashes = [...new Set(events.map((e) => e.txHash).filter((h) => h.startsWith("0x") && h.length === 66))];
  const gasWei = (await Promise.all(txHashes.map((h) => client.getTransactionReceipt({ hash: h as `0x${string}` }))))
    .reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);

  const pair: PairMeta = { symbol0: meta.sym0, symbol1: meta.sym1, decimals0: meta.dec0, decimals1: meta.dec1, feeUnits: meta.poolKey.fee };
  const result = computePnL(events, pair, price, { gasUsd: Number(gasWei) / 1e18 });

  return {
    tokenId, sym0: meta.sym0, sym1: meta.sym1, fee: meta.poolKey.fee,
    tickLower: meta.tickLower, tickUpper: meta.tickUpper, open,
    numeraire: num.symbol, numeraireKind: num.kind, version: "v4", feesComplete,
    priceT1perT0, priceBasis, txHashes, exitTx: exitTxHash(events), result,
  };
}
```

Note: `PositionPnL` gains `version`, `numeraireKind`, and `feesComplete` in Task 9 (chain.ts); until then tsc will flag them — expected, resolved in Task 9. The `fnSlot0` ABI item is already declared in Task 6 (used here for the open-position head price). Update the Task 6 imports list — `tickAtBlock` and `V4SwapPoint` must be added to the `./v4-decode` import (they're used here).

- [ ] **Step 2: Commit (compiles after Task 9)**

```bash
git add web/src/lib/chain-v4.ts
git commit -m "feat(chain-v4): computePositionPnLV4 — lifecycle + StateView + engine"
```

---

## Task 8: v4 integration smoke test (live RPC)

**Files:**
- Create: `web/src/lib/chain-v4.smoke.ts`

- [ ] **Step 1: Implement the smoke script**

Create `web/src/lib/chain-v4.smoke.ts`:

```typescript
/**
 * Manual v4 smoke test against live Robinhood RPC. Not part of `verify` (network).
 * Run: npx tsx web/src/lib/chain-v4.smoke.ts [tokenId]
 * Finds a recent PositionManager mint if no tokenId is given, computes its PnL,
 * and asserts the engine identity holds.
 */
import { parseAbiItem, getAddress } from "viem";
import { client } from "./chain";
import { computePositionPnLV4 } from "./chain-v4";
import { ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const evTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

async function main() {
  const arg = process.argv[2];
  let tokenId: bigint, mintBlock: bigint;
  const blk = await client.getBlockNumber();
  if (arg) {
    tokenId = BigInt(arg);
    const mints = await client.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: 0n, toBlock: "latest" });
    mintBlock = mints[0]?.blockNumber ?? 0n;
  } else {
    const mints = await client.getLogs({ address: POSM, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: blk - 20000n, toBlock: "latest" });
    if (!mints.length) throw new Error("no recent v4 mints found; pass a tokenId");
    const last = mints[mints.length - 1];
    tokenId = (last.args as { tokenId: bigint }).tokenId;
    mintBlock = last.blockNumber!;
  }
  console.log(`Computing v4 PnL for tokenId #${tokenId} (mint block ${mintBlock})…`);
  const p = await computePositionPnLV4(tokenId, mintBlock);
  const r = p.result;
  console.log(`  pair=${p.sym0}/${p.sym1} fee=${p.fee} open=${p.open} numeraire=${p.numeraire}(${p.numeraireKind}) version=${p.version}`);
  console.log(`  deposited=${r.depositedUsd.toFixed(6)} withdrawn=${r.withdrawnUsd.toFixed(6)} fees=${r.feesUsd.toFixed(6)}`);
  console.log(`  net=${r.netPnlUsd.toFixed(6)}  price/HODL=${r.pricePnlUsd.toFixed(6)}  IL=${r.ilUsd.toFixed(6)}`);

  // engine identity: net ≈ price + IL + fees − gas
  const identity = r.pricePnlUsd + r.ilUsd + r.feesUsd - r.gasUsd;
  const ok = Math.abs(identity - r.netPnlUsd) <= 1e-6 * Math.max(1, Math.abs(r.netPnlUsd));
  console.log(`\n${ok ? "PASS" : "FAIL"}  net identity: ${r.netPnlUsd.toFixed(6)} ≈ ${identity.toFixed(6)}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the smoke (after Task 9 makes it compile)**

Run: `npx tsx web/src/lib/chain-v4.smoke.ts`
Expected: prints a real position's PnL and `PASS net identity`. If it finds an open position, `priceBasis=mark-to-market`. Try a specific in-range closed position id too if available.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/chain-v4.smoke.ts
git commit -m "test(chain-v4): live-RPC smoke with engine-identity assertion"
```

---

## Task 9: `chain.ts` — extend PositionPnL + generalize v3 numeraire

**Files:**
- Modify: `web/src/lib/chain.ts:49-60` (PositionPnL), `:138-148` (v3 numeraire logic)

- [ ] **Step 1: Extend the PositionPnL interface**

In `web/src/lib/chain.ts`, replace the `PositionPnL` interface (lines 49-60) with:

```typescript
export type NumeraireKind = "eth" | "usd";

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
  exitTx?: string;
  result: PnLResult;
}
```

- [ ] **Step 2: Generalize the v3 price feed to use pickNumeraire**

In `web/src/lib/chain.ts`, add to the imports at the top:

```typescript
import { pickNumeraire, numerairePricePoint } from "./numeraire";
```

Replace lines 138-139 (the `token0IsWeth` block) with:

```typescript
  const num = pickNumeraire(token0, token1, sym0, sym1);
  if (!num) throw new Error(`unsupported pair ${sym0}/${sym1}`);
  const price: PriceFeed = () => numerairePricePoint(priceT1perT0, num.anchorIsToken0);
```

And update the `return` at line 148 to include the new fields:

```typescript
  return { tokenId, version: "v3", sym0, sym1, fee: Number(fee), tickLower, tickUpper, open, numeraire: num.symbol, numeraireKind: num.kind, feesComplete: true, priceT1perT0, priceBasis, txHashes, exitTx: exitTxHash(events), result };
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors (chain-v4.ts now compiles too — `numeraireKind`/`version` exist).

- [ ] **Step 4: Regression — existing v3 tests still pass**

Run: `npm run verify`
Expected: existing suites still pass (engine untouched; v3 WETH pairs now flow through `pickNumeraire` → same `{p0:1,p1:1/price}` result).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chain.ts
git commit -m "feat(chain): PositionPnL gains version + numeraireKind; v3 uses pickNumeraire"
```

---

## Task 10: `chain.ts` — merge v4 into `analyze`

**Files:**
- Modify: `web/src/lib/chain.ts:159-193` (analyzeTx / analyzeWallet / analyze)

- [ ] **Step 1: Add v4 imports + wallet enumeration**

In `web/src/lib/chain.ts` imports, add:

```typescript
import { computePositionPnLV4 } from "./chain-v4";
```

Add the v4 PositionManager const near the other address consts (after line 31):

```typescript
const POSM_V4 = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
```

Add a v4 wallet-enumeration helper (after `analyzeWallet`, before `analyze`):

```typescript
/** Enumerate a wallet's v4 positions via PositionManager ERC-721 mints held now. */
async function analyzeWalletV4Positions(wallet: string): Promise<{ tokenId: bigint; mintBlock: bigint }[]> {
  const mints = await client.getLogs({ address: POSM_V4, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: 0n, toBlock: "latest" });
  // dedupe by tokenId, keep the earliest block we saw it received (used as lifecycle fromBlock)
  const byId = new Map<bigint, bigint>();
  for (const l of mints) {
    const id = (l.args as { tokenId: bigint }).tokenId;
    const bn = l.blockNumber!;
    if (!byId.has(id) || bn < byId.get(id)!) byId.set(id, bn);
  }
  return [...byId.entries()].map(([tokenId, mintBlock]) => ({ tokenId, mintBlock }));
}
```

- [ ] **Step 2: Merge v4 into `analyzeWallet`**

Replace the body of `analyzeWallet` (lines 168-185) with:

```typescript
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
```

- [ ] **Step 3: Route v4 in `analyzeTx`**

Replace `analyzeTx` (lines 159-166) with:

```typescript
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
    const pos = await computePositionPnLV4(tokenId, receipt.blockNumber);
    return { kind: "tx", query: txHash, positions: [pos], skipped: [], totals: totalsOf([pos]) };
  }
  throw new Error("No Uniswap v3 or v4 position event in this transaction.");
}
```

Add the `evModify` ABI item near the other event consts (after line 37):

```typescript
const evModify = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
```

Note: for a v4 tx, `computePositionPnLV4` fetches the *full* lifecycle from the mint, so passing `receipt.blockNumber` as `mintBlock` would clip history. Change the v4 branch to look up the true mint block:

```typescript
    const mints = await client.getLogs({ address: POSM_V4, event: evTransfer, args: { from: "0x0000000000000000000000000000000000000000", tokenId }, fromBlock: 0n, toBlock: "latest" });
    const pos = await computePositionPnLV4(tokenId, mints[0]?.blockNumber ?? 0n);
```

(Replace the single `computePositionPnLV4(tokenId, receipt.blockNumber)` line above with these two lines.)

- [ ] **Step 4: Type-check + regression**

Run: `cd web && npx tsc --noEmit && cd .. && npm run verify`
Expected: no type errors; existing tests pass.

- [ ] **Step 5: Live smoke — a wallet with both v3 and v4**

Run: `npx tsx web/src/lib/chain-v4.smoke.ts` (confirms v4 path end-to-end).
Optionally add a temporary throwaway call to `analyze("<wallet>")` in a scratch script to confirm merge; do not commit scratch.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/chain.ts
git commit -m "feat(chain): merge v4 positions into analyze (wallet + tx)"
```

---

## Task 11: `App.tsx` — v3/v4 badge + per-position numeraire-aware money

The UI currently hard-codes `"WETH"` as the numeraire in `signMoney`/`SummaryBar` and assumes every position is ETH-denominated. Make money display per-position numeraire-aware, add a v3/v4 badge, and normalize mixed-portfolio totals to USD.

**Files:**
- Modify: `web/src/App.tsx` (imports, `conv`/`signMoney`, `SummaryBar`, `PositionCard`, `PnlCalendar`)

- [ ] **Step 1: Import numeraire + toUsd**

In `web/src/App.tsx`, update line 2-3 imports:

```typescript
import { analyze, EXPLORER, type Portfolio, type PositionPnL } from "./lib/chain";
import { toUsd } from "./lib/numeraire";
import { fmtPct, fmtToken, shortId, signUnit, signUsd } from "./lib/format";
```

- [ ] **Step 2: Make position money helpers numeraire-aware**

Replace `conv` and `signMoney` (lines 174-179) with per-position variants that respect `numeraireKind` (USD positions ignore the Ξ toggle and are always dollars):

```typescript
// A position's value converted for display. USD-numeraire positions are always
// dollars; ETH-numeraire positions honour the Ξ/USD toggle (ethUsd null = Ξ).
function convPos(valueInNumeraire: number, p: PositionPnL, ethUsd: number | null) {
  if (p.numeraireKind === "usd") return valueInNumeraire; // already USD
  return ethUsd === null ? valueInNumeraire : valueInNumeraire * ethUsd;
}
function signMoneyPos(valueInNumeraire: number, p: PositionPnL, ethUsd: number | null) {
  if (p.numeraireKind === "usd") return signUsd(valueInNumeraire);
  return ethUsd === null ? signUnit(valueInNumeraire, "WETH") : signUsd(valueInNumeraire * ethUsd);
}
// Portfolio totals are always USD-normalised (a mix of ETH- and USD-pairs can't
// share a Ξ unit). ethUsd null → ETH legs shown in their ETH value as a proxy.
function signMoneyUsd(usdValue: number) { return signUsd(usdValue); }
```

- [ ] **Step 3: USD-normalize the SummaryBar totals**

The existing `totals` in `chain.ts` sum raw `netPnlUsd` (mixed units). Compute USD-normalized totals in the UI from positions instead. Replace `SummaryBar` (lines 300-310) with:

```typescript
function SummaryBar({ positions, ethUsd }: { positions: PositionPnL[]; ethUsd: number | null }) {
  const acc = { net: 0, fees: 0, il: 0, gas: 0 };
  for (const p of positions) {
    acc.net += toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd);
    acc.fees += toUsd(p.result.feesUsd, p.numeraireKind, ethUsd);
    acc.il += toUsd(p.result.ilUsd, p.numeraireKind, ethUsd);
    acc.gas += toUsd(p.result.gasUsd, p.numeraireKind, ethUsd);
  }
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-4">
      <Stat label="Net PnL" value={signMoneyUsd(acc.net)} tone={acc.net >= 0 ? "pos" : "neg"} big />
      <Stat label="Fees earned" value={signMoneyUsd(acc.fees)} tone="pos" />
      <Stat label="Impermanent loss" value={signMoneyUsd(acc.il)} tone={acc.il < 0 ? "neg" : "muted"} />
      <Stat label="Gas spent" value={signMoneyUsd(-acc.gas)} tone={acc.gas > 0 ? "neg" : "muted"} />
    </div>
  );
}
```

Update the `SummaryBar` call site in `Results` (line 157) from `<SummaryBar totals={t} ethUsd={ethUsd} />` to:

```typescript
      <SummaryBar positions={data.positions} ethUsd={ethUsd} />
```

(If `const t = ...totals` becomes unused after this, remove that line to keep tsc `noUnusedLocals` happy.)

- [ ] **Step 4: Add the v3/v4 badge and per-position money in PositionCard**

In `PositionCard` (around line 322-343), add a version badge next to the fee-tier chip. After the fee-tier `<span>` (line 340), insert:

```typescript
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${p.version === "v4" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"}`}>
              {p.version}
            </span>
```

Replace any `signMoney(r.<field>, ethUsd, "WETH")` calls inside `PositionCard` with `signMoneyPos(r.<field>, p, ethUsd)` and any `conv(r.<field>, ethUsd)` with `convPos(r.<field>, p, ethUsd)`. (There is one `conv(r.netPnlUsd, ethUsd)` at line 324 → `convPos(r.netPnlUsd, p, ethUsd)`.)

Also add a "fees partial" chip next to the version badge for positions whose fee-growth state was pruned. After the version `<span>` you just added, insert:

```typescript
            {!p.feesComplete && (
              <span
                className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                title="Some of this position's fee history is older than the RPC's ~14-day state retention, so accrued fees for that period could not be measured and are understated. Principal, price PnL and IL are exact."
              >
                ~ fees partial
              </span>
            )}
```

- [ ] **Step 5: Fix the calendar's hard-coded WETH**

`PnlCalendar` (lines 245, 257, 268, 276, 231) uses `signMoney(..., "WETH")` and aggregates across positions. Since a calendar bucket can mix numeraires, normalize its buckets to USD. In `PnlCalendar` (line 190-191), change the mapping to store USD:

```typescript
        .map((p) => ({
          closedAt: p.result.closedAt,
          net: toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd),
          fees: toUsd(p.result.feesUsd, p.numeraireKind, ethUsd),
          il: toUsd(p.result.ilUsd, p.numeraireKind, ethUsd),
          tokenId: p.tokenId,
        })),
```

Then replace every `signMoney(x, ethUsd, "WETH")` in `PnlCalendar` with `signMoneyUsd(x)` and every `signUnit(x, "WETH")` in its title strings with `signMoneyUsd(x)`. The per-position row at line 276 becomes `signMoneyUsd(toUsd(p.result.netPnlUsd, p.numeraireKind, ethUsd))`.

- [ ] **Step 6: Type-check + build**

Run: `cd web && npx tsc --noEmit && npm run build && cd ..`
Expected: no type errors, production build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(ui): v3/v4 badge + per-position numeraire; USD-normalised totals"
```

---

## Task 12: Wire tests, full verify, docs, final commit

**Files:**
- Modify: `package.json:scripts.verify`
- Modify: `README.md`

- [ ] **Step 1: Add new tsx tests to `verify`**

In `package.json`, change the `verify` script to include the new suites:

```json
    "verify": "tsx src/trace.test.ts && tsx src/exit-price.test.ts && tsx src/config.test.ts && tsx web/src/lib/calendar.test.ts && tsx web/src/lib/numeraire.test.ts && tsx web/src/lib/v4-decode.test.ts",
```

- [ ] **Step 2: Run the full verify suite**

Run: `npm run verify`
Expected: every suite prints `N/N passed`, exit 0.

- [ ] **Step 3: Run the live v4 smoke**

Run: `npx tsx web/src/lib/chain-v4.smoke.ts`
Expected: prints a real v4 position and `PASS net identity`.

- [ ] **Step 4: Update README scope note**

In `README.md`, replace the "v3 only … v4 … not covered here yet" note (around lines 7-9) with a line stating v4 and USDG pairs are now supported, e.g.:

```markdown
Covers Uniswap **v3 and v4** LP positions on Robinhood chain. ETH-pair positions
are denominated in ETH (toggle to USD); USDG-pair positions are denominated in USD.
v4 positions are read from the PoolManager / PositionManager / StateView, with
principal reconstructed geometrically and fees from fee-growth accumulators.
```

- [ ] **Step 5: Final commit**

```bash
git add package.json README.md
git commit -m "chore: wire v4/numeraire tests into verify; document v4 + USDG support"
```

---

## Self-Review notes (for the executor)

- **Engine untouched:** no task edits `computePnL`/`resolveActions`. If you find yourself changing them, stop — the v4 driver must emit `decrease(principal)` + `collect(principal+fee)` so the existing `fee = collect − decrease` identity holds.
- **Sync direction:** engine edits go in `src/uniswap-v3-pnl.ts` then `npm run sync:core`. Never edit `web/src/lib/uniswap-v3-pnl.ts` directly.
- **Type names are stable across tasks:** `NumeraireKind` ("eth"|"usd"), `Numeraire{kind,anchorIsToken0,symbol}`, `V4RawEvent`, `BlockState{tick,fg0,fg1}`, `PoolKey`, `PositionPnL{version,numeraireKind,…}`.
- **Native ETH:** `currency0` can be `0x000…000` → `tokenMeta` returns `{dec:18, sym:"ETH"}`; `pickNumeraire` treats it as an ETH anchor. Do not call `decimals()`/`symbol()` on the zero address.
- **Spec deviation (mechanism):** the spec assumed StateView might be undiscoverable and used archive-free geometry with a "fees unavailable" fallback. StateView **is** found (`0xF333…673b`), but the RPC only retains ~14 days of state (verified: OK at −12M blocks, `missing trie node` at −15M). So the plan derives **price/tick from Swap logs (archive-free → principal, IL, price PnL exact for all positions)** and takes **fees from fee-growth best-effort**, flagging `feesComplete=false` (and a "~ fees partial" UI chip) when an event block's state is pruned. A position is never skipped for pruning — only its fees may be understated, clearly flagged.
- **Known limitations:** (1) within-block ordering (a swap in the same block as a modify) is approximated at block granularity. (2) Multiple modify events for the same tokenId in one tx would collide in `resolveActions` (one kind per tx) — same constraint as v3. (3) `getLogs` for `Swap`/`ModifyLiquidity` filtered by `poolId` over a busy pool's full range may hit the RPC's range/rate limits; scope from `mintBlock` (done) and add adaptive range-splitting if a large pool trips it.
```
