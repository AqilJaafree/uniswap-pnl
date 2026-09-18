/**
 * `analyze()` must refuse a wallet-address query outright on a chain whose
 * `walletScanSupported` is false (Arc — see uniswap-v3-pnl.ts's ChainConfig), rather than
 * let a genesis-wide NFT-transfer scan run for minutes before failing on a pruning wall or
 * a rate limit. This is a construction-time gate, not a network one: `createChainClient`
 * builds a real viem client but never connects until a request is made, so this file makes
 * NO network call at all — a hang here would mean the gate stopped running before the
 * request, not after it.
 */
// Arc's ChainConfig.rpcUrl is "" (no browser-trusted public URL — the browser always goes
// through /rpc). In this Node test context that leaves viem's http() transport with no URL
// at all, which throws at CLIENT CONSTRUCTION rather than at request time. A placeholder is
// enough: the whole point of this file is that `analyze()` throws before any request is
// ever attempted, so this URL is never dialed.
process.env.RPC_URL = "http://localhost:1";

import { createChainClient } from "./chain";
import { ARC_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";

{
  const client = createChainClient(ARC_CHAIN);
  const e = await client.analyze(WALLET).then(() => null, (err) => err as Error);
  eq("a wallet address on Arc is refused", e !== null, true);
  eq("the refusal names the reason, not a network failure", e?.message.includes("Wallet scanning isn't available"), true);
}

{
  // A malformed input must still get the generic "enter a wallet or tx hash" message,
  // never the wallet-scan refusal — the gate must not swallow every non-tx-hash string.
  const client = createChainClient(ARC_CHAIN);
  const e = await client.analyze("not-an-address").then(() => null, (err) => err as Error);
  eq("a malformed query gets the generic input error", e?.message.includes("Enter a wallet address"), true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
