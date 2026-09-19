/**
 * Regression test: a wallet's v4-position enumeration (analyzeWalletV4Positions in
 * chain.ts) used to query eth_getLogs with a hardcoded `fromBlock: 0n`. Robinhood's RPC
 * has no retention limit, so this was invisible there, but Arc's does — a genesis-to-head
 * query gets refused outright as "pruned history unavailable", which getLogsChunked does
 * not know how to split (it only recognizes the "too many results"/timeout shape), so the
 * error propagated all the way up and failed the entire wallet scan before a single
 * position could be read. Fixed by resolving the RPC's actual retention floor first (the
 * same `resolveGenesisFloor` mechanism `ownershipLogs` already used) instead of naming
 * `0n` directly.
 *
 * Mocks globalThis.fetch (same technique as rpc-throttle.smoke.ts) to reproduce Arc's real
 * response shape for a pruned range — an HTTP 200 with a JSON-RPC-level error — rather
 * than a live RPC round trip.
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
const HEAD = "0x100"; // 256
const realFetch = globalThis.fetch;

let genesisLogsQueries = 0;

globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const respond = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const respondError = (code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code, message } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (body.method === "eth_blockNumber") return respond(HEAD);
  if (body.method === "eth_getLogs") {
    const fromBlock = body.params?.[0]?.fromBlock;
    if (fromBlock === "0x0") {
      genesisLogsQueries++;
      // Arc's real Blockdaemon RPC's exact response shape for this — verified live.
      return respondError(4444, "pruned history unavailable");
    }
    return respond([]);
  }
  return respond([]);
}) as typeof fetch;

let threw: string | null = null;
try {
  await createChainClient(ARC_CHAIN).analyze(WALLET, () => {});
} catch (e) {
  threw = (e as Error).message;
}

globalThis.fetch = realFetch;

eq("the genesis (fromBlock 0) query was attempted at least once", genesisLogsQueries > 0, true);
eq("the wallet scan survives a pruned genesis range instead of throwing", threw, null);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
