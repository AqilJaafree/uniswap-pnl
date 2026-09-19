/**
 * Regression test for the wallet-lane subject tag dropping the HTTP method/body.
 *
 * viem's http() transport treats onFetchRequest's return value as the ENTIRE fetch()
 * init when it returns anything at all (the merge-with-init fallback only runs when the
 * hook returns undefined — see node_modules/viem/_esm/utils/rpc/http.js). Returning a bare
 * `{ url }` from taggedRequest (chain.ts) silently downgraded every allowlisted wallet
 * scan's very first call to a bodyless GET, which /rpc's POST-only check 405s. Mocks
 * globalThis.fetch (same technique as rpc-throttle.smoke.ts) to inspect the actual init
 * object viem hands to fetch, rather than relying on a live server round trip.
 */
process.env.RPC_URL = "http://localhost:9/rpc";
process.env.WALLET_SCAN_ALLOWLIST = "0x7e995decc404633CF2889968537D723c55ffEA2C";

import { createChainClient } from "./chain";
import { ARC_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";
const realFetch = globalThis.fetch;
const seen: { url: string; init: RequestInit }[] = [];

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  seen.push({ url: String(url), init: init ?? {} });
  const parsed = init?.body ? JSON.parse(String(init.body)) : { id: 1, method: "" };
  // A wallet scan fans out well past this one call; a single canned "no results" answer
  // for everything downstream is enough to prove the FIRST call went out correctly —
  // that's the one this bug broke, unconditionally, on every wallet scan.
  const result = parsed.method === "eth_blockNumber" ? "0x1" : [];
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  await createChainClient(ARC_CHAIN).analyze(WALLET, () => {});
} catch {
  // The wallet scan may well fail further down (no real chain behind this mock) — all
  // that matters here is what the FIRST request's url/init looked like.
}

globalThis.fetch = realFetch;

eq("at least one tagged request went out", seen.length > 0, true);
const first = seen[0];
eq("subject is attached to the URL (proves the tag actually ran)", first.url.includes(`subject=${WALLET}`), true);
eq("method survives the subject tag (was silently dropped to GET)", first.init.method, "POST");
eq("body survives the subject tag (was silently dropped to undefined)", typeof first.init.body, "string");
eq("body is still the eth_blockNumber call, not lost", JSON.parse(String(first.init.body)).method, "eth_blockNumber");

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
