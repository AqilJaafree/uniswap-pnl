/**
 * `analyze()` must refuse a wallet-address query outright on EVERY chain unless that
 * address is in WALLET_SCAN_ALLOWLIST (see wallet-scan-allowlist.ts) — a deliberate access
 * restriction on the public tool, not a per-chain reliability gate. Robinhood's wallet scan
 * works fine end-to-end and is restricted here too; this file must prove that, not just
 * assume it, or a config typo confining the check to Arc would ship silently.
 *
 * The refusal case is a construction-time gate, not a network one: `createChainClient`
 * builds a real viem client but never connects until a request is made, so most of this
 * file makes NO network call at all — a hang there would mean the gate stopped running
 * before the request, not after it. The allowlisted case is the one exception (see its own
 * comment below) and gets a short hard timeout accordingly.
 */
// Force BOTH chains onto a dead local port. Arc's rpcUrl is "" (no browser-trusted public
// URL), which would otherwise throw at CLIENT CONSTRUCTION in this Node context. Robinhood's
// rpcUrl is a REAL production endpoint — without this override, a gate that failed to fire
// would silently hit it for real from inside a unit test. Either way, this test only cares
// that the gate throws before any request lands, so the exact dead address doesn't matter.
process.env.RPC_URL = "http://localhost:1";

import { createChainClient } from "./chain";
import { ARC_CHAIN, ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";

for (const [name, chain] of [["Arc", ARC_CHAIN], ["Robinhood", ROBINHOOD_CHAIN]] as const) {
  const client = createChainClient(chain);
  const e = await client.analyze(WALLET).then(() => null, (err) => err as Error);
  eq(`${name}: a non-allowlisted wallet address is refused`, e !== null, true);
  eq(`${name}: the refusal names the reason, not a network failure`, e?.message.includes("Wallet scanning is restricted"), true);
}

{
  // A malformed input must still get the generic "enter a wallet or tx hash" message,
  // never the wallet-scan refusal — the gate must not swallow every non-tx-hash string.
  const client = createChainClient(ARC_CHAIN);
  const e = await client.analyze("not-an-address").then(() => null, (err) => err as Error);
  eq("a malformed query gets the generic input error", e?.message.includes("Enter a wallet address"), true);
}

for (const [name, chain] of [["Arc", ARC_CHAIN], ["Robinhood", ROBINHOOD_CHAIN]] as const) {
  // An allowlisted address must get PAST the gate on EVERY chain — it will still fail
  // (localhost:1 answers nothing), but on a NETWORK error, never the feature-refusal
  // message. That distinction is the whole point of the allowlist: the gate must not fire
  // for this address, on any chain.
  process.env.WALLET_SCAN_ALLOWLIST = WALLET;
  const client = createChainClient(chain);
  const timeout = new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("test timed out")), 5000));
  const e = await Promise.race([client.analyze(WALLET).then(() => null, (err) => err as Error), timeout]);
  eq(`${name}: an allowlisted address is not refused by the feature gate`, e?.message.includes("Wallet scanning is restricted"), false);
  delete process.env.WALLET_SCAN_ALLOWLIST;
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
