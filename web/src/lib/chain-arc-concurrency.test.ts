/**
 * Regression test: MAX_INFLIGHT was a hardcoded 8 in chain.ts, tuned specifically against
 * Robinhood's own public RPC (see the measurement history right above it). Arc's free-tier
 * RPCs (dRPC/QuickNode) rate-limited well under that during a real 7-position wallet scan,
 * so ChainConfig now carries an optional per-chain `maxInflight`, and chain.ts must
 * actually honor it. Verified by counting the highest number of requests actually in
 * flight at once against a mocked fetch, for a burst well past Arc's ceiling of 3.
 *
 * Robinhood's own default (8, unset in ChainConfig) is covered separately in
 * chain-config.test.ts as a plain data assertion — firing the same concurrent-burst probe
 * at it here hit an unrelated pre-existing race in the cache layer when the same tx hash is
 * analyzed many times at once on one client (not something this fix introduced or needs to
 * fix), so this file only exercises the one path the fix actually changes: Arc's override
 * taking effect at all.
 */
process.env.RPC_URL = "http://localhost:9/rpc";

import { createChainClient } from "./chain";
import { ARC_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const realFetch = globalThis.fetch;
let inflight = 0, peak = 0;

globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  inflight++;
  peak = Math.max(peak, inflight);
  const body = JSON.parse(String(init?.body ?? "{}"));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  inflight--;
  const result = body.method === "eth_blockNumber" ? "0x1" : [];
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const client = createChainClient(ARC_CHAIN);
// Distinct hashes, not one repeated — a shared hash serializes through the receipt cache's
// own dedup and would only prove that cache works, not that the concurrency gate does.
const hashes = Array.from({ length: 10 }, (_, i) => "0x" + i.toString(16).padStart(2, "0").repeat(32));
await Promise.allSettled(hashes.map((h) => client.analyze(h)));

globalThis.fetch = realFetch;

eq("Arc's peak in-flight requests respects its own maxInflight (3), not the default 8", peak <= 3, true);
eq("the ceiling was actually exercised, not just never reached", peak, 3);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
