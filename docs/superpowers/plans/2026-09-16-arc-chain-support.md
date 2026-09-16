# Arc Chain Support (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployed LP PnL calculator multi-chain — add Circle's Arc chain (5042, v4-only, USDC-native, no ETH) alongside Robinhood Chain (4663), with an in-app `Robinhood | Arc` toggle. View-only; no funds move.

**Architecture:** Generalize the hardcoded `ROBINHOOD_CHAIN` config into a `ChainConfig` type with two instances. Convert `chain.ts`/`chain-v4.ts`/`chain-cache.ts` from module-level singletons into per-chain **factories** (`createChainCache(chain)`, `createChainClient(chain)`) so Robinhood and Arc can hold independent live state (RPC client, rate limiter, reorg-finality head, IndexedDB namespace) inside one running SPA — a single shared `observedHead`/rate-limiter across two different RPC providers would silently corrupt both. `numeraire.ts`'s pure functions take an explicit `ChainConfig` parameter instead of importing one. The Netlify `/rpc` edge function routes by a new `chain` query param to a **separate, no-default** set of Arc env vars, so an unconfigured Arc fails loudly instead of guessing an endpoint.

**Tech Stack:** TypeScript, React, viem, Vite, Netlify Edge Functions. Tests are hand-rolled `console.log` PASS/FAIL scripts run via `tsx` (see `npm run verify` in the repo root `package.json`) — **not vitest**, despite the `.test.ts` naming.

**Reference:** `docs/superpowers/specs/2026-09-16-arc-chain-support-design.md` (approved design). Two refinements found during planning that the design doc did not anticipate, both handled below:
1. **Gas is not always ETH.** Arc's native gas token IS its usd anchor (USDC) — `netAfterGas`/`gasInNumeraire`'s hardcoded `"eth"` gas-kind is wrong for Arc and would either throw or silently mis-price every Arc position's gas line. Fixed via a new `PositionPnL.gasKind` field (Task 6, Task 9).
2. **The explorer link and the explorer API are different concerns.** The design doc's single `explorer: string | null` conflated "Blockscout API used for internal-tx fee reconstruction" (Robinhood-only, correctly out of scope for Arc) with "human explorer website for tx/address hyperlinks" (which Arc will eventually have, just not confirmed at design time). Split into `explorerUrl` (links) and the internal-tx reconstruction path staying Robinhood-only regardless (Task 1, Task 9).

**Critical ordering hazard — read before starting:** `web/src/lib/uniswap-v3-pnl.ts` is a **copy** of `src/uniswap-v3-pnl.ts` (root), kept in sync by `npm run sync:core` (`cp src/uniswap-v3-pnl.ts web/src/lib/uniswap-v3-pnl.ts`). Every edit in this plan targets the **web copy only** — Arc is a web/Netlify-only feature, the CLI (`src/live.ts`) stays Robinhood-only, matching the precedent already set in `docs/superpowers/specs/2026-07-22-v4-usdg-lp-pnl-design.md`'s non-goals. **Do not run `npm run sync:core` at any point while or after doing this work** — it copies `src/` over `web/src/lib/`, which would silently delete `ARC_CHAIN` and everything built on it with no error. If a future task needs to run that script, it must first port `ChainConfig`/`ARC_CHAIN` into `src/uniswap-v3-pnl.ts` too, which is out of scope here.

---

## Task 1: `ChainConfig` type + `ARC_CHAIN` in `uniswap-v3-pnl.ts`

**Files:**
- Modify: `web/src/lib/uniswap-v3-pnl.ts:252-288` (the "ROBINHOOD CHAIN CONFIG" section) and `:358` (`fromMulticallTrace`'s default npm)
- Test: `web/src/lib/chain-config.test.ts` (new)
- Modify: `package.json:11` (root — append the new test to `verify`)

- [ ] **Step 1: Replace the config section**

Replace lines 252–288 of `web/src/lib/uniswap-v3-pnl.ts` (from the `// 4. ROBINHOOD CHAIN CONFIG` comment through the closing `} as const;`) with:

```ts
// ─────────────────────────────────────────────────────────────────────────
// 4. CHAIN CONFIG — one shape, two live chains (Robinhood, Arc)
// ─────────────────────────────────────────────────────────────────────────

export interface ChainConfig {
  chainId: number;
  /** "" for a chain with no browser-trusted public URL — Arc has none at design time; the browser always calls the same-origin /rpc proxy anyway, never this directly. */
  rpcUrl: string;
  /** Selects the /rpc proxy's upstream env-var set — see netlify/edge-functions/rpc.ts. "" (Robinhood) omits the query param entirely, preserving today's exact /rpc URL. */
  rpcChainSlug: "" | "arc";
  /** Human explorer site for tx/address links, or null to render plain (unlinked) hashes — see PositionCard. Distinct from the Blockscout-specific internal-tx API below. */
  explorerUrl: string | null;
  /**
   * Blockscout `/api/v2/...` base used ONLY for v4 native-currency internal-transaction
   * fee reconstruction (see chain-v4.ts's fetchTraceCalls). Robinhood-only: Arc's
   * explorer (Arcscan) has a different API shape, and Arc's supported pairs never hit
   * this path anyway (native-currency pairs are unsupported on Arc — see tokens below).
   */
  explorerInternalTxApi: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  uniswapV3: {
    factory: string;
    nonfungiblePositionManager: string;
    swapRouter02: string;
    quoterV2: string;
    multicall: string;
    tickLens: string;
    universalRouter: string;
  } | null;
  uniswapV4: {
    poolManager: string;
    positionManager: string;
    stateView: string;
    modifyLiquidityTopic0: string;
  };
  tokens: {
    /** Any token here makes a pair "usd"-numeraire (values already dollars). */
    usdAnchors: readonly string[];
    /** Any token here makes a pair "eth"-numeraire (values in whole ETH). Empty = no ETH concept on this chain. */
    ethAnchors: readonly string[];
    usdDecimals: number;
  };
  /**
   * True when this chain's NATIVE GAS TOKEN is its own usd anchor (Arc: gas is paid in
   * USDC, same asset the pairs anchor on — no price lookup needed, 1:1). False on
   * Robinhood, where gas (ETH) is a different asset from the usd anchor (USDG) and needs
   * the pool-derived ETH/USD rate to convert. See numeraire.ts's `gasKind`.
   */
  gasIsUsdAnchor: boolean;
  /** GeckoTerminal network slug for the swap-volume chart, or null if none is confirmed. */
  geckoTerminalSlug: string | null;
}

export const ROBINHOOD_CHAIN: ChainConfig = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  rpcChainSlug: "",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  explorerInternalTxApi: "https://robinhoodchain.blockscout.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  uniswapV3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    nonfungiblePositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    multicall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3",
    tickLens: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  },
  uniswapV4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    // ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
    modifyLiquidityTopic0: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  },
  tokens: {
    usdAnchors: ["0x5fc5360d0400a0fd4f2af552add042d716f1d168"], // USDG
    ethAnchors: [
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
      "0x0000000000000000000000000000000000000000", // native ETH (v4 currency)
    ],
    usdDecimals: 6,
  },
  gasIsUsdAnchor: false,
  geckoTerminalSlug: "robinhood",
};

/**
 * Circle's Arc chain — chainId 5042, public mainnet opened 2026-09-16. USDC is the
 * native gas asset; there is no WETH/native-ETH concept at all. Only Uniswap v4 is
 * deployed (confirmed at launch; no v3 announced or found).
 *
 * v4 addresses are ASSUMED identical to Robinhood's, on the strength of Robinhood's
 * PoolManager matching oarfish's independently-verified Arc PoolManager byte-for-byte
 * (Uniswap v4 periphery deploys via CREATE2 to the same address on every chain). See
 * docs/superpowers/specs/2026-09-16-arc-chain-support-design.md "Verification" — a
 * boot-time code-presence check (Task 11) gates this before any Arc position is read.
 *
 * `ARC_USDC` (the 6-decimal ERC-20 predeploy) is deliberately the ONLY usd anchor
 * matched. Arc also exposes the same USDC balance as a NATIVE currency (address 0, 18
 * decimals) inside v4 PoolKeys — oarfish's own Arc port calls mixing the two
 * representations "the #1 documented integration risk" on this chain. A pair against
 * the native representation falls through `pickNumeraire` as unsupported, same as any
 * other unrecognized pair — see numeraire.ts.
 */
export const ARC_CHAIN: ChainConfig = {
  chainId: 5042,
  rpcUrl: "",
  rpcChainSlug: "arc",
  explorerUrl: null, // Arcscan's public site URL is unconfirmed at design time — links render as plain text until this is set
  explorerInternalTxApi: null, // Arcscan's API shape differs from Blockscout; unneeded (Arc never hits the native-currency internal-tx path — see tokens below)
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  uniswapV3: null,
  uniswapV4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    modifyLiquidityTopic0: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  },
  tokens: {
    usdAnchors: ["0x3600000000000000000000000000000000000000"], // ARC_USDC predeploy, 6 decimals
    ethAnchors: [],
    usdDecimals: 6,
  },
  gasIsUsdAnchor: true,
  geckoTerminalSlug: null,
};
```

- [ ] **Step 2: Fix the now-nullable `uniswapV3` access in `fromMulticallTrace`**

In `web/src/lib/uniswap-v3-pnl.ts`, change (around line 358):

```ts
  const npm = (opts.npm ?? ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager).toLowerCase();
```

to:

```ts
  const npm = (opts.npm ?? ROBINHOOD_CHAIN.uniswapV3!.nonfungiblePositionManager).toLowerCase();
```

(Safe: `ROBINHOOD_CHAIN` is a fixed literal that always sets `uniswapV3`; this function is v3-only and never called for Arc.)

- [ ] **Step 3: Write the config test**

Create `web/src/lib/chain-config.test.ts`:

```ts
import { ROBINHOOD_CHAIN, ARC_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

eq("robinhood has v3", ROBINHOOD_CHAIN.uniswapV3 !== null, true);
eq("arc has no v3", ARC_CHAIN.uniswapV3, null);
eq("arc has no eth anchors", ARC_CHAIN.tokens.ethAnchors.length, 0);
eq("robinhood has eth anchors", ROBINHOOD_CHAIN.tokens.ethAnchors.length > 0, true);
eq("arc gas is usd-anchor", ARC_CHAIN.gasIsUsdAnchor, true);
eq("robinhood gas is not usd-anchor", ROBINHOOD_CHAIN.gasIsUsdAnchor, false);
eq("arc chainId", ARC_CHAIN.chainId, 5042);
eq("robinhood chainId unchanged", ROBINHOOD_CHAIN.chainId, 4663);
eq("arc rpc chain slug", ARC_CHAIN.rpcChainSlug, "arc");
eq("robinhood rpc chain slug is empty (URL unchanged)", ROBINHOOD_CHAIN.rpcChainSlug, "");
eq("robinhood v4 poolManager unchanged", ROBINHOOD_CHAIN.uniswapV4.poolManager, "0x8366a39cc670b4001a1121b8f6a443a643e40951");
eq(
  "arc v4 poolManager matches robinhood's (CREATE2 determinism)",
  ARC_CHAIN.uniswapV4.poolManager,
  ROBINHOOD_CHAIN.uniswapV4.poolManager,
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/chain-config.test.ts`
Expected: `12/12 passed` (adjust count if you added/removed assertions above), exit code 0.

- [ ] **Step 5: Add it to the root `verify` script**

In root `package.json`, append `&& tsx web/src/lib/chain-config.test.ts` to the end of the `"verify"` script string (after the existing `... tsx web/src/lib/provisional.test.ts` entry).

- [ ] **Step 6: Commit**

```bash
cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl
git add web/src/lib/uniswap-v3-pnl.ts web/src/lib/chain-config.test.ts package.json
git commit -m "feat(arc): add ChainConfig type and ARC_CHAIN alongside ROBINHOOD_CHAIN"
```

---

## Task 2: Parameterize `numeraire.ts` by `ChainConfig`

**Files:**
- Modify: `web/src/lib/numeraire.ts` (whole file — small)
- Modify: `web/src/lib/numeraire.test.ts` (update call sites, add Arc cases)

- [ ] **Step 1: Update the failing calls first (see them break)**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/numeraire.test.ts`
Expected: passes today (baseline) — note the current `12/12`-style count before changing anything, so Step 4 below has something to compare against.

- [ ] **Step 2: Rewrite `numeraire.ts`**

Replace the full contents of `web/src/lib/numeraire.ts` with:

```ts
/**
 * Numeraire selection for a pool pair. The PnL engine prices the "anchor" leg at
 * 1, so its USD/ETH-labelled figures are really *anchor-unit* figures. A chain's
 * usdAnchors pair anchors on the dollar (values already USD); ethAnchors anchor
 * on ETH (UI ×ethUsd). Both are chain-scoped now — Arc has no ethAnchors at all.
 */
import type { ChainConfig } from "./uniswap-v3-pnl";

export type NumeraireKind = "eth" | "usd";
export interface Numeraire {
  kind: NumeraireKind;
  anchorIsToken0: boolean;
  symbol: string; // "USD" for usd; "WETH" for eth (drives the Ξ glyph in format.ts)
}

const norm = (a: string) => a.toLowerCase();

/** Choose the value unit for a pair on `chain`. usd beats eth. null = unsupported pair. */
export function pickNumeraire(chain: ChainConfig, token0: string, token1: string, _sym0: string, _sym1: string): Numeraire | null {
  const t0 = norm(token0), t1 = norm(token1);
  const usdAnchors = new Set(chain.tokens.usdAnchors.map(norm));
  const ethAnchors = new Set(chain.tokens.ethAnchors.map(norm));
  if (usdAnchors.has(t0) || usdAnchors.has(t1)) return { kind: "usd", anchorIsToken0: usdAnchors.has(t0), symbol: "USD" };
  if (ethAnchors.has(t0) || ethAnchors.has(t1)) return { kind: "eth", anchorIsToken0: ethAnchors.has(t0), symbol: "WETH" };
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

/**
 * A position's value (in its own numeraire) expressed in a chosen DISPLAY unit,
 * using an ETH/USD rate that is always available (decoupled from the display
 * toggle). This makes the ETH and USD views mutually consistent — the ETH view
 * is exactly the USD view divided by the rate — and lets a MIXED wallet (WETH-
 * and USDG-quoted positions) aggregate coherently in either unit:
 *   • usd display → the position's USD value (eth×rate, usd as-is)
 *   • eth display → that USD value ÷ rate, so USDG positions convert to Ξ too
 * A non-positive rate can't define an ETH view, so it falls back to the ETH-
 * native value (0 for a USD position) instead of dividing by zero.
 */
export function displayValue(
  valueInNumeraire: number,
  kind: NumeraireKind,
  ethUsd: number,
  unit: "eth" | "usd",
): number {
  const usd = toUsd(valueInNumeraire, kind, ethUsd);
  if (unit === "usd") return usd;
  if (ethUsd > 0) return usd / ethUsd;
  return kind === "eth" ? valueInNumeraire : 0; // no rate → can't price USD in Ξ
}

/**
 * A position's pre-gas net (in its own numeraire) minus native gas, both expressed
 * in the chosen display unit via the shared rate.
 *
 * `gasKind` is what unit `gasNative` is ALREADY in — not always "eth". Robinhood's
 * gas is native ETH, a different asset from its usd anchor (USDG), so it needs the
 * rate to convert. Arc's gas IS its usd anchor (USDC) — gasKind "usd" there means
 * `displayValue` treats it as already-dollars and the rate is never consulted, which
 * is correct: there is no ETH/USD rate to consult on a chain with no ETH at all.
 */
export function netAfterGas(
  netInNumeraire: number,
  kind: NumeraireKind,
  gasNative: number,
  gasKind: NumeraireKind,
  ethUsd: number,
  unit: "eth" | "usd",
): number {
  return displayValue(netInNumeraire, kind, ethUsd, unit) - displayValue(gasNative, gasKind, ethUsd, unit);
}

/**
 * Native gas (already in whole native-gas-token units) expressed in the pair's
 * numeraire unit.
 *
 * `chain.gasIsUsdAnchor` short-circuits the whole lookup: when the native gas
 * token IS the chain's usd anchor (Arc), gas is already correctly denominated
 * for a "usd" pair (1:1, no price needed) and undefined for an "eth" pair (Arc
 * has none, so this branch is unreachable in practice — returned as 0 rather
 * than throwing, matching the "can't be priced" convention below).
 *
 * Otherwise (Robinhood): eth-numeraire pairs keep gas as ETH; usd-numeraire
 * pairs convert via the pool's WETH leg price (`priceT1perT0`) — the only
 * archive-free ETH/USD source available. Returns 0 for a usd pair with no WETH
 * leg (gas can't be priced, and ETH-as-USD would be a unit error).
 */
export function gasInNumeraire(
  chain: ChainConfig,
  gasNative: number,
  num: Numeraire,
  token0: string,
  token1: string,
  priceT1perT0: number,
): number {
  if (chain.gasIsUsdAnchor) return num.kind === "usd" ? gasNative : 0;
  if (num.kind === "eth") return gasNative; // result already denominated in ETH
  const pp = numerairePricePoint(priceT1perT0, num.anchorIsToken0); // p0/p1 = USD per whole token
  const ethAnchors = new Set(chain.tokens.ethAnchors.map(norm));
  const ethUsd = ethAnchors.has(norm(token0)) ? pp.p0 : ethAnchors.has(norm(token1)) ? pp.p1 : null;
  return ethUsd == null ? 0 : gasNative * ethUsd;
}


/** One numeraire's slice of a portfolio. Values are in that numeraire's unit. */
export interface NumeraireBucket { net: number; fees: number; il: number; count: number }

/**
 * A portfolio's totals, split by the unit they are actually denominated in, plus gas.
 *
 * `gas` and `count` are unambiguous — gas is native ETH whatever the pair quotes in, and
 * a position is a position.
 */
export interface PortfolioTotals {
  eth: NumeraireBucket; // WETH/native-quoted positions, in Ξ
  usd: NumeraireBucket; // USDG-quoted positions, in dollars
  gas: number;          // native ETH across every position, in Ξ
  count: number;        // positions read
}

/** The fields of a position that a total is made of — structural, so `PositionPnL` fits. */
export interface TotalsInput {
  numeraireKind: NumeraireKind;
  gasEth: number;
  result: { netPnlUsd: number; feesUsd: number; ilUsd: number };
}

/**
 * Sum a portfolio WITHOUT mixing units.
 *
 * `netPnlUsd` and friends are anchor-unit, not dollars: ether for a WETH pair, dollars
 * for a USDG one (see `pickNumeraire`). Adding them across a mixed wallet yields a number
 * in no unit at all — 0x7e99…A2C once read "net=120.86", which was ~dollars from its USDG
 * positions with a little ether stirred in.
 *
 * Converting here instead would need an ETH/USD rate, and baking one into the portfolio
 * puts a second, staler source of truth beside the live rate the UI already prices with.
 * So the buckets stay separate and a caller wanting ONE number supplies the rate itself —
 * which is exactly what `SummaryBar` does, per position, via `displayValue`/`netAfterGas`.
 */
export function totalsByNumeraire(positions: readonly TotalsInput[]): PortfolioTotals {
  const bucket = (): NumeraireBucket => ({ net: 0, fees: 0, il: 0, count: 0 });
  const t: PortfolioTotals = { eth: bucket(), usd: bucket(), gas: 0, count: positions.length };
  for (const p of positions) {
    const b = p.numeraireKind === "usd" ? t.usd : t.eth;
    b.net += p.result.netPnlUsd;
    b.fees += p.result.feesUsd;
    b.il += p.result.ilUsd;
    b.count++;
    t.gas += p.gasEth;
  }
  return t;
}
```

Note `totalsByNumeraire`/`PortfolioTotals`/`TotalsInput` are unchanged — `gas`/`gasEth` there stays a plain sum of whatever native units each position reports, which remains correct as a raw total regardless of what asset it is (it is never itself converted to a display unit without going through `gasInNumeraire`/`netAfterGas` first, at the UI layer — see Task 9).

- [ ] **Step 3: Update `numeraire.test.ts` call sites and add Arc cases**

In `web/src/lib/numeraire.test.ts`:

Replace the import line:
```ts
import { pickNumeraire, numerairePricePoint, toUsd, gasInNumeraire, displayValue, netAfterGas, type NumeraireKind, totalsByNumeraire } from "./numeraire";
```
with:
```ts
import { pickNumeraire, numerairePricePoint, toUsd, gasInNumeraire, displayValue, netAfterGas, type NumeraireKind, totalsByNumeraire } from "./numeraire";
import { ROBINHOOD_CHAIN, ARC_CHAIN } from "./uniswap-v3-pnl";
```

Replace every `pickNumeraire(...)` call to pass `ROBINHOOD_CHAIN` first, e.g. change:
```ts
eq("usdg pair kind", pickNumeraire(WETH, USDG, "WETH", "USDG").kind, "usd");
```
to:
```ts
eq("usdg pair kind", pickNumeraire(ROBINHOOD_CHAIN, WETH, USDG, "WETH", "USDG")!.kind, "usd");
```
(apply the same `ROBINHOOD_CHAIN` insertion + non-null assertion to every other `pickNumeraire(...)` call in the file: the "usdg anchor is token1", "usdg symbol", "usdg token0 anchor", "native eth kind", "native eth anchor token0", "weth token1 kind" lines, and the `unsupported` line keeps `ROBINHOOD_CHAIN` too but with no `!`.)

Replace every `gasInNumeraire(...)` call to insert `ROBINHOOD_CHAIN` as the first argument, e.g.:
```ts
  approx("gas eth-numeraire stays ETH", gasInNumeraire(ROBINHOOD_CHAIN, 0.01, ethNum, NATIVE, FOO, 5), 0.01);
  approx("gas USD via WETH token0 leg", gasInNumeraire(ROBINHOOD_CHAIN, 0.01, usdWethNum, WETH, USDG, 2000), 20);
  eq("gas USD pair w/o WETH → 0 (no ETH price)", gasInNumeraire(ROBINHOOD_CHAIN, 0.01, usdNoWeth, USDG, FOO, 2000), 0);
```
and update the `pickNumeraire` calls that build `ethNum`/`usdWethNum`/`usdNoWeth` the same way (`pickNumeraire(ROBINHOOD_CHAIN, ...)!`).

Replace every `netAfterGas(...)` call to insert the `gasKind` parameter (Robinhood: `"eth"`, unchanged behavior) right after `gasEth`, e.g. change:
```ts
  approx("usd pos net after gas, usd unit", netAfterGas(100, "usd", gasEth, rate, "usd"), 100 - 0.06);
  approx("usd pos net after gas, eth unit", netAfterGas(100, "usd", gasEth, rate, "eth"), 100 / 3000 - 0.00002);
  approx("eth pos net after gas, eth unit", netAfterGas(0.05, "eth", gasEth, rate, "eth"), 0.05 - 0.00002);
  approx("eth pos net after gas, usd unit", netAfterGas(0.05, "eth", gasEth, rate, "usd"), 150 - 0.06);
  approx("no gas = plain displayValue", netAfterGas(100, "usd", 0, rate, "usd"), 100);
```
to:
```ts
  approx("usd pos net after gas, usd unit", netAfterGas(100, "usd", gasEth, "eth", rate, "usd"), 100 - 0.06);
  approx("usd pos net after gas, eth unit", netAfterGas(100, "usd", gasEth, "eth", rate, "eth"), 100 / 3000 - 0.00002);
  approx("eth pos net after gas, eth unit", netAfterGas(0.05, "eth", gasEth, "eth", rate, "eth"), 0.05 - 0.00002);
  approx("eth pos net after gas, usd unit", netAfterGas(0.05, "eth", gasEth, "eth", rate, "usd"), 150 - 0.06);
  approx("no gas = plain displayValue", netAfterGas(100, "usd", 0, "eth", rate, "usd"), 100);
```

Then append, right before the final `console.log(`\n${pass}/${pass + fail} passed`);` line, a new Arc-specific block:

```ts
// ---------------------------------------------------------------------------
// Arc: no ETH concept at all. Every supported pair is "usd", and gas (native
// USDC) is ALREADY that pair's numeraire — no rate, no WETH-leg lookup.
// ---------------------------------------------------------------------------
{
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const ARC_NATIVE = "0x0000000000000000000000000000000000000000"; // native USDC representation — must stay unsupported
  const OTHER = "0x000000000000000000000000000000000000abcd";

  eq("arc usdc pair kind", pickNumeraire(ARC_CHAIN, ARC_USDC, OTHER, "USDC", "OTHER")!.kind, "usd");
  eq("arc native usdc representation is unsupported", pickNumeraire(ARC_CHAIN, ARC_NATIVE, OTHER, "USDC", "OTHER"), null);
  eq("arc has no eth-numeraire pairs", pickNumeraire(ARC_CHAIN, ARC_NATIVE, ARC_USDC, "USDC", "USDC"), null);

  const arcUsd = pickNumeraire(ARC_CHAIN, ARC_USDC, OTHER, "USDC", "OTHER")!;
  approx("arc gas: usd pair, gasKind usd → 1:1, no rate needed", gasInNumeraire(ARC_CHAIN, 0.02, arcUsd, ARC_USDC, OTHER, 1), 0.02);

  approx(
    "arc netAfterGas: usd pos, usd gasKind, rate irrelevant",
    netAfterGas(100, "usd", 0.02, "usd", 0 /* no rate on Arc — must not be consulted */, "usd"),
    100 - 0.02,
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/numeraire.test.ts`
Expected: every line `PASS`, final count `N/N passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/numeraire.ts web/src/lib/numeraire.test.ts
git commit -m "feat(arc): parameterize numeraire.ts by ChainConfig; add gasKind"
```

---

## Task 3: Convert `chain-cache.ts` into a per-chain factory

**Why a factory and not a parameter:** `observedHead` is a single mutable module-level variable. If Robinhood and Arc share it, switching the UI toggle to Arc (small block numbers) right after a Robinhood scan (large block numbers) would make `isFinal()` say every freshly-fetched Arc block is already reorg-safe, because `observedHead` is still Robinhood's huge number — corrupting the one safety rule this cache has. Each chain needs its OWN `observedHead`.

**Files:**
- Modify: `web/src/lib/chain-cache.ts` (whole file)
- Modify: `web/src/lib/chain-cache.test.ts` (call sites + a new cross-chain isolation test)

- [ ] **Step 1: Baseline — run the existing test**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/chain-cache.test.ts`
Note the current pass count.

- [ ] **Step 2: Rewrite `chain-cache.ts` as a factory**

Replace the full contents of `web/src/lib/chain-cache.ts` with:

```ts
/**
 * The persistent half of the scan cache: what may be written down, under what key, and
 * for how long. One instance per chain — see `createChainCache` at the bottom.
 *
 * A wallet scan is latency-bound. Measured on a 232-position wallet, cutting the number
 * of requests by 47% bought only 11% of the clock -- what is left is round trips, and the
 * only way to remove a round trip is to already know the answer. Everything cached here
 * is a fact about a settled block, so a second visit to the same wallet can know almost
 * all of them before it starts.
 *
 * TWO LAYERS, and both are needed:
 *
 *   in-flight promise (promise-cache.ts)   collapses duplicates WITHIN one scan
 *   IndexedDB (idb.ts)                     carries answers ACROSS page loads
 *
 * Without the first, several positions asking for the same pool at once all miss and all
 * query. Without the second, every reload starts from nothing.
 *
 * FINALITY is the one safety rule: nothing is written down until it is `REORG_DEPTH`
 * blocks behind the head, so the cache can never hold a log or a receipt the chain has
 * since disowned. The two kinds of entry learn where the head is DIFFERENTLY, and it is
 * worth being clear about which:
 *
 *   ranges  from the request's own upper bound. A log query already names the block it
 *           reads up to, so `nextPersistTo` measures against that and needs nothing
 *           global -- this path is self-contained, and `noteHead` does not affect it.
 *   points  from `noteHead`. A block timestamp or a receipt is asked for by id, and the
 *           call site has no idea how old it is, so the head has to come from the scan.
 *           Until `noteHead` is called nothing is final and no point persists -- the safe
 *           default, not an oversight: a path that forgets it is slow, not wrong.
 *
 * `observedHead` is per-instance (a closure variable), not module-level: two chains in
 * the same running page must not share one reorg-finality clock — see the design note in
 * docs/superpowers/plans/2026-09-16-arc-chain-support.md, Task 3.
 *
 * ESCAPE HATCH: load the page with `?nocache=1` to run against the null store, i.e. the
 * exact behaviour this module did not exist. Anything that looks wrong should be checked
 * that way first. (Global, not per-chain — it disables the underlying IndexedDB store
 * entirely, for every chain's instance.)
 */
import { cachedByKey, clearPromiseCache } from "./promise-cache";
import { cachedTokenMeta, clearTokenMetaCache, type TokenMeta } from "./token-meta";
import { getStore, nullStore, setStore, type PersistentStore } from "./idb";
import {
  groupByCachedTo, mergeLogs, nextPersistTo, planRangeFetch, upTo, type RangeRecord,
} from "./log-cache";
import type { ChainConfig } from "./uniswap-v3-pnl";

/**
 * How far behind the head a block must be before its logs, timestamp or receipt are
 * written to disk.
 *
 * ~512 blocks is on the order of ten minutes on Robinhood Chain, the chain this depth was
 * measured against. The positions this app reads are hours to months old, so in practice
 * nothing a scan cares about is inside the window and the depth costs nothing; it exists
 * so that a scan run seconds after a mint does not bake the tip into a cache that outlives
 * it. Raising it is cheap (one narrow tail query per key per visit); lowering it below a
 * chain's real reorg depth is not. Arc's real block time is unmeasured at design time (see
 * the design doc) — this constant is shared across chains for now as the conservative
 * choice; if Arc turns out to reorg deeper than ~512 blocks, raise it per-chain here.
 */
export const REORG_DEPTH = 512n;

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("nocache")) {
  setStore(nullStore);
}

export interface ChainCache {
  noteHead(head: bigint): void;
  isFinal(blockNumber: bigint): boolean;
  cachedPoint<T>(key: string, fetcher: () => Promise<T>, finalityOf: (value: T) => boolean, usable?: (value: T) => boolean): Promise<T>;
  cachedBlockTimestamp(blockNumber: bigint, fetcher: (blockNumber: bigint) => Promise<number>): Promise<number>;
  cachedReceipt<T extends { blockNumber: bigint }>(hash: string, fetcher: (hash: string) => Promise<T>): Promise<T>;
  cachedTokenMetaPersistent(address: string, fetcher: (address: string) => Promise<TokenMeta>): Promise<TokenMeta>;
  cachedLogRange<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    key: string, from: bigint, to: bigint, fetchRange: (from: bigint, to: bigint) => Promise<L[]>,
  ): Promise<L[]>;
  cachedLogsById<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    keyPrefix: string, ids: readonly bigint[], from: bigint, to: bigint,
    fetchIds: (ids: bigint[], from: bigint, to: bigint) => Promise<L[]>, idOf: (log: L) => bigint,
  ): Promise<Map<bigint, L[]>>;
  resetCaches(): Promise<void>;
  resetHead(): void;
}

/**
 * Build a cache scoped to one chain.
 *
 * `NS` keeps two chains from sharing an entry on disk (they share the SAME IndexedDB
 * database — `resetCaches` on either instance still clears the whole store; see the note
 * on `resetCaches` below). The `v1` is the SEMANTIC version -- bump it when the meaning of
 * a stored value changes without its shape changing, which the IndexedDB version bump in
 * idb.ts would not catch.
 */
export function createChainCache(chain: ChainConfig): ChainCache {
  const NS = `v1:${chain.chainId}`;
  let observedHead = 0n;

  function noteHead(head: bigint): void {
    if (head > observedHead) observedHead = head;
  }

  function isFinal(blockNumber: bigint): boolean {
    return observedHead > 0n && blockNumber + REORG_DEPTH <= observedHead;
  }

  function cachedPoint<T>(
    key: string,
    fetcher: () => Promise<T>,
    finalityOf: (value: T) => boolean,
    usable: (value: T) => boolean = () => true,
  ): Promise<T> {
    return cachedByKey(`${NS}:point:${key}`, async () => {
      const store = await getStore();
      const hit = await store.get<T>("points", `${NS}:${key}`);
      if (hit !== undefined && usable(hit)) return hit;
      const value = await fetcher();
      if (finalityOf(value)) void store.put("points", `${NS}:${key}`, value);
      return value;
    });
  }

  function cachedBlockTimestamp(blockNumber: bigint, fetcher: (blockNumber: bigint) => Promise<number>): Promise<number> {
    return cachedPoint(`blockts:${blockNumber}`, () => fetcher(blockNumber), () => isFinal(blockNumber));
  }

  function cachedReceipt<T extends { blockNumber: bigint }>(hash: string, fetcher: (hash: string) => Promise<T>): Promise<T> {
    return cachedPoint(`receipt:${hash.toLowerCase()}`, () => fetcher(hash), (r) => isFinal(r.blockNumber));
  }

  function cachedTokenMetaPersistent(address: string, fetcher: (address: string) => Promise<TokenMeta>): Promise<TokenMeta> {
    return cachedTokenMeta(address, (a) => cachedPoint(`tokenmeta:${a.toLowerCase()}`, () => fetcher(a), () => true));
  }

  function cachedLogRange<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    key: string, from: bigint, to: bigint, fetchRange: (from: bigint, to: bigint) => Promise<L[]>,
  ): Promise<L[]> {
    return cachedByKey(`${NS}:range:${key}:${from}:${to}`, async () => {
      const store = await getStore();
      const storeKey = `${NS}:${key}`;
      const cached = await store.get<RangeRecord<L>>("ranges", storeKey);
      const plan = planRangeFetch(cached, from, to);
      if (plan.kind === "hit") return upTo(cached!.logs, to);

      const fetched = await fetchRange(plan.from, plan.to);
      const logs = plan.kind === "extend" ? mergeLogs(cached!.logs, fetched) : mergeLogs([], fetched);
      writeRange(store, storeKey, cached?.to ?? null, from, to, logs);
      return logs;
    });
  }

  function writeRange<L extends { blockNumber: bigint | null }>(
    store: PersistentStore, storeKey: string, cachedTo: bigint | null, from: bigint, to: bigint, logs: readonly L[],
  ): void {
    const persistTo = nextPersistTo(cachedTo, from, to, REORG_DEPTH);
    if (persistTo === null) return;
    void store.put("ranges", storeKey, { from, to: persistTo, logs: upTo(logs, persistTo) });
  }

  async function cachedLogsById<L extends { blockNumber: bigint | null; logIndex: number | null }>(
    keyPrefix: string, ids: readonly bigint[], from: bigint, to: bigint,
    fetchIds: (ids: bigint[], from: bigint, to: bigint) => Promise<L[]>, idOf: (log: L) => bigint,
  ): Promise<Map<bigint, L[]>> {
    const out = new Map<bigint, L[]>();
    if (!ids.length) return out;

    const store = await getStore();
    const keyFor = (id: bigint) => `${NS}:${keyPrefix}:${id}`;
    const records = await store.getMany<RangeRecord<L>>("ranges", ids.map(keyFor));

    const cachedOf = new Map<bigint, RangeRecord<L> | undefined>();
    ids.forEach((id, i) => {
      const rec = records[i];
      cachedOf.set(id, rec && rec.from === from ? rec : undefined);
    });

    const buckets = groupByCachedTo(ids.map((id) => ({ id, to: cachedOf.get(id)?.to ?? null })));
    const fetchedOf = new Map<bigint, L[]>();
    for (const id of ids) fetchedOf.set(id, []);

    await Promise.all([...buckets.values()].map(async ({ to: cachedTo, ids: bucketIds }) => {
      const fetchFrom = cachedTo === null ? from : cachedTo + 1n;
      if (fetchFrom > to) return;
      for (const log of await fetchIds(bucketIds, fetchFrom, to)) {
        fetchedOf.get(idOf(log))?.push(log);
      }
    }));

    const writes: { key: string; value: unknown }[] = [];
    for (const id of ids) {
      const cached = cachedOf.get(id);
      const fetched = fetchedOf.get(id)!;
      const merged = mergeLogs(cached?.logs ?? [], fetched);
      out.set(id, upTo(merged, to));
      const persistTo = nextPersistTo(cached?.to ?? null, from, to, REORG_DEPTH);
      const unchanged = cached && !fetched.length && persistTo === cached.to;
      if (persistTo !== null && !unchanged) {
        writes.push({ key: keyFor(id), value: { from, to: persistTo, logs: upTo(merged, persistTo) } });
      }
    }
    void store.putMany("ranges", writes);
    return out;
  }

  /**
   * Forget everything, in memory and on disk, so the next scan reads the chain from
   * scratch. Wired to the UI's "Rescan from chain".
   *
   * NOTE: `store.clear()` clears the WHOLE underlying IndexedDB store — both chains'
   * instances share one physical database (there is no per-namespace clear in idb.ts).
   * Calling this on either chain's instance wipes BOTH chains' on-disk caches. This
   * matches the button's existing "forget everything, start clean" semantics and is left
   * as-is deliberately: a selective per-chain clear is unneeded precision for a rare,
   * user-initiated, already-destructive action.
   */
  async function resetCaches(): Promise<void> {
    clearPromiseCache();
    clearTokenMetaCache();
    await (await getStore()).clear();
  }

  function resetHead(): void {
    observedHead = 0n;
  }

  return {
    noteHead, isFinal, cachedPoint, cachedBlockTimestamp, cachedReceipt,
    cachedTokenMetaPersistent, cachedLogRange, cachedLogsById, resetCaches, resetHead,
  };
}
```

Note the `cachedByKey`/in-scan promise-cache keys are now prefixed with `NS` too (`${NS}:point:${key}` / `${NS}:range:...`) — the ORIGINAL code did not need this because there was only ever one chain's worth of in-flight promises; now two chain instances share the same underlying `promise-cache.ts` module-level map, so their in-scan keys must not collide even though their on-disk `store` keys already don't.

- [ ] **Step 3: Update `chain-cache.test.ts`**

Read the current file first: `web/src/lib/chain-cache.test.ts` — update every call site that used the old free-function exports (`noteHead`, `isFinal`, `cachedPoint`, `cachedLogRange`, `cachedLogsById`, `resetHead`, `resetCaches`) to instead call `createChainCache(ROBINHOOD_CHAIN)` once at the top of the file and use the returned instance's methods, e.g.:

```ts
import { createChainCache } from "./chain-cache";
import { ROBINHOOD_CHAIN, ARC_CHAIN } from "./uniswap-v3-pnl";

const cache = createChainCache(ROBINHOOD_CHAIN);
// ... replace bare `noteHead(...)` with `cache.noteHead(...)`, `isFinal(...)` with `cache.isFinal(...)`, etc., throughout the file.
```

Then append a new isolation test proving the bug this factory conversion fixes, right before the final pass/fail summary:

```ts
// ---------------------------------------------------------------------------
// Two chains in the same page must not share a reorg-finality clock. Before
// this factory conversion, `observedHead` was one module-level variable: a
// Robinhood scan (large block numbers) would make every Arc block look
// "final" immediately, because Arc's small block numbers are always far
// behind Robinhood's huge observedHead.
// ---------------------------------------------------------------------------
{
  const rh = createChainCache(ROBINHOOD_CHAIN);
  const arc = createChainCache(ARC_CHAIN);
  rh.noteHead(50_000_000n); // a plausible Robinhood head
  eq("arc block is NOT final under robinhood's head (different instance)", arc.isFinal(100n), false);
  arc.noteHead(1_000n);
  eq("arc block IS final under its own head + REORG_DEPTH", arc.isFinal(100n), true);
  eq("robinhood's head is unaffected by arc's noteHead", rh.isFinal(50_000_000n - 512n), true);
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/chain-cache.test.ts`
Expected: every line `PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chain-cache.ts web/src/lib/chain-cache.test.ts
git commit -m "refactor(arc): convert chain-cache.ts to a per-chain factory"
```

---

## Task 4: Per-chain upstream routing in the `/rpc` edge function

**Files:**
- Create: `web/netlify/lib/chain-upstreams.ts` (new — pure, testable decision logic)
- Create: `web/netlify/lib/chain-upstreams.test.ts` (new)
- Modify: `web/netlify/edge-functions/rpc.ts`
- Modify: `.env.example` or equivalent Netlify env documentation, if one exists in this repo (check `web/README.md` / root `README.md` for an env var list and add the Arc ones there too)

`orderUpstreams` (`lane-order.ts`) itself needs NO change — it already takes plain `{ publicRpc, paidRpc, walletRpc, lane }` and has no idea which chain those URLs belong to. The NEW chain-awareness (which env vars to read for which chain, and the "not configured" sentinel) is its own pure decision, and per this repo's own established rule — "Netlify deploys every top-level file in `netlify/edge-functions/` AS its own edge function... shared code and its tests belong outside that directory" (see `lane-order.ts`'s header comment) — it must live in `netlify/lib/`, not inline in `rpc.ts`, so it can be unit-tested at all. This is exactly the same reasoning that put `orderUpstreams` there instead of inline in `rpc.ts` originally.

- [ ] **Step 1: Write the failing test first**

Create `web/netlify/lib/chain-upstreams.test.ts`:

```ts
import { resolveChainUpstreams } from "./chain-upstreams";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ROBINHOOD_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";

// Robinhood (chain absent or anything other than "arc"): unchanged behavior, own env vars, has a default.
eq(
  "robinhood, no chain param, no env set → falls back to the hardcoded default",
  resolveChainUpstreams(null, {}, null, ROBINHOOD_DEFAULT),
  [{ url: ROBINHOOD_DEFAULT, label: "public" }],
);
eq(
  "robinhood, PUBLIC_RPC_URL set → used instead of the default",
  resolveChainUpstreams(null, { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://public.example", label: "public" }],
);
eq(
  "robinhood wallet lane → wallet endpoint first",
  resolveChainUpstreams(null, { PUBLIC_RPC_URL: "https://public.example", WALLET_RPC_URL: "https://wallet.example" }, "wallet", ROBINHOOD_DEFAULT),
  [{ url: "https://wallet.example", label: "wallet" }, { url: "https://public.example", label: "public" }],
);
eq(
  "an unrecognized chain param behaves exactly like no chain param (robinhood)",
  resolveChainUpstreams("nonsense", { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://public.example", label: "public" }],
);

// Arc: separate env vars, NO default — unset means "not configured", not a guess.
eq(
  "arc, ARC_RPC_URL unset → not configured (null), regardless of Robinhood's env or default",
  resolveChainUpstreams("arc", { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  null,
);
eq(
  "arc, ARC_RPC_URL set → used, own var name",
  resolveChainUpstreams("arc", { ARC_RPC_URL: "https://arc-public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://arc-public.example", label: "public" }],
);
eq(
  "arc wallet lane uses ARC_WALLET_RPC_URL, not Robinhood's WALLET_RPC_URL",
  resolveChainUpstreams(
    "arc",
    { ARC_RPC_URL: "https://arc-public.example", ARC_WALLET_RPC_URL: "https://arc-wallet.example", WALLET_RPC_URL: "https://robinhood-wallet.example" },
    "wallet",
    ROBINHOOD_DEFAULT,
  ),
  [{ url: "https://arc-wallet.example", label: "wallet" }, { url: "https://arc-public.example", label: "public" }],
);
eq(
  "arc paid spillover uses ARC_PAID_RPC_URL",
  resolveChainUpstreams("arc", { ARC_RPC_URL: "https://arc-public.example", ARC_PAID_RPC_URL: "https://arc-paid.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://arc-public.example", label: "public" }, { url: "https://arc-paid.example", label: "paid" }],
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it and confirm it fails (the module doesn't exist yet)**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/netlify/lib/chain-upstreams.test.ts`
Expected: fails to even start — "Cannot find module './chain-upstreams'".

- [ ] **Step 3: Write `chain-upstreams.ts`**

Create `web/netlify/lib/chain-upstreams.ts`:

```ts
/**
 * Which chain's env vars a /rpc request reads, and the "not configured" sentinel.
 *
 * Pure and framework-free so it can be unit-tested with a plain object standing in for
 * Netlify's env — see chain-upstreams.test.ts. Lives beside lane-order.ts (which decides
 * the ORDER once the URLs are known) for the same reason lane-order.ts isn't inline in
 * rpc.ts: a file in netlify/edge-functions/ is deployed as its own function, so shared
 * decision logic and its tests belong here instead.
 */
import { orderUpstreams, type Upstream } from "./lane-order";

export type EnvLookup = Record<string, string | undefined>;

/**
 * Robinhood (chain is null or anything other than "arc"): its EXACT existing env-var
 * names and default — zero behavior change for the live path.
 *
 * Arc: separate env vars, NO default. Arc mainnet opened 2026-09-16 and no scraped
 * public RPC URL is trustworthy enough to hardcode (see the design doc's "Background /
 * on-chain facts"). An unset ARC_RPC_URL returns `null` — the caller (rpc.ts) responds
 * with a distinct, recognizable error instead of guessing an endpoint.
 */
export function resolveChainUpstreams(
  chain: string | null,
  env: EnvLookup,
  lane: string | null,
  robinhoodDefaultPublicRpc: string,
): Upstream[] | null {
  if (chain === "arc") {
    const publicRpc = env.ARC_RPC_URL || "";
    if (!publicRpc) return null;
    return orderUpstreams({
      publicRpc,
      paidRpc: env.ARC_PAID_RPC_URL || "",
      walletRpc: env.ARC_WALLET_RPC_URL || "",
      lane,
    });
  }
  return orderUpstreams({
    publicRpc: env.PUBLIC_RPC_URL || robinhoodDefaultPublicRpc,
    paidRpc: env.PAID_RPC_URL || "",
    walletRpc: env.WALLET_RPC_URL || "",
    lane,
  });
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/netlify/lib/chain-upstreams.test.ts`
Expected: every line `PASS`, `8/8 passed`, exit code 0.

- [ ] **Step 5: Add it to the root `verify` script**

In root `package.json`, append `&& tsx web/netlify/lib/chain-upstreams.test.ts` to the `"verify"` script (alongside the `chain-config.test.ts` entry added in Task 1).

- [ ] **Step 6: Wire `resolveChainUpstreams` into `rpc.ts`**

In `web/netlify/edge-functions/rpc.ts`, replace the import line `import { orderUpstreams } from "../lib/lane-order.ts";` with `import { resolveChainUpstreams } from "../lib/chain-upstreams.ts";`, then replace the `upstreams` function:

```ts
function upstreams(lane: string | null): { url: string; label: string }[] {
  return orderUpstreams({
    publicRpc: Netlify.env.get("PUBLIC_RPC_URL") || DEFAULT_PUBLIC_RPC,
    paidRpc: Netlify.env.get("PAID_RPC_URL") || "",
    walletRpc: Netlify.env.get("WALLET_RPC_URL") || "",
    lane,
  });
}
```

with a thin adapter that reads Netlify's env into a plain object and delegates:

```ts
function upstreams(lane: string | null, chain: string | null): { url: string; label: string }[] | null {
  const env = {
    PUBLIC_RPC_URL: Netlify.env.get("PUBLIC_RPC_URL"),
    PAID_RPC_URL: Netlify.env.get("PAID_RPC_URL"),
    WALLET_RPC_URL: Netlify.env.get("WALLET_RPC_URL"),
    ARC_RPC_URL: Netlify.env.get("ARC_RPC_URL"),
    ARC_PAID_RPC_URL: Netlify.env.get("ARC_PAID_RPC_URL"),
    ARC_WALLET_RPC_URL: Netlify.env.get("ARC_WALLET_RPC_URL"),
  };
  return resolveChainUpstreams(chain, env, lane, DEFAULT_PUBLIC_RPC);
}
```

- [ ] **Step 7: Read the `chain` param and handle the "not configured" case in the handler**

In the same file, change:

```ts
  const lane = new URL(req.url).searchParams.get("lane");
  const chain = upstreams(lane);
  const ms = timeoutMs();
  let lastStatus = 502;

  for (let i = 0; i < chain.length; i++) {
    const { url, label } = chain[i];
```

to:

```ts
  const url = new URL(req.url);
  const lane = url.searchParams.get("lane");
  const chainParam = url.searchParams.get("chain");
  const chainUpstreams = upstreams(lane, chainParam);
  if (chainUpstreams === null) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${chainParam} chain not configured` } }),
      { status: 501, headers: JSON_HEADERS },
    );
  }
  const ms = timeoutMs();
  let lastStatus = 502;

  for (let i = 0; i < chainUpstreams.length; i++) {
    const { url, label } = chainUpstreams[i];
```

Note this second block shadows the outer `url` binding (the request URL) with the loop's per-upstream `url` — same as the ORIGINAL code already did (it also named the loop variable `url` inside a block that had an outer `chain`/`url`-shaped variable); to avoid confusion, also rename the FIRST `const url = new URL(req.url);` above to `const reqUrl = new URL(req.url);` and update its two `.searchParams.get(...)` call sites accordingly. Final shape:

```ts
  const reqUrl = new URL(req.url);
  const lane = reqUrl.searchParams.get("lane");
  const chainParam = reqUrl.searchParams.get("chain");
  const chainUpstreams = upstreams(lane, chainParam);
  if (chainUpstreams === null) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${chainParam} chain not configured` } }),
      { status: 501, headers: JSON_HEADERS },
    );
  }
  const ms = timeoutMs();
  let lastStatus = 502;

  for (let i = 0; i < chainUpstreams.length; i++) {
    const { url, label } = chainUpstreams[i];
    const isLast = i === chainUpstreams.length - 1;
    // ... rest of the loop body is UNCHANGED — it already refers only to `url`/`label`/`isLast`/`chain.length` via `isLast`, which is now `i === chainUpstreams.length - 1` (already shown above).
```

Everywhere else inside the loop body that referenced the old variable name `chain` (e.g., any `chain.length` inside the loop) must become `chainUpstreams.length` — there is exactly one such reference (the `isLast` computation shown above); the rest of the loop body (`fetch`, spill-check, response construction) is untouched.

- [ ] **Step 8: Update the module doc comment's env var list**

At the top of `rpc.ts`, extend the `// Env (set on the Netlify project):` comment block to also document:

```
 *   ARC_RPC_URL      — Arc public/free RPC. NO DEFAULT — an unset value returns a
 *                      distinct "not configured" error rather than guessing an endpoint.
 *   ARC_PAID_RPC_URL — Arc paid RPC incl. API key (optional; spillover only)
 *   ARC_WALLET_RPC_URL — Arc RPC for wallet scans incl. API key (optional)
```

- [ ] **Step 9: Confirm `lane-order.test.ts` is unaffected**

No change needed — `orderUpstreams` itself is untested-by-this-change (its signature and behavior are identical; `chain-upstreams.ts` calls it exactly as `rpc.ts` used to). Confirm by running it:

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/netlify/lib/lane-order.test.ts`
Expected: unchanged pass count, exit code 0.

- [ ] **Step 10: Manual verification of the edge function itself**

`rpc.ts` still has no colocated unit test (it's now a thin HTTP handler over `resolveChainUpstreams`/`spillReason`, both unit-tested elsewhere). Verify by inspection: re-read the edited file and confirm (a) Robinhood's code path is byte-identical to before when the `chain` param is absent or anything other than `"arc"`, and (b) an Arc request with `ARC_RPC_URL` unset returns HTTP 501 with the `-32001` body instead of throwing or falling back to a default.

- [ ] **Step 11: Commit**

```bash
git add web/netlify/edge-functions/rpc.ts web/netlify/lib/chain-upstreams.ts web/netlify/lib/chain-upstreams.test.ts package.json
git commit -m "feat(arc): route /rpc per-chain, with no default Arc RPC URL"
```

---

## Task 5: `PositionPnL` gains `gasKind`; wire it through both engines

**Files:**
- Modify: `web/src/lib/chain.ts:327-360` (the `PositionPnL` interface) — see Task 6 for the rest of chain.ts
- Modify: `web/src/lib/chain-v4.ts:726-732` (the `computePositionPnLV4` return statement) — see Task 7 for the rest of chain-v4.ts

This task is folded into Tasks 6 and 7 below (both files are being rewritten there anyway) — listed here separately only so the `gasKind` field is easy to find in review. In `PositionPnL`, add:

```ts
  gasKind: NumeraireKind; // what unit `gasEth` is actually in — "eth" on Robinhood, "usd" on Arc. See numeraire.ts's gasInNumeraire.
```

right after the existing `gasEth: number;` field, and every place that CONSTRUCTS a `PositionPnL` (the `return { ... }` in `computePositionPnL` in chain.ts, and in `computePositionPnLV4` in chain-v4.ts) sets `gasKind: chain.gasIsUsdAnchor ? "usd" : "eth"`.

---

## Task 6: Convert `chain.ts` into a per-chain factory (`createChainClient`)

This is the largest task. **Read the current file in full before starting** (`web/src/lib/chain.ts`, 824 lines) — this task describes precise edits against that content, not a full rewrite, because ~95% of the file's logic (rate limiting, retry backoff, tick fallback ordering, batching) is untouched; only what each identifier resolves to changes.

**Why a factory:** `client`, `NPM`, `FACTORY`, `POSM_V4`, `WETH_ADDR`, `USDG_ADDR`, `EXPLORER`, and the rate-limit state (`inflight`, `waiting`, `rateLimitGate`) are all module-level singletons today, permanently bound to `ROBINHOOD_CHAIN`. Two live chains in one page need two independent copies of every one of these — a shared `rateLimitGate`, in particular, would throttle Arc requests because Robinhood's endpoint is busy (or vice versa), which is nonsensical across two different RPC providers.

**Files:**
- Modify: `web/src/lib/chain.ts` (whole file — restructured into a factory)
- No test file changes here — `chain.ts` has no colocated `.test.ts` (it's exercised by `web/src/lib/wallet-analyze.smoke.ts`, a live-RPC smoke script, and manually via the UI). Verification for this task is Step 4 below plus the full `npm run verify` regression run in Task 10.

- [ ] **Step 1: New imports**

At the top of `web/src/lib/chain.ts`, change:

```ts
import {
  computePnL, closedExitPrice, buildImpliedPriceFeed, exitTxHash, amountsFromLiquidity,
  isPriceableTick, priceAtTick, pricingTick, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";
import { pickNumeraire, numerairePricePoint, totalsByNumeraire, type NumeraireKind, type PortfolioTotals } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { createRateLimitGate, rateLimitWaitMs } from "./rate-limit";
import { laned, laneUrl } from "./rpc-lane";
import { ownershipOf, heldAt, type NftTransfer } from "./ownership";
import { chunkIds } from "./transfers";
import { mapPool } from "./pool";
import {
  cachedBlockTimestamp, cachedLogRange, cachedLogsById, cachedReceipt,
  cachedTokenMetaPersistent, noteHead,
} from "./chain-cache";
import { computePositionPnLV4 } from "./chain-v4";
import type { PoolRef } from "./volume";
```

to:

```ts
import {
  computePnL, closedExitPrice, buildImpliedPriceFeed, exitTxHash, amountsFromLiquidity,
  isPriceableTick, priceAtTick, pricingTick,
  type ChainConfig, type LiquidityEvent, type PairMeta, type PriceFeed, type PnLResult, type ExitPriceBasis,
} from "./uniswap-v3-pnl";
import { pickNumeraire, numerairePricePoint, totalsByNumeraire, type NumeraireKind, type PortfolioTotals } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { createRateLimitGate, rateLimitWaitMs } from "./rate-limit";
import { laned, laneUrl } from "./rpc-lane";
import { ownershipOf, heldAt, type NftTransfer } from "./ownership";
import { chunkIds } from "./transfers";
import { mapPool } from "./pool";
import { createChainCache, type ChainCache } from "./chain-cache";
import { createV4Client, type SharedPlumbing } from "./chain-v4";
import type { PoolRef } from "./volume";
```

- [ ] **Step 2: Keep pure/type-only declarations at module level**

These stay exactly where they are, UNCHANGED, at module level (outside any factory): the JSDoc-only comments, `export type { NumeraireKind };`, the `OwnerContext` interface (lines ~306-325 — its `lifecycle`/`transfers` field types are unaffected), the `PositionPnL` interface (add `gasKind` per Task 5), the `Portfolio` interface, and the `LifecycleLogs` type alias. These are compile-time-only or plain data shapes; they don't close over any chain-specific runtime value.

- [ ] **Step 3: Wrap everything else in `createChainClient`**

Everything from the `// RPC endpoint.` comment (currently right after the imports) through the end of the file's `analyze` function becomes the BODY of a new exported factory function. Concretely:

Immediately after the imports (Step 1) and before the `// RPC endpoint.` comment, insert:

```ts
export interface ChainClient {
  analyze(input: string, onProgress?: (d: number, t: number) => void): Promise<Portfolio>;
  poolRefsFor(positions: PositionPnL[]): Promise<PoolRef[]>;
  /** Present only for a chain with an ETH leg (Robinhood). Arc has none — see ChainConfig.tokens.ethAnchors. */
  fetchEthUsd?(): Promise<number | null>;
  resetCaches(): Promise<void>;
  explorerUrl: string | null;
}

export function createChainClient(chain: ChainConfig): ChainClient {
  const cache = createChainCache(chain);
```

Then, for every line from the original `// RPC endpoint.` comment through the original `export async function analyze(...) { ... }` closing brace:
1. **Remove every `export` keyword** from what is now a nested declaration (`export function` → `function`, `export const` → `const`, `export async function` → `async function`). This applies to: `robinhoodChain` (rename to `viemChain`, see Step 3a), `client`, `retry`, `EXPLORER` (removed entirely, see Step 3b), `blockTimestamp`, `receiptOf`, `fetchEthUsd`, `computePositionPnL`, `ownershipLogs`, `toNftTransfer`, `analyzeTx`, `analyzeWallet`, `analyzeWalletV4Positions`, `poolRefsFor`, `analyze`. (Everything else in the original file — `MAX_INFLIGHT`, `POSITION_CONCURRENCY`, `acquireSlot`, `releaseSlot`, `rateLimitGate`, `RATE_LIMIT_ATTEMPTS`, `throttle`, `LANE_URL`, `NPM`, `FACTORY`, `POSM_V4`, event/function ABI parsers, `readTokenMeta`, `sqrtToPrice`, `WETH_ADDR`, `USDG_ADDR`, `lifecycleQuery`, `prefetchLifecycle`, `tokenIdOf`, `batchByTokenId`, `fetchLifecycle`, `prefetchTransfers`, `restrictToOwner` — were never `export`ed, so nothing changes there.)
2. Replace every reference to `ROBINHOOD_CHAIN` with `chain`.
3. Replace every bare call to `cachedBlockTimestamp(`, `cachedLogRange(`, `cachedLogsById(`, `cachedReceipt(`, `cachedTokenMetaPersistent(`, `noteHead(` with `cache.cachedBlockTimestamp(`, `cache.cachedLogRange(`, `cache.cachedLogsById(`, `cache.cachedReceipt(`, `cache.cachedTokenMetaPersistent(`, `cache.noteHead(` respectively (there are roughly a dozen call sites across `blockTimestamp`, `receiptOf`, `analyzeWallet`, `analyzeWalletV4Positions`, `prefetchLifecycle`, `ownershipLogs`).
4. Replace the single call to `computePositionPnLV4(` inside `analyzeWallet`/`analyzeTx` with `v4.computePositionPnLV4(` (the `v4` binding is created in Step 3c below).

- [ ] **Step 3a: RPC endpoint construction — chain-aware URL**

Replace the original:

```ts
const VITE_RPC = (import.meta.env && import.meta.env.VITE_RPC_URL) || "";
const NODE_RPC =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RPC_URL ||
  ROBINHOOD_CHAIN.rpcUrl;
const RPC_URL =
  VITE_RPC ||
  (typeof window !== "undefined" ? new URL("/rpc", window.location.origin).toString() : NODE_RPC);

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.chainId,
  name: "Robinhood Chain",
  nativeCurrency: ROBINHOOD_CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_CHAIN.explorer } },
});
```

with (now inside the factory, using `chain`):

```ts
  const VITE_RPC = (import.meta.env && import.meta.env.VITE_RPC_URL) || "";
  const NODE_RPC =
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RPC_URL ||
    chain.rpcUrl;
  // Robinhood's rpcChainSlug is "" → base path is exactly "/rpc", byte-identical to
  // today's URL. Arc's is "arc" → "/rpc?chain=arc"; laneUrl() below adds "&lane=wallet"
  // on top of that via searchParams.set, which does not disturb the chain param.
  const proxyPath = chain.rpcChainSlug ? `/rpc?chain=${chain.rpcChainSlug}` : "/rpc";
  const RPC_URL =
    VITE_RPC ||
    (typeof window !== "undefined" ? new URL(proxyPath, window.location.origin).toString() : NODE_RPC);

  const viemChain = defineChain({
    id: chain.chainId,
    name: chain.chainId === 4663 ? "Robinhood Chain" : "Arc",
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [RPC_URL] } },
    blockExplorers: chain.explorerUrl
      ? { default: { name: "Explorer", url: chain.explorerUrl } }
      : undefined,
  });
```

- [ ] **Step 3b: `EXPLORER` becomes part of the returned object, not a module export**

Delete the line `export const EXPLORER = ROBINHOOD_CHAIN.explorer;` entirely — it is replaced by the `explorerUrl: chain.explorerUrl` field in the object `createChainClient` returns (Step 4).

- [ ] **Step 3c: address consts — safe for a chain with no v3, and wired to the v4 sub-client**

Replace:

```ts
const NPM = getAddress(ROBINHOOD_CHAIN.uniswapV3.nonfungiblePositionManager);
const FACTORY = getAddress(ROBINHOOD_CHAIN.uniswapV3.factory);
const POSM_V4 = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
```

with:

```ts
  // NPM/FACTORY are only meaningful when chain.uniswapV3 is set (Robinhood). On a v3-less
  // chain (Arc) they resolve to the zero address and are simply never reached: analyzeWallet
  // skips v3 enumeration entirely when chain.uniswapV3 is null (Step 3f), and no v4 event
  // log can ever match the zero address, so this is inert rather than special-cased.
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
  const NPM = chain.uniswapV3 ? getAddress(chain.uniswapV3.nonfungiblePositionManager) : ZERO_ADDRESS;
  const FACTORY = chain.uniswapV3 ? getAddress(chain.uniswapV3.factory) : ZERO_ADDRESS;
  const POSM_V4 = getAddress(chain.uniswapV4.positionManager);
```

Also move the `throttle`/rate-limit block (`MAX_INFLIGHT` through `throttle(...)`) and the `client`/`LANE_URL` construction to AFTER this point (they already came after `POSM_V4` originally except for `client` itself, which came right after `LANE_URL` — preserve that relative order, just now all inside the factory and referencing `viemChain` instead of `robinhoodChain`):

```ts
  export const client = createPublicClient({ chain: robinhoodChain, ... })
```
becomes
```ts
  const client = createPublicClient({ chain: viemChain, ... });
```
(drop `export`, rename `robinhoodChain` → `viemChain`; the rest of that block — `MAX_INFLIGHT`, `POSITION_CONCURRENCY`, `inflight`, `waiting`, `acquireSlot`, `releaseSlot`, `rateLimitGate`, `RATE_LIMIT_ATTEMPTS`, `throttle`, `LANE_URL = laneUrl(RPC_URL)` — is copied VERBATIM, unchanged, just now inside the factory so each chain gets its own independent rate limiter and concurrency counters, which is the whole point of this task).

- [ ] **Step 3d: `WETH_ADDR`/`USDG_ADDR` — chain-scoped, with a safe fallback for chains without an ETH leg**

Replace:

```ts
const WETH_ADDR = getAddress(ROBINHOOD_CHAIN.tokens.WETH);
const USDG_ADDR = getAddress(ROBINHOOD_CHAIN.tokens.USDG);
```

with:

```ts
  // fetchEthUsd is only ever called for a chain with an ETH leg (see the ChainClient
  // interface's optional fetchEthUsd, and App.tsx which never calls it for Arc). These
  // constants still need SOME value to construct without throwing on a chain with no
  // ethAnchors at all — ZERO_ADDRESS is inert there, same reasoning as NPM/FACTORY above.
  const WETH_ADDR = getAddress(chain.tokens.ethAnchors[0] ?? ZERO_ADDRESS);
  const USDG_ADDR = getAddress(chain.tokens.usdAnchors[0] ?? ZERO_ADDRESS);
```

And inside `fetchEthUsd`'s body, replace the two references to `ROBINHOOD_CHAIN.tokens.USDG_DECIMALS` with `chain.tokens.usdDecimals`.

- [ ] **Step 3e: wire in the v4 sub-client**

Immediately after `client`/`LANE_URL` are defined (Step 3c) and before `retry`/`blockTimestamp`/`receiptOf` are defined, insert:

```ts
  const shared: SharedPlumbing = { client, blockTimestamp, receiptOf, retry, ownershipLogs, toNftTransfer };
  const v4 = createV4Client(chain, cache, shared);
```

This line must come AFTER `retry`, `blockTimestamp`, `receiptOf`, `ownershipLogs`, and `toNftTransfer` are all defined (they are all defined in sequence further down in the original file, in that relative order already) — so in practice, move this `shared`/`v4` construction to sit right before `computePositionPnL` is defined (i.e., after `toNftTransfer`'s definition, before `restrictToOwner`/`computePositionPnL`). `SharedPlumbing` is a new exported type from `chain-v4.ts` — see Task 7, Step 1.

- [ ] **Step 3f: gate v3 wallet-enumeration on `chain.uniswapV3`**

In `analyzeWallet`, replace:

```ts
  const v3Logs = await cachedLogRange(
    `v3:owned:${wallet.toLowerCase()}`, 0n, head,
    (from, to) => getLogsChunked(
      (f, t) => client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: f, toBlock: t }),
      from, to,
    ),
  );
  const v3Ids = [...new Set(v3Logs.map((l) => (l.args as { tokenId: bigint }).tokenId))];
```

with:

```ts
  const v3Ids: bigint[] = chain.uniswapV3
    ? [...new Set((await cache.cachedLogRange(
        `v3:owned:${wallet.toLowerCase()}`, 0n, head,
        (from, to) => getLogsChunked(
          (f, t) => client.getLogs({ address: NPM, event: evTransfer, args: { to: getAddress(wallet) }, fromBlock: f, toBlock: t }),
          from, to,
        ),
      )).map((l) => (l.args as { tokenId: bigint }).tokenId))]
    : [];
```

(This SKIPS the network round trip entirely for Arc, rather than issuing a query against `NPM = ZERO_ADDRESS` that would harmlessly return nothing but still cost a request and a cache key.)

- [ ] **Step 4: the factory's return statement**

At the very end of the file, immediately after the (now-unexported) `analyze` function's closing brace, add:

```ts
  return {
    analyze,
    poolRefsFor,
    fetchEthUsd: chain.tokens.ethAnchors.length > 0 ? fetchEthUsd : undefined,
    resetCaches: cache.resetCaches,
    explorerUrl: chain.explorerUrl,
  };
}
```

(That final `}` closes the `createChainClient` function opened in Step 3.)

- [ ] **Step 5: `computePositionPnL`'s `gasKind` field (Task 5)**

In `computePositionPnL`'s return statement (the `return { tokenId, version: "v3", ... }` line), add `gasKind: chain.gasIsUsdAnchor ? "usd" : "eth",` alongside the existing `gasEth,` field.

- [ ] **Step 6: typecheck**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl/web && npx tsc --noEmit`
Expected: no errors referencing `chain.ts`. (Errors in `chain-v4.ts`/`App.tsx` are expected at this point — those are fixed in Tasks 7 and 9. If `chain.ts` itself has errors, they are almost always a missed `ROBINHOOD_CHAIN` → `chain` substitution or a missed `cache.` prefix — grep the file for both strings to confirm none remain: `grep -n "ROBINHOOD_CHAIN\|[^.]cachedBlockTimestamp\|[^.]cachedLogRange\|[^.]cachedLogsById\|[^.]cachedReceipt\|[^.]cachedTokenMetaPersistent\|[^.]noteHead" web/src/lib/chain.ts` should return nothing.)

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/chain.ts
git commit -m "refactor(arc): convert chain.ts into createChainClient(chain) factory"
```

(This commit will not build cleanly on its own — `chain-v4.ts` and `App.tsx` haven't been updated yet. That's expected; Tasks 7 and 9 land next. If your workflow requires every commit to build, squash Tasks 6–9 into one commit instead — call this out to the user before doing so, since it changes the git history shape from what this plan assumes.)

---

## Task 7: Convert `chain-v4.ts` into a per-chain factory (`createV4Client`)

**Files:**
- Modify: `web/src/lib/chain-v4.ts` (whole file)

Same rationale as Task 6: `POSM`, `PM`, `SV`, `NATIVE`, and the module-level `explorerGate` are all Robinhood-only singletons today.

- [ ] **Step 1: New imports and the `SharedPlumbing` type**

Replace:

```ts
import { parseAbiItem, getAddress, toHex, decodeEventLog, type Address } from "viem";
import {
  blockTimestamp, client, ownershipLogs, receiptOf, retry, toNftTransfer,
  type PositionPnL, type OwnerContext,
} from "./chain";
import { ownershipOf, heldAt } from "./ownership";
import { cachedLogRange, cachedPoint, cachedTokenMetaPersistent, isFinal } from "./chain-cache";
import { cachedByKey } from "./promise-cache";
import { tokenBucket } from "./token-bucket";
import {
  computePnL, amountsFromLiquidity, exitTxHash, isPriceableTick, ROBINHOOD_CHAIN,
  type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { isPermanentReadFailure } from "./read-failure";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlockOrNull, tickFromAmounts, nativeFlowForOwner, resolvePriceTicks,
  reconcileRemovalTicks,
  feesFromGrowth,
  nativeFlowWithoutTrace,
  type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
  type ActualReceivedByTx, type TraceCall,
} from "./v4-decode";
```

with:

```ts
import { parseAbiItem, getAddress, toHex, decodeEventLog, type Address, type PublicClient } from "viem";
import { type PositionPnL, type OwnerContext } from "./chain";
import { ownershipOf, heldAt } from "./ownership";
import type { ChainCache } from "./chain-cache";
import { cachedByKey } from "./promise-cache";
import { tokenBucket } from "./token-bucket";
import {
  computePnL, amountsFromLiquidity, exitTxHash, isPriceableTick,
  type ChainConfig, type LiquidityEvent, type PairMeta, type PriceFeed,
} from "./uniswap-v3-pnl";
import { pickNumeraire } from "./numeraire";
import { getLogsChunked } from "./rpc-logs";
import { isPermanentReadFailure } from "./read-failure";
import {
  computeV4PoolId, unpackPositionInfo, buildV4Events, buildV4PriceFeed,
  tickToPrice, tickAtBlockOrNull, tickFromAmounts, nativeFlowForOwner, resolvePriceTicks,
  reconcileRemovalTicks,
  feesFromGrowth,
  nativeFlowWithoutTrace,
  type V4RawEvent, type BlockState, type PoolKey, type V4SwapPoint,
  type ActualReceivedByTx, type TraceCall,
} from "./v4-decode";

/**
 * The pieces of chain.ts's factory a v4 client needs, passed explicitly instead of
 * imported — chain-v4.ts is built INSIDE chain.ts's factory (see chain.ts Task 6, Step
 * 3e), so a module-level import here would be circular at runtime.
 */
export interface SharedPlumbing {
  client: PublicClient;
  blockTimestamp(blockNumber: bigint): Promise<number>;
  receiptOf(hash: string): ReturnType<PublicClient["getTransactionReceipt"]>;
  retry<T>(fn: () => Promise<T>, attempts?: number, retryable?: (e: unknown) => boolean): Promise<T>;
  // Typed concretely to what chain-v4.ts actually does with the result (`.get(tokenId)`
  // on a batch lookup) rather than re-derived structurally from ownership.ts — chain-v4.ts
  // only ever calls this as `shared.ownershipLogs(POSM, [tokenId], head)`.
  ownershipLogs(contract: Address, ids: readonly bigint[], head: bigint): Promise<Map<bigint, { blockNumber: bigint | null; logIndex: number | null; args: unknown }[]>>;
  toNftTransfer(l: { blockNumber: bigint | null; logIndex: number | null; args: unknown }): import("./ownership").NftTransfer;
}
```

- [ ] **Step 2: Wrap the whole file body in `createV4Client`**

Immediately after the imports/`SharedPlumbing` type, replace:

```ts
const POSM = getAddress(ROBINHOOD_CHAIN.uniswapV4.positionManager);
const PM = getAddress(ROBINHOOD_CHAIN.uniswapV4.poolManager);
const SV = getAddress(ROBINHOOD_CHAIN.uniswapV4.stateView);
const NATIVE = getAddress(ROBINHOOD_CHAIN.tokens.NATIVE_ETH);
```

with:

```ts
export interface V4Client {
  computePositionPnLV4(tokenId: bigint, mintBlock: bigint, ctx?: OwnerContext): Promise<PositionPnL>;
}

export function createV4Client(chain: ChainConfig, cache: ChainCache, shared: SharedPlumbing): V4Client {
  const { client, blockTimestamp, receiptOf, retry, ownershipLogs, toNftTransfer } = shared;
  const POSM = getAddress(chain.uniswapV4.positionManager);
  const PM = getAddress(chain.uniswapV4.poolManager);
  const SV = getAddress(chain.uniswapV4.stateView);
  // NATIVE is Robinhood's v4 native-ETH currency sentinel (address 0). Arc's v4 pools can
  // ALSO carry address 0 as a currency (native USDC there) — pickNumeraire below still
  // refuses it (Arc's ethAnchors is empty and its usdAnchors is only the ERC-20 predeploy),
  // so a native-currency Arc position correctly falls through as "unsupported pair" further
  // down, same as any chain. NATIVE itself is chain-agnostic (always the zero address) and
  // needs no per-chain value.
  const NATIVE = "0x0000000000000000000000000000000000000000" as const;
```

Then apply, to EVERY remaining line of the original file (from `const evErc20T = parseAbiItem(...)` through the end of `computePositionPnLV4`'s closing brace):
1. **Remove `export`** from `export class UnindexedTrace`, `export function setExplorerGate`, `export async function fetchTraceCalls`, `export async function computePositionPnLV4` (they become nested declarations; `UnindexedTrace` in particular needs a small extra step — see Step 3 below, since a class used only for `instanceof` checks inside `retry(...)` callbacks works fine as a local const-scoped class).
2. Replace every bare call to `cachedLogRange(`, `cachedPoint(`, `cachedTokenMetaPersistent(`, `isFinal(` with `cache.cachedLogRange(`, `cache.cachedPoint(`, `cache.cachedTokenMetaPersistent(`, `cache.isFinal(`.
3. Replace the reference to `ROBINHOOD_CHAIN.explorer` inside `fetchTraceCalls` with `chain.explorerInternalTxApi` (NOT `chain.explorerUrl` — see the split explained in Task 1). Since Arc's `explorerInternalTxApi` is `null`, `fetchTraceCalls` must guard against a null base rather than building a broken URL — see Step 4 below.
4. `explorerGate`/`setExplorerGate` stay as module-level (NOT per-chain) state: it is a rate limiter against Blockscout specifically, a Robinhood-only concern (Arc's `fetchTraceCalls` never runs — see Step 4), so there is nothing to duplicate per chain. Leave `let explorerGate: ExplorerGate = tokenBucket(...)` and `export function setExplorerGate(...)` at MODULE level, outside `createV4Client`, exactly as they are today (still exported, since `explorer-gate.test.ts` — check whether such a test exists and imports `setExplorerGate`; if so it must keep working unchanged).

- [ ] **Step 3: guard `fetchTraceCalls` against a chain with no internal-tx API**

Change the start of `fetchTraceCalls`:

```ts
export async function fetchTraceCalls(txHash: string): Promise<TraceCall[]> {
  const out: TraceCall[] = [];
  let query = "";
```

to:

```ts
  async function fetchTraceCalls(txHash: string): Promise<TraceCall[]> {
    if (!chain.explorerInternalTxApi) {
      // No Blockscout-shaped explorer on this chain (Arc). Every caller of this function
      // is downstream of a native-currency pair, and native currency is never a supported
      // Arc pair (see the NATIVE comment above) — so this is provably unreached for Arc,
      // not a silent no-op standing in for a real capability.
      throw new Error(`no internal-transaction API configured for chain ${chain.chainId}`);
    }
    const out: TraceCall[] = [];
    let query = "";
```

And inside the same function, change:

```ts
      res = await fetch(`${ROBINHOOD_CHAIN.explorer}/api/v2/transactions/${txHash}/internal-transactions${query}`);
```

to:

```ts
      res = await fetch(`${chain.explorerInternalTxApi}/api/v2/transactions/${txHash}/internal-transactions${query}`);
```

- [ ] **Step 4: `computePositionPnLV4`'s `gasKind` field (Task 5)**

In the final `return { ... }` of `computePositionPnLV4`, add `gasKind: chain.gasIsUsdAnchor ? "usd" : "eth",` alongside `gasEth,`.

- [ ] **Step 5: close the factory and export it**

After the original file's final closing brace (the end of `computePositionPnLV4`), add one more `}` to close `createV4Client`, then:

```ts
  return { computePositionPnLV4 };
}
```

- [ ] **Step 6: typecheck**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl/web && npx tsc --noEmit`
Expected: no errors referencing `chain-v4.ts`. Grep to confirm no stray references remain: `grep -n "ROBINHOOD_CHAIN\|[^.]cachedLogRange\|[^.]cachedPoint\|[^.]cachedTokenMetaPersistent\|[^.]isFinal(" web/src/lib/chain-v4.ts` should return nothing (note `isFinal(` deliberately excludes `cache.isFinal(`, hence the `[^.]` prefix — same trick as Task 6 Step 6).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/chain-v4.ts
git commit -m "refactor(arc): convert chain-v4.ts into createV4Client(chain, cache, shared) factory"
```

---

## Task 8: `v4-decode.test.ts` / other chain-v4 test files — confirm no breakage

`chain-v4.ts` has no direct colocated `.test.ts` importing its internals by name other than possibly `explorer-gate.test.ts` (via `setExplorerGate`, which stayed module-level and exported unchanged in Task 7 Step 2.4). `v4-decode.test.ts` tests `./v4-decode.ts`, a separate file this plan does not touch.

**Files:**
- Verify only: `web/src/lib/explorer-gate.test.ts`, `web/src/lib/v4-decode.test.ts`

- [ ] **Step 1: Confirm neither test file imports anything removed from `chain-v4.ts`**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && grep -n "from \"\./chain-v4\"" web/src/lib/*.test.ts web/src/lib/*.smoke.ts`
Expected: only `setExplorerGate` (if anything) is imported from `./chain-v4` by name — everything else (`computePositionPnLV4`, `fetchTraceCalls`, `UnindexedTrace`, `cachedTraceCalls`) is now private to the factory closure or no longer directly importable. If `wallet-analyze.smoke.ts` or `v4-groundtruth-fee.smoke.ts` import `computePositionPnLV4`/`cachedTraceCalls` directly, they must be updated to instead call `createChainClient(ROBINHOOD_CHAIN).analyze(...)` or build a `createV4Client(ROBINHOOD_CHAIN, createChainCache(ROBINHOOD_CHAIN), shared)` themselves — read each smoke file before editing to see exactly what it needs; these are live-RPC scripts, not part of `npm run verify`, so they are not required to pass in this task, but should not be left referencing a symbol that no longer exists.

- [ ] **Step 2: Run the affected unit test**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/explorer-gate.test.ts`
Expected: unchanged pass count, exit code 0.

- [ ] **Step 3: Commit (if any smoke-script fixes were needed)**

```bash
git add web/src/lib/*.smoke.ts
git commit -m "fix(arc): update smoke scripts for the chain.ts/chain-v4.ts factory conversion"
```

(Skip this commit if Step 1 found nothing to change.)

---

## Task 9: `volume.ts` — parameterize the GeckoTerminal base by chain slug

**Files:**
- Modify: `web/src/lib/volume.ts:421` and its `fetchPoolsVolume`/`fetchPoolDaily` call chain
- Modify: `web/src/components/SwapVolume.tsx` (prop addition)
- Modify: `web/src/lib/volume.test.ts` (check for a hardcoded `GT_BASE`-dependent assertion; adjust if present)

- [ ] **Step 1: Read the full `fetchPoolDaily`/`fetchPoolsVolume` call chain**

Read `web/src/lib/volume.ts` in full before editing — Step 2 below assumes the exact shape already seen (`GT_BASE` is used inside `fetchPoolDaily(pool: PoolRef)`, which is called by `fetchPoolsVolume`).

- [ ] **Step 2: Make the network slug a parameter, with an explicit "not available" short-circuit**

Replace:

```ts
const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/robinhood/pools";
```

with:

```ts
/** null slug (Arc, until GeckoTerminal lists it) means the caller must not fetch at all — see fetchPoolsVolume. */
function gtBase(slug: string): string {
  return `https://api.geckoterminal.com/api/v2/networks/${slug}/pools`;
}
```

Then in `fetchPoolDaily`, change its signature to accept the slug and use `gtBase(slug)` instead of `GT_BASE`:

```ts
async function fetchPoolDaily(pool: PoolRef, slug: string): Promise<PoolFetch> {
  const url = `${gtBase(slug)}/${pool.id}/ohlcv/day?aggregate=1&limit=365&currency=usd`;
  // ... unchanged body below
```

Find `fetchPoolsVolume`'s definition (the public entry point `SwapVolume.tsx` calls) and:
1. Add a `geckoTerminalSlug: string | null` parameter.
2. At the very top of the function body, before any fetch is attempted, add:

```ts
export async function fetchPoolsVolume(
  pools: PoolRef[],
  gran: Granularity,
  geckoTerminalSlug: string | null,
  onProgress?: (done: number, total: number) => void,
  onWait?: (ms: number) => void,
): Promise<PoolVolume> {
  if (geckoTerminalSlug === null) {
    // No confirmed GeckoTerminal listing for this chain (Arc, at design time) — every
    // pool is "missing" in the same sense the UI already uses for a provider that
    // genuinely doesn't index a pool, not a new state to design around.
    return { points: [], covered: [], missing: pools, failed: [], skipped: [], blocked: false, coverageStart: null };
  }
  // ... unchanged body, passing `geckoTerminalSlug` through to every fetchPoolDaily(pool, geckoTerminalSlug) call
}
```

Update every internal call to `fetchPoolDaily(pool)` within `fetchPoolsVolume`'s body to `fetchPoolDaily(pool, geckoTerminalSlug)`.

(Exact parameter name/position for `onProgress`/`onWait` above: keep them in whatever order the existing signature already uses — insert `geckoTerminalSlug` in the position shown only if it doesn't conflict; re-check the real signature when editing, since this description reconstructs it from the call site seen in `SwapVolume.tsx` — `fetchPoolsVolume(pools, gran, (done,total)=>..., (ms)=>...)` — meaning the real order is `(pools, gran, onProgress, onWait)`. Insert the new parameter as the 3rd positional argument, before `onProgress`, i.e. `(pools, gran, geckoTerminalSlug, onProgress, onWait)`, and update the call site in Step 3 to match.)

- [ ] **Step 3: Thread the slug from `App.tsx` down through `SwapVolume.tsx`**

In `web/src/components/SwapVolume.tsx`, change the component signature:

```ts
export default function SwapVolume({ pools }: { pools: PoolRef[] | null }) {
```

to:

```ts
export default function SwapVolume({ pools, geckoTerminalSlug }: { pools: PoolRef[] | null; geckoTerminalSlug: string | null }) {
```

and update its `fetchPoolsVolume(pools, gran, (done, total) => {...}, (ms) => {...})` call to `fetchPoolsVolume(pools, gran, geckoTerminalSlug, (done, total) => {...}, (ms) => {...})`. Also add `geckoTerminalSlug` to that `useEffect`'s dependency array (the one keyed on `[key, scope, gran, attempt]` — add `geckoTerminalSlug` to it, since switching the active chain should re-trigger the pool-volume fetch).

In `App.tsx`, `<SwapVolume pools={poolRefs} />` becomes `<SwapVolume pools={poolRefs} geckoTerminalSlug={activeChainConfig.geckoTerminalSlug} />` — wired up fully in Task 10.

- [ ] **Step 4: Check `volume.test.ts` for a hardcoded assertion**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && grep -n "GT_BASE\|geckoterminal.com/api/v2/networks/robinhood\|fetchPoolsVolume(" web/src/lib/volume.test.ts web/src/lib/volume.smoke.ts web/src/lib/volume-fetch.test.ts web/src/lib/volume-rate.smoke.ts`

If any call site calls `fetchPoolsVolume(...)` positionally, update it to insert `"robinhood"` as the new 3rd argument (preserving today's exact behavior for Robinhood). If any assertion hardcodes the URL string, update it to use `gtBase("robinhood")` (if `gtBase` is exported — export it if a test needs it, otherwise inline the literal `"https://api.geckoterminal.com/api/v2/networks/robinhood/pools"` in the test, matching how the test already worked before this change).

- [ ] **Step 5: Run and confirm**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npx tsx web/src/lib/volume.test.ts`
Expected: unchanged pass count, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/volume.ts web/src/components/SwapVolume.tsx web/src/lib/volume.test.ts
git commit -m "feat(arc): parameterize the swap-volume GeckoTerminal slug by chain"
```

---

## Task 10: `App.tsx` — the chain toggle

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Imports**

Replace:

```ts
import { analyze, fetchEthUsd, poolRefsFor, EXPLORER, type Portfolio, type PositionPnL } from "./lib/chain";
import { resetCaches } from "./lib/chain-cache";
import { clearVolumeMemo } from "./lib/volume";
import { fmtPct, fmtToken, shortId, signUnit, signUsd } from "./lib/format";
import { displayValue, netAfterGas, type NumeraireKind } from "./lib/numeraire";
import { provisionalTotals } from "./lib/provisional";
import SwapVolume from "./components/SwapVolume";
import type { PoolRef } from "./lib/volume";
```

with:

```ts
import { createChainClient, type ChainClient, type Portfolio, type PositionPnL } from "./lib/chain";
import { ROBINHOOD_CHAIN, ARC_CHAIN, type ChainConfig } from "./lib/uniswap-v3-pnl";
import { clearVolumeMemo } from "./lib/volume";
import { fmtPct, fmtToken, shortId, signUnit, signUsd } from "./lib/format";
import { displayValue, netAfterGas, type NumeraireKind } from "./lib/numeraire";
import { provisionalTotals } from "./lib/provisional";
import SwapVolume from "./components/SwapVolume";
import type { PoolRef } from "./lib/volume";
```

(`resetCaches` is no longer a bare import — it comes from the active chain client. `EXPLORER` likewise — see Step 4.)

- [ ] **Step 2: Chain selection state and the two memoized clients**

Replace the top of the `App` component:

```ts
export default function App() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [data, setData] = useState<Portfolio | null>(null);
  const [poolRefs, setPoolRefs] = useState<PoolRef[] | null>(null);
  const [unit, setUnit] = useState<Unit>("eth");
  const [ethUsd, setEthUsd] = useState<number>(3000);
  const [rateLive, setRateLive] = useState(false);

  const loadRate = () =>
    fetchEthUsd()
      .then((v) => { if (v && v > 0) { setEthUsd(Math.round(v)); setRateLive(true); } })
      .catch(() => {});
  useEffect(() => { loadRate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setRateManual = (v: number) => { setEthUsd(v); setRateLive(false); };
```

with:

```ts
type ChainKey = "robinhood" | "arc";
const CHAIN_CONFIG: Record<ChainKey, ChainConfig> = { robinhood: ROBINHOOD_CHAIN, arc: ARC_CHAIN };

export default function App() {
  const [activeChain, setActiveChain] = useState<ChainKey>("robinhood");
  const chainConfig = CHAIN_CONFIG[activeChain];
  // One factory call per chain, memoized for the page's lifetime — NOT per render, and
  // NOT re-created on toggle. Each holds its own RPC client, rate limiter, and reorg-
  // finality cache (see chain.ts/chain-cache.ts Tasks 6/3), so switching the toggle back
  // and forth resumes each chain's own warm state instead of rebuilding it.
  const clients = useMemo<Record<ChainKey, ChainClient>>(
    () => ({ robinhood: createChainClient(ROBINHOOD_CHAIN), arc: createChainClient(ARC_CHAIN) }),
    [],
  );
  const chainClient = clients[activeChain];

  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error" | "chain-not-configured">("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [data, setData] = useState<Portfolio | null>(null);
  const [poolRefs, setPoolRefs] = useState<PoolRef[] | null>(null);
  const [unit, setUnit] = useState<Unit>("eth");
  const [ethUsd, setEthUsd] = useState<number>(3000);
  const [rateLive, setRateLive] = useState(false);

  const loadRate = () => {
    // Arc has no ETH leg at all — fetchEthUsd is absent from its ChainClient (see chain.ts's
    // ChainClient.fetchEthUsd being optional), and there is nothing to load.
    if (!chainClient.fetchEthUsd) return;
    chainClient.fetchEthUsd()
      .then((v) => { if (v && v > 0) { setEthUsd(Math.round(v)); setRateLive(true); } })
      .catch(() => {});
  };
  useEffect(() => { loadRate(); }, [activeChain]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRateManual = (v: number) => { setEthUsd(v); setRateLive(false); };
```

- [ ] **Step 3: `run()` — route through the active chain client, and surface the "not configured" error distinctly**

Replace:

```ts
  async function run(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setStatus("loading");
    setError("");
    setData(null);
    setPoolRefs(null);
    setProgress(null);
    try {
      const res = await analyze(q, (d, t) => setProgress([d, t]));
      setData(res);
      setStatus("done");
      poolRefsFor(res.positions).then(setPoolRefs).catch(() => setPoolRefs([]));
    } catch (e) {
      setError((e as Error).message || "Something went wrong.");
      setStatus("error");
    }
  }
```

with:

```ts
  async function run(raw: string) {
    const q = raw.trim();
    if (!q) return;
    setStatus("loading");
    setError("");
    setData(null);
    setPoolRefs(null);
    setProgress(null);
    try {
      const res = await chainClient.analyze(q, (d, t) => setProgress([d, t]));
      setData(res);
      setStatus("done");
      chainClient.poolRefsFor(res.positions).then(setPoolRefs).catch(() => setPoolRefs([]));
    } catch (e) {
      const message = (e as Error).message || "Something went wrong.";
      // The /rpc proxy's distinct "not configured" body (see rpc.ts's -32001 code) reaches
      // here as a JSON-RPC error whose message names the chain — surfaced plainly rather
      // than through the generic error state, since "arc chain not configured" is
      // actionable in a way "Something went wrong" is not.
      if (message.toLowerCase().includes("not configured")) {
        setError(message);
        setStatus("chain-not-configured");
      } else {
        setError(message);
        setStatus("error");
      }
    }
  }
```

- [ ] **Step 4: wire the chain toggle into `Header`, and reset on switch**

Replace the JSX:

```tsx
        <Header unit={unit} setUnit={setUnit} ethUsd={ethUsd} setEthUsd={setRateManual} rateLive={rateLive} onRefreshRate={loadRate} />

        <div className="mt-8">
          <SwapVolume pools={poolRefs} />
        </div>
```

with:

```tsx
        <Header
          chain={activeChain}
          setChain={(c) => {
            setActiveChain(c);
            setInput(""); setStatus("idle"); setError(""); setData(null); setPoolRefs(null);
            setUnit("usd"); // Arc has no eth leg; Robinhood re-derives its own live rate via the effect below regardless
          }}
          unit={unit} setUnit={setUnit} ethUsd={ethUsd} setEthUsd={setRateManual} rateLive={rateLive} onRefreshRate={loadRate}
          hasEthLeg={chainConfig.tokens.ethAnchors.length > 0}
        />

        <div className="mt-8">
          <SwapVolume pools={poolRefs} geckoTerminalSlug={chainConfig.geckoTerminalSlug} />
        </div>
```

Update the "Rescan from chain" button's `onClick` (originally `async () => { await resetCaches(); clearVolumeMemo(); run(input); }`) to `async () => { await chainClient.resetCaches(); clearVolumeMemo(); run(input); }`.

Update the status-rendering block to handle the new `"chain-not-configured"` status distinctly from `"error"`:

```tsx
          {status === "loading" && <LoadingState progress={progress} />}
          {status === "chain-not-configured" && (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
              {error || `${activeChain === "arc" ? "Arc" : "Robinhood"} isn't configured on this deployment yet.`}
            </div>
          )}
          {status === "error" && <ErrorState message={error} onRetry={() => run(input)} />}
          {status === "done" && data && (data.positions.length ? <Results data={data} unit={unit} ethUsd={ethUsd} explorerUrl={chainConfig.explorerUrl} /> : <EmptyState query={data.query} />)}
          {status === "idle" && <IdleState />}
```

(`Results` gains an `explorerUrl` prop — wired through to `PositionCard` in Step 6.)

- [ ] **Step 5: `Header` — add the chain toggle, hide/disable the ETH unit toggle on Arc**

Replace the `Header` function:

```ts
function Header({ unit, setUnit, ethUsd, setEthUsd, rateLive, onRefreshRate }: { unit: Unit; setUnit: (u: Unit) => void; ethUsd: number; setEthUsd: (v: number) => void; rateLive: boolean; onRefreshRate: () => void }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight">LP PnL Tracker</h1>
        </div>
        <p className="mt-1.5 text-sm text-muted">
          Uniswap v3 &amp; v4 liquidity PnL on <span className="text-fg">Robinhood Chain</span> — fees, impermanent loss, and net return per position.
        </p>
      </div>

      <fieldset className="shrink-0 rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Value display unit">
        <div className="flex items-center gap-1">
          <UnitToggle active={unit === "eth"} onClick={() => setUnit("eth")}>Ξ WETH</UnitToggle>
          <UnitToggle active={unit === "usd"} onClick={() => setUnit("usd")}>USD</UnitToggle>
          <label className="ml-1 flex items-center gap-1 pl-1 text-muted">
            <span className="sr-only">ETH price in USD</span>
            <span aria-hidden>ETH $</span>
            <input
              type="number"
              min={0}
              value={ethUsd}
              onChange={(e) => setEthUsd(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 rounded-md border border-border bg-surface-2 px-1.5 py-1 font-mono text-fg tnum"
            />
          </label>
          <button
            type="button"
            onClick={onRefreshRate}
            title={rateLive ? "Live from the on-chain WETH/USDG pool — click to refresh" : "Manual override — click to pull the live on-chain price"}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted transition-colors hover:text-fg"
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${rateLive ? "bg-pos" : "bg-muted"}`} aria-hidden />
            {rateLive ? "live" : "manual"}
          </button>
        </div>
      </fieldset>
    </header>
  );
}
```

with:

```ts
function Header({
  chain, setChain, unit, setUnit, ethUsd, setEthUsd, rateLive, onRefreshRate, hasEthLeg,
}: {
  chain: "robinhood" | "arc"; setChain: (c: "robinhood" | "arc") => void;
  unit: Unit; setUnit: (u: Unit) => void; ethUsd: number; setEthUsd: (v: number) => void;
  rateLive: boolean; onRefreshRate: () => void; hasEthLeg: boolean;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight">LP PnL Tracker</h1>
        </div>
        <p className="mt-1.5 text-sm text-muted">
          Uniswap v3 &amp; v4 liquidity PnL on <span className="text-fg">{chain === "robinhood" ? "Robinhood Chain" : "Arc"}</span> — fees, impermanent loss, and net return per position.
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <fieldset className="rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Chain">
          <div className="flex items-center gap-1">
            <UnitToggle active={chain === "robinhood"} onClick={() => setChain("robinhood")}>Robinhood</UnitToggle>
            <UnitToggle active={chain === "arc"} onClick={() => setChain("arc")}>Arc</UnitToggle>
          </div>
        </fieldset>

        {hasEthLeg && (
          <fieldset className="rounded-xl border border-border bg-surface p-1 text-xs" aria-label="Value display unit">
            <div className="flex items-center gap-1">
              <UnitToggle active={unit === "eth"} onClick={() => setUnit("eth")}>Ξ WETH</UnitToggle>
              <UnitToggle active={unit === "usd"} onClick={() => setUnit("usd")}>USD</UnitToggle>
              <label className="ml-1 flex items-center gap-1 pl-1 text-muted">
                <span className="sr-only">ETH price in USD</span>
                <span aria-hidden>ETH $</span>
                <input
                  type="number"
                  min={0}
                  value={ethUsd}
                  onChange={(e) => setEthUsd(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 rounded-md border border-border bg-surface-2 px-1.5 py-1 font-mono text-fg tnum"
                />
              </label>
              <button
                type="button"
                onClick={onRefreshRate}
                title={rateLive ? "Live from the on-chain WETH/USDG pool — click to refresh" : "Manual override — click to pull the live on-chain price"}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted transition-colors hover:text-fg"
              >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${rateLive ? "bg-pos" : "bg-muted"}`} aria-hidden />
                {rateLive ? "live" : "manual"}
              </button>
            </div>
          </fieldset>
        )}
      </div>
    </header>
  );
}
```

(Arc positions are always `unit === "usd"` in practice — `setActiveChain`'s handler in Step 4 already forces `setUnit("usd")` on every switch, and the unit fieldset is hidden entirely for a chain with no ETH leg, so there is no way to leave Arc's view stuck on "eth" with the toggle hidden.)

- [ ] **Step 6: `EXPLORER` → `explorerUrl` prop, threaded through `Results`/`PositionCard`, with a no-link fallback**

`Results`, `PositionCard` each need an `explorerUrl: string | null` prop instead of the removed module-level `EXPLORER` import. Update:

```ts
function Results({ data, unit, ethUsd }: { data: Portfolio; unit: Unit; ethUsd: number }) {
```
to
```ts
function Results({ data, unit, ethUsd, explorerUrl }: { data: Portfolio; unit: Unit; ethUsd: number; explorerUrl: string | null }) {
```
and its one use of `EXPLORER`:
```tsx
          <a href={`${EXPLORER}/address/${data.query}`} target="_blank" rel="noreferrer" className="font-mono text-fg/70 underline decoration-border underline-offset-2 hover:text-accent">
            {shortId(data.query, 8, 6)}
          </a>
```
to a conditional (link when available, plain text otherwise):
```tsx
          {explorerUrl ? (
            <a href={`${explorerUrl}/address/${data.query}`} target="_blank" rel="noreferrer" className="font-mono text-fg/70 underline decoration-border underline-offset-2 hover:text-accent">
              {shortId(data.query, 8, 6)}
            </a>
          ) : (
            <span className="font-mono text-fg/70">{shortId(data.query, 8, 6)}</span>
          )}
```

And propagate `explorerUrl` into its `<PositionCard>` calls: `<PositionCard key={String(p.tokenId)} p={p} unit={unit} ethUsd={ethUsd} explorerUrl={explorerUrl} />`.

In `PositionCard`, apply the same pattern to its two `EXPLORER`-based links (entry tx, exit tx):
```ts
function PositionCard({ p, unit, ethUsd }: { p: PositionPnL; unit: Unit; ethUsd: number }) {
```
to
```ts
function PositionCard({ p, unit, ethUsd, explorerUrl }: { p: PositionPnL; unit: Unit; ethUsd: number; explorerUrl: string | null }) {
```
and each `<a href={`${EXPLORER}/tx/...`}>` wrapped the same conditional way as Step 6's `Results` example above (link when `explorerUrl` is set, a plain `<span className="font-mono">` with the same short-hash text otherwise).

- [ ] **Step 7: `gasKind`-aware money helpers**

Replace:

```ts
function posNet(p: PositionPnL, unit: Unit, ethUsd: number) {
  return netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, ethUsd, unit);
}
function posPnlPct(p: PositionPnL, ethUsd: number) {
  const depUsd = displayValue(p.result.depositedUsd, p.numeraireKind, ethUsd, "usd");
  return depUsd > 0 ? netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, ethUsd, "usd") / depUsd : 0;
}
```

with:

```ts
function posNet(p: PositionPnL, unit: Unit, ethUsd: number) {
  return netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, p.gasKind, ethUsd, unit);
}
function posPnlPct(p: PositionPnL, ethUsd: number) {
  const depUsd = displayValue(p.result.depositedUsd, p.numeraireKind, ethUsd, "usd");
  return depUsd > 0 ? netAfterGas(p.result.netPnlUsd, p.numeraireKind, p.gasEth, p.gasKind, ethUsd, "usd") / depUsd : 0;
}
```

And replace every remaining hardcoded `"eth"` gas-kind literal at the three other call sites found earlier:
- `PnlCalendar`'s `gas: money(p.gasEth, "eth", unit, ethUsd),` → `gas: money(p.gasEth, p.gasKind, unit, ethUsd),`
- `SummaryBar`'s `acc.gas += money(p.gasEth, "eth", unit, ethUsd);` → `acc.gas += money(p.gasEth, p.gasKind, unit, ethUsd);`
- `PositionCard`'s stat-tile row `{ label: "Gas", v: -p.gasEth, kind: "eth" as NumeraireKind, tone: "neg" as const }` → `{ label: "Gas", v: -p.gasEth, kind: p.gasKind, tone: "neg" as const }`

Also grep for any OTHER call site in `App.tsx` this plan's reading of the file did not surface — in particular `gasInNumeraire`, which was not observed to be called from `App.tsx` while writing this plan (only `netAfterGas`/`displayValue` were), but its signature also changed in Task 2 (gained a leading `chain` parameter):

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && grep -n "gasInNumeraire" web/src/App.tsx web/src/components/*.tsx`
Expected: no results. If this DOES find a call site, insert `chainConfig` as its new first argument there too (same pattern as every other `chain`-first parameter change in this plan) before proceeding.

- [ ] **Step 8: typecheck**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl/web && npx tsc --noEmit`
Expected: zero errors. This is the step where every loose end from Tasks 6, 7 and 9 gets caught — resolve any remaining type errors before moving on; do not silence them with `any`.

- [ ] **Step 9: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(arc): wire the Robinhood/Arc toggle into App.tsx"
```

---

## Task 11: Full regression run + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full unit-test suite**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && npm run verify`
Expected: every listed test file prints its `PASS` lines and a final `N/N passed`; the script's overall exit code is 0. If anything fails, fix it before proceeding — do not skip ahead with a known-red suite.

- [ ] **Step 2: Typecheck + build**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl/web && npm run build`
Expected: `tsc --noEmit` passes, `vite build` completes, exit code 0.

- [ ] **Step 3: Manual dashboard smoke test — Robinhood path unchanged**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl/web && npm run dev`, open the printed local URL, and confirm:
- The page loads on the Robinhood toggle by default, ETH/USD unit toggle visible, live rate loads.
- Paste a known-good Robinhood wallet or tx (use one from `src/realpnl.ts` or a recent one from git history / the deployed site) and confirm positions render exactly as before this change (spot-check net PnL, fees, gas figures against a screenshot or the live deployed site at the same input).
- Click "Rescan from chain" and confirm it still works.
- Click the volume chart's "Your pools" / "All Uniswap" toggle and confirm it still renders.

- [ ] **Step 4: Manual dashboard smoke test — Arc path (config-dependent)**

Without `ARC_RPC_URL` set (the local dev server has no Netlify edge function; `/rpc` requests will 404 or fail outright in plain `vite dev` — this is expected and pre-existing, not new breakage): switch the toggle to Arc, and confirm the UI does not crash — it should show a clear error state (not a blank page or an uncaught exception) since there is no local `/rpc` proxy in `vite dev` at all regardless of chain. This confirms the toggle itself, the unit-toggle hiding, and the error-state rendering all work structurally, even without a live Arc RPC to test against end-to-end. A full end-to-end Arc test requires either `netlify dev` (which does run edge functions locally) with `ARC_RPC_URL` set, or the deployed Netlify site once that env var is set — flag to the user that this step is the honest limit of what can be verified without a real, trusted Arc RPC endpoint in hand (see the design doc's "Verification" section and Task 12 below).

- [ ] **Step 5: No user-facing report of "Arc works end-to-end" until Task 12's boot-time check passes against a real endpoint**

Do not claim Arc support is fully verified based on Steps 1–4 alone — they confirm the code is correct and structurally wired, not that the assumed-identical v4 addresses are actually live and correct on Arc mainnet. That confirmation is Task 12.

---

## Task 12: Rollout — Netlify env vars + the boot-time address-verification check

**Files:**
- Create: a small one-off verification script (not part of the app bundle), e.g. `web/scripts/verify-arc-addresses.ts` — run manually once, not part of `npm run verify`.

- [ ] **Step 1: Write the verification script**

```ts
/**
 * One-off check, run manually before flipping the Arc toggle on for real users:
 * confirms the v4 addresses ARC_CHAIN assumes (copied from Robinhood on the strength of
 * CREATE2 determinism — see uniswap-v3-pnl.ts's ARC_CHAIN comment) actually have code
 * deployed at them on Arc. Requires a real ARC_RPC_URL — pass it as an env var, since
 * this script talks to the RPC directly (no /rpc proxy, no Netlify).
 *
 * Usage: ARC_RPC_URL=https://... npx tsx web/scripts/verify-arc-addresses.ts
 */
import { createPublicClient, http } from "viem";
import { ARC_CHAIN } from "../src/lib/uniswap-v3-pnl";

async function main() {
  const rpcUrl = process.env.ARC_RPC_URL;
  if (!rpcUrl) {
    console.error("Set ARC_RPC_URL to a real Arc RPC endpoint before running this script.");
    process.exit(1);
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const checks: [string, string][] = [
    ["PositionManager", ARC_CHAIN.uniswapV4.positionManager],
    ["PoolManager", ARC_CHAIN.uniswapV4.poolManager],
    ["StateView", ARC_CHAIN.uniswapV4.stateView],
  ];
  let ok = true;
  for (const [name, address] of checks) {
    const code = await client.getCode({ address: address as `0x${string}` });
    const hasCode = !!code && code !== "0x";
    console.log(`${hasCode ? "OK  " : "FAIL"}  ${name.padEnd(16)} ${address}`);
    if (!hasCode) ok = false;
  }
  if (!ok) {
    console.error("\nOne or more assumed v4 addresses have NO CODE on Arc. Do not enable the Arc toggle for real users until this is resolved — see ARC_CHAIN's comment in uniswap-v3-pnl.ts.");
    process.exit(1);
  }
  console.log("\nAll assumed v4 addresses have code on Arc.");
}

main();
```

- [ ] **Step 2: Run it against a real, trusted Arc RPC endpoint**

Run: `cd /home/wanaqil/Documents/Code/node/personal/worker/robinhood-v3-lp-pnl && ARC_RPC_URL=<a real, verified endpoint — NOT copied from an unverified search result> npx tsx web/scripts/verify-arc-addresses.ts`
Expected: `OK` for all three addresses. If any `FAIL`s, stop — do not set `ARC_RPC_URL` on Netlify or announce Arc support until the correct addresses are found and `ARC_CHAIN` in `uniswap-v3-pnl.ts` is updated.

- [ ] **Step 3: Set Netlify env vars (only after Step 2 passes)**

Set on the Netlify project (via the dashboard or `netlify env:set`, per this repo's existing rollout convention — see how `PUBLIC_RPC_URL` etc. were originally set, or the `use-railway`/Netlify equivalent this repo follows):
- `ARC_RPC_URL` — the verified endpoint from Step 2.
- `ARC_PAID_RPC_URL` / `ARC_WALLET_RPC_URL` — optional, only if a paid Arc RPC provider is in hand.

Until this step, the Arc toggle is live in the UI but every Arc analysis returns the "not configured" message from Task 4 — the feature ships safely dark, exactly as the design doc's "Rollout" section specifies.

- [ ] **Step 4: Commit the verification script**

```bash
git add web/scripts/verify-arc-addresses.ts
git commit -m "chore(arc): add one-off v4 address verification script"
```

---

## Summary of files touched

- `web/src/lib/uniswap-v3-pnl.ts` — `ChainConfig` type, `ARC_CHAIN`
- `web/src/lib/chain-config.test.ts` — new
- `web/src/lib/numeraire.ts`, `numeraire.test.ts`
- `web/src/lib/chain-cache.ts`, `chain-cache.test.ts` — factory conversion
- `web/netlify/edge-functions/rpc.ts` — per-chain routing
- `web/src/lib/chain.ts` — factory conversion (`createChainClient`)
- `web/src/lib/chain-v4.ts` — factory conversion (`createV4Client`)
- `web/src/lib/volume.ts`, `web/src/components/SwapVolume.tsx`, `volume.test.ts` — GeckoTerminal slug parameterization
- `web/src/App.tsx` — the toggle
- `web/scripts/verify-arc-addresses.ts` — new, manual rollout check
- Root `package.json` — `verify` script gains one entry
- **Not touched:** `src/uniswap-v3-pnl.ts`, `src/live.ts`, `src/config.test.ts` (CLI stays Robinhood-only — see the ordering hazard note at the top of this plan)
