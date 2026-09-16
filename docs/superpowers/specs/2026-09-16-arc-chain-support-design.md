# Arc Chain Support (Phase A: multi-chain PnL + toggle) — Design

Date: 2026-09-16
Project: `robinhood-v3-lp-pnl` (web app: Vite + React + Tailwind, deployed on Netlify)
Status: Approved (design), pending implementation plan

## Goal

Make the deployed LP PnL calculator multi-chain: today it only knows Robinhood
Chain (chainId 4663). Add Circle's **Arc** chain (chainId 5042, public mainnet
opening 2026-09-16 — today) as a second supported chain, with an in-app
`Robinhood | Arc` toggle in the header that switches which chain's data the
existing paste-a-wallet-or-tx dashboard reads and displays. No funds move as
part of this toggle — it is a view switch only.

This is Phase A of a two-phase request. Phase B (a live "Arc Activity" feed of
recent pool transactions, independent of any one wallet) is a separate spec
and out of scope here.

## Non-goals

- **No Uniswap v3 on Arc.** Every source found at design time (Circle's own
  announcements, Uniswap's Arc integration playbook) confirms only **v4** is
  deployed on Arc at mainnet launch. `ARC_CHAIN`'s config has no `uniswapV3`
  block; if this changes later, it is a follow-up.
- **No cross-chain bridge / asset movement.** The toggle only changes which
  chain the dashboard reads from. (Confirmed explicitly — an earlier draft of
  this request could have been read as "move funds from Robinhood to Arc";
  that is not what is being built.)
- **No Arc Activity feed.** That's Phase B.
- **No porting of the Blockscout internal-transactions fee reconstruction**
  (`chain-v4.ts`'s call to `${explorer}/api/v2/transactions/.../internal-transactions`,
  needed on Robinhood to recover native-ETH payouts that don't appear as ERC-20
  `Transfer` logs) to Arc's explorer (Arcscan, a different API shape). This
  code path is only reachable for native-currency-anchored v4 positions, and
  those are explicitly unsupported on Arc (see Numeraire section) — so the
  path is simply never exercised for Arc, not stubbed or faked.
- **No GeckoTerminal volume chart data for Arc** unless/until Arc has a
  confirmed GeckoTerminal network slug. The chart shows "not available" for
  Arc rather than guessing a slug.

## Background / on-chain facts

- Arc chainId: **5042**. USDC is Arc's native gas asset; there is no
  WETH/native-ETH concept on Arc at all.
- Arc's Uniswap v4 **PoolManager**: `0x8366a39cc670b4001a1121b8f6a443a643e40951`
  — independently verified by the sibling `oarfish` project (three GitHub
  sources: viem chain definitions, ethereum-lists/chains, Uniswap's own
  UniswapX playbook). This is **byte-identical** to Robinhood Chain's
  PoolManager address already in this repo (`uniswap-v3-pnl.ts`), which
  confirms Uniswap v4's periphery contracts deploy via CREATE2 to the same
  address on every chain that has them.
- Working assumption from the above: Arc's v4 **PositionManager**
  (`0x58daec3116aae6d93017baaea7749052e8a04fa7`) and **StateView**
  (`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`) are the same addresses as
  Robinhood's, by the same CREATE2 logic. This is a strong assumption, not a
  verified fact for those two specific contracts — see Verification below.
- **ARC_USDC** (the ERC-20 predeploy oarfish anchors on): `0x3600000000000000000000000000000000000000`
  (6 decimals). Arc v4 pools can also reference the *native* representation of
  the same USDC balance at `address(0)` (18 decimals) — oarfish deliberately
  never matches against that representation, calling the two-representation
  mixup "the #1 documented integration risk" on Arc. This design follows the
  same rule.
- **No public RPC URL is hardcoded.** Arc mainnet opens today; every RPC
  endpoint found via web search either isn't yet confirmed live or was
  reported returning 401/403 in the days before launch. `ARC_RPC_URL` (and
  its paid/wallet-lane siblings) must be supplied via Netlify env with **no
  default**, exactly as oarfish already does for its own Arc RPC config.

## Architecture / components

### `web/src/lib/uniswap-v3-pnl.ts` — `ChainConfig` type

Generalize today's single `ROBINHOOD_CHAIN` constant into a `ChainConfig`
shape and export two instances:

```ts
interface ChainConfig {
  chainId: number;
  rpcUrl: string;          // public RPC (Node/CLI use only; browser always uses /rpc)
  explorer: string | null; // null = no internal-tx reconstruction available/needed
  nativeCurrency: { name: string; symbol: string; decimals: number };
  uniswapV3?: { factory: string; nonfungiblePositionManager: string; swapRouter02: string; ... };
  uniswapV4: { poolManager: string; positionManager: string; stateView: string; modifyLiquidityTopic0: string };
  tokens: {
    usdAnchors: string[];   // any token here → numeraire "usd"
    ethAnchors: string[];   // any token here → numeraire "eth" (empty for Arc)
    usdDecimals: number;    // decimals of the primary usd anchor, for display
  };
  geckoTerminalSlug: string | null; // null = volume chart shows "not available"
}

export const ROBINHOOD_CHAIN: ChainConfig = { /* existing values, restructured */ };
export const ARC_CHAIN: ChainConfig = {
  chainId: 5042,
  rpcUrl: "", // never used directly by the browser; /rpc proxy resolves the real URL server-side
  explorer: null,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  uniswapV4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    modifyLiquidityTopic0: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  },
  tokens: {
    usdAnchors: ["0x3600000000000000000000000000000000000000"], // ARC_USDC predeploy only
    ethAnchors: [],
    usdDecimals: 6,
  },
  geckoTerminalSlug: null,
};
```

`resolveActions`/`computePnL`/tick math are untouched — this is purely a
config/address change, same as the existing v4-vs-v3 split.

### `web/src/lib/numeraire.ts` — parameterize by `ChainConfig`

`pickNumeraire(chain: ChainConfig, token0, token1, sym0, sym1)` checks
`chain.tokens.usdAnchors` / `chain.tokens.ethAnchors` instead of the current
hardcoded `ROBINHOOD_CHAIN` import. For Arc, `ethAnchors` is empty, so every
Arc position is `kind: "usd"` or `null` (unsupported pair) — never `"eth"`.
`displayValue`/`toUsd` are otherwise unchanged (they already take `kind` as a
parameter, not a chain).

### `web/src/lib/chain.ts`, `chain-v4.ts` — thread `ChainConfig` explicitly

Replace the module-level `const NPM = getAddress(ROBINHOOD_CHAIN...)`-style
constants with values read from a `ChainConfig` parameter passed into
`analyze(query, chain: ChainConfig, onProgress)` and
`computePositionPnLV4(..., chain: ChainConfig)`. Since Arc has no v3, `analyze`
skips the v3 enumeration branch entirely when `chain.uniswapV3` is undefined
(same pattern already used for "does this wallet have any v4 positions").

### `web/src/lib/chain-cache.ts` — namespace already correct

`const NS = \`v1:${chain.chainId}\`` becomes a function of the passed-in
`ChainConfig` instead of the imported constant. No cache migration needed —
Robinhood's existing cached entries keep their `v1:4663:...` keys untouched;
Arc gets a fresh `v1:5042:...` namespace.

### `web/netlify/edge-functions/rpc.ts` — per-chain upstream selection

Add a `chain` query param (client-supplied, same pattern as the existing
`lane` param). `upstreams(lane, chain)` reads:
- `chain !== "arc"` (default): today's `PUBLIC_RPC_URL` / `PAID_RPC_URL` /
  `WALLET_RPC_URL` — **unchanged**, zero risk to the live Robinhood path.
- `chain === "arc"`: `ARC_RPC_URL` / `ARC_PAID_RPC_URL` / `ARC_WALLET_RPC_URL`.
  If `ARC_RPC_URL` is unset, return a distinct error body (e.g.
  `{ error: { code: -32001, message: "arc chain not configured" } }`) instead
  of falling through to any default — there is no safe default to fall back
  to for a chain that opened mainnet today. `orderUpstreams` (pure, already
  chain-agnostic) needs no change.

### `web/src/App.tsx` — the toggle

Add `activeChain: "robinhood" | "arc"` state, defaulting to `"robinhood"`
(today's behavior, unchanged for anyone who doesn't touch the toggle). The
header toggle sets this and re-runs `analyze()` against the new chain's
config. When `activeChain === "arc"`:
- The ETH/USD unit toggle and `fetchEthUsd()` call are skipped — Arc has no
  ETH leg, everything is already USD.
- `poolRefsFor`/`SwapVolume` renders its existing "not available" state
  (`geckoTerminalSlug === null`) rather than fetching.
- If the RPC proxy returns the "arc chain not configured" error, the app
  shows that message plainly (not a generic "something went wrong").

### `web/src/lib/volume.ts` — parameterize the GeckoTerminal base URL

`GT_BASE` becomes a function of `chain.geckoTerminalSlug`; when that's `null`,
the volume-fetch path returns the existing "not asked about" state used today
for pools that were genuinely never queried, rather than attempting a request
to a `.../networks/null/...` URL.

## Verification (before calling Arc "supported")

1. Boot-time / first-use smoke check: `eth_getCode` on Arc for
   `positionManager` and `stateView` — both must return non-empty bytecode
   before any Arc position is analyzed. If either is empty, surface "Arc v4
   contracts not yet verified at expected addresses" rather than silently
   returning zero positions (same "surfaced, never silently dropped"
   principle the README already states for read failures).
2. One real Arc wallet or tx, once mainnet has processed at least one v4 LP
   mint, run through the dashboard end-to-end as a manual check before
   considering this done.

## Testing

- `numeraire.test.ts`: extend to take an explicit `ChainConfig` per case; add
  cases for `ARC_CHAIN` (ARC_USDC-anchored pairs → `"usd"`; native-ARC
  address(0) pairs → `null`/unsupported).
- `chain-cache.test.ts`: assert namespace differs correctly for two different
  `ChainConfig` instances (no cross-chain key collision).
- New `web/netlify/lib/*` test (or extend `lane-order.test.ts`'s sibling):
  `upstreams(lane, chain)` selects the right env-var set per `chain`, and
  returns the distinct "not configured" error when `ARC_RPC_URL` is unset.
- `config.test.ts` (src/): extend or add an equivalent assertion that
  `ARC_CHAIN` has no `uniswapV3` block and empty `ethAnchors`.
- Existing v3/v4 Robinhood tests: update call sites to pass `ROBINHOOD_CHAIN`
  explicitly; behavior must be provably unchanged (this is a mechanical
  parameterization, not a logic change, for every Robinhood code path).

## Rollout

- `ARC_RPC_URL` (and optional `ARC_PAID_RPC_URL` / `ARC_WALLET_RPC_URL`) set
  on the Netlify project once a verified Arc RPC endpoint is available — until
  then, the Arc toggle is present in the UI but every Arc analysis fails with
  the explicit "not configured" message. This ships safely dark.
- No changes to `PUBLIC_RPC_URL` / `PAID_RPC_URL` / `WALLET_RPC_URL` or any
  other existing env var — the Robinhood path is additive-only.
