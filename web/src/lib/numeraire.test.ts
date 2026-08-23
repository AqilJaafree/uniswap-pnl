import { pickNumeraire, numerairePricePoint, toUsd, gasInNumeraire, displayValue, netAfterGas, type NumeraireKind, totalsByNumeraire } from "./numeraire";

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

// displayValue: value in a position's numeraire → chosen display unit, using an
// ETH/USD rate that is ALWAYS available (decoupled from the toggle). Both views
// must be consistent: the ETH view equals the USD view divided by the rate.
{
  const rate = 3000;
  // ETH-numeraire position: value is in ETH.
  approx("eth pos, eth unit = native (rate-independent)", displayValue(0.05, "eth", rate, "eth"), 0.05);
  approx("eth pos, usd unit = ×rate", displayValue(0.05, "eth", rate, "usd"), 150);
  // USD-numeraire (USDG) position: value is in USD.
  approx("usd pos, usd unit = native", displayValue(120, "usd", rate, "usd"), 120);
  approx("usd pos, eth unit = ÷rate", displayValue(120, "usd", rate, "eth"), 0.04);
  // Consistency: eth-unit total == usd-unit total / rate, across a MIXED wallet.
  const ethPos = 0.05, usdPos = 120;
  const totalUsd = displayValue(ethPos, "eth", rate, "usd") + displayValue(usdPos, "usd", rate, "usd");
  const totalEth = displayValue(ethPos, "eth", rate, "eth") + displayValue(usdPos, "usd", rate, "eth");
  approx("mixed total: eth == usd / rate", totalEth, totalUsd / rate);
  // Degenerate rate (0) must not yield Infinity/NaN in the eth view.
  eq("eth unit with rate 0 is finite", Number.isFinite(displayValue(120, "usd", 0, "eth")), true);
}

// netAfterGas: a position's pre-gas net (in its own numeraire) minus native ETH
// gas, both expressed in the chosen display unit via the shared rate. Gas is
// always ETH, so a USDG position's gas converts through the rate — no longer
// silently dropped to 0.
{
  const rate = 3000, gasEth = 0.00002;
  // USD position: $100 net, gas 0.00002 ETH = $0.06.
  approx("usd pos net after gas, usd unit", netAfterGas(100, "usd", gasEth, rate, "usd"), 100 - 0.06);
  approx("usd pos net after gas, eth unit", netAfterGas(100, "usd", gasEth, rate, "eth"), 100 / 3000 - 0.00002);
  // ETH position: Ξ0.05 net, gas in ETH.
  approx("eth pos net after gas, eth unit", netAfterGas(0.05, "eth", gasEth, rate, "eth"), 0.05 - 0.00002);
  approx("eth pos net after gas, usd unit", netAfterGas(0.05, "eth", gasEth, rate, "usd"), 150 - 0.06);
  // zero gas is a no-op
  approx("no gas = plain displayValue", netAfterGas(100, "usd", 0, rate, "usd"), 100);
}


// ---------------------------------------------------------------------------
// A portfolio total may not mix units.
//
// `netPnlUsd` is ANCHOR-unit, not dollars: ether for a WETH pair, dollars for a
// USDG one. Summing it across a mixed wallet produces a number in no unit at all
// — live, 0x7e99…A2C read "net=120.86 fees=302.07", which is ~dollars from its
// USDG positions with a little ether stirred in, and was misread as Ξ. The UI
// never hit this (SummaryBar converts each position first), but the smoke scripts
// print it and assert on it.
//
// There is no rate here to convert with, and inventing one would put a second,
// staler source of truth next to the UI's live rate. So the totals are SPLIT, and
// a caller that wants one number has to supply a rate — as the UI already does.
// ---------------------------------------------------------------------------
{
  const eth = { numeraireKind: "eth" as const, gasEth: 0.00002, result: { netPnlUsd: 0.05, feesUsd: 0.02, ilUsd: -0.01 } };
  const usd = { numeraireKind: "usd" as const, gasEth: 0.00003, result: { netPnlUsd: 100, feesUsd: 120, ilUsd: -20 } };
  const t = totalsByNumeraire([eth, usd, usd]);

  approx("eth bucket keeps ether", t.eth.net, 0.05);
  approx("usd bucket keeps dollars", t.usd.net, 200);
  approx("eth fees", t.eth.fees, 0.02);
  approx("usd fees", t.usd.fees, 240);
  approx("eth il", t.eth.il, -0.01);
  approx("usd il", t.usd.il, -40);
  eq("eth bucket counts its own", t.eth.count, 1);
  eq("usd bucket counts its own", t.usd.count, 2);
  eq("count is every position", t.count, 3);
  // Gas is native ETH whatever the pair quotes in, so it is ONE number in Ξ.
  approx("gas is ether across the board", t.gas, 0.00008);

  // The regression itself: no field may hold 200.05.
  const mixed = [t.eth.net, t.usd.net, t.eth.fees, t.usd.fees, t.gas].some((v) => Math.abs(v - 200.05) < 1e-9);
  console.log(`${mixed ? "FAIL" : "PASS"}  no field sums ether into dollars`);
  mixed ? fail++ : pass++;

  // An all-one-numeraire wallet leaves the other bucket at zero, not undefined —
  // a consumer can read both without guarding.
  const only = totalsByNumeraire([eth]);
  eq("empty bucket is zero, not absent", only.usd.net, 0);
  eq("empty bucket counts zero", only.usd.count, 0);
  eq("no positions at all", totalsByNumeraire([]).count, 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
