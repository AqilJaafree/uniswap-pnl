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
