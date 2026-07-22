import { pickNumeraire, numerairePricePoint, toUsd, gasInNumeraire, type NumeraireKind } from "./numeraire";

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

eq("usdg pair kind", pickNumeraire(WETH, USDG, "WETH", "USDG").kind, "usd");
eq("usdg anchor is token1", pickNumeraire(WETH, USDG, "WETH", "USDG").anchorIsToken0, false);
eq("usdg symbol", pickNumeraire(WETH, USDG, "WETH", "USDG").symbol, "USD");
eq("usdg token0 anchor", pickNumeraire(USDG, FOO, "USDG", "FOO").anchorIsToken0, true);
eq("native eth kind", pickNumeraire(NATIVE, FOO, "ETH", "FOO").kind, "eth");
eq("native eth anchor token0", pickNumeraire(NATIVE, FOO, "ETH", "FOO").anchorIsToken0, true);
eq("weth token1 kind", pickNumeraire(FOO, WETH, "FOO", "WETH").kind, "eth");
eq("unsupported", pickNumeraire(FOO, "0x00000000000000000000000000000000000000ee", "A", "B"), null);

{ const pp = numerairePricePoint(2000, false); approx("anchorT1 p0", pp.p0, 2000); approx("anchorT1 p1", pp.p1, 1); }
{ const pp = numerairePricePoint(2000, true); approx("anchorT0 p0", pp.p0, 1); approx("anchorT0 p1", pp.p1, 1 / 2000); }

eq("toUsd usd", toUsd(50, "usd", 3000), 50);
eq("toUsd eth", toUsd(2, "eth", 3000), 6000);
eq("toUsd eth null fallback", toUsd(5, "eth", null), 5);

// gasInNumeraire: ETH pairs keep ETH; USD pairs convert gas via the WETH leg.
{
  const ethNum = pickNumeraire(NATIVE, FOO, "ETH", "FOO")!;      // eth-numeraire
  const usdWethNum = pickNumeraire(WETH, USDG, "WETH", "USDG")!; // USDG token1, WETH token0
  const usdNoWeth = pickNumeraire(USDG, FOO, "USDG", "FOO")!;    // USD pair, no WETH leg
  approx("gas eth-numeraire stays ETH", gasInNumeraire(0.01, ethNum, NATIVE, FOO, 5), 0.01);
  // WETH=token0 priced at 2000/USDG → gas 0.01 ETH = $20
  approx("gas USD via WETH token0 leg", gasInNumeraire(0.01, usdWethNum, WETH, USDG, 2000), 20);
  eq("gas USD pair w/o WETH → 0 (no ETH price)", gasInNumeraire(0.01, usdNoWeth, USDG, FOO, 2000), 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
