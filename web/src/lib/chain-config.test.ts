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
eq("arc has a lower concurrency ceiling (free-tier RPCs rate-limit under 8)", ARC_CHAIN.maxInflight, 3);
eq("robinhood leaves maxInflight unset (keeps its measured default of 8)", ROBINHOOD_CHAIN.maxInflight, undefined);
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
