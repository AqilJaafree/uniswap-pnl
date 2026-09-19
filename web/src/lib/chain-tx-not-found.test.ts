/**
 * analyzeTx's receipt-not-found branch (chain.ts). Arc's free public RPC has a confirmed
 * gap in its by-hash tx/receipt index — see chain.ts's comment on this branch. Mocks
 * globalThis.fetch (same technique as rpc-throttle.smoke.ts) so no real network is needed;
 * NODE_RPC picks up process.env.RPC_URL, so the mock URL is never actually dialed.
 */
process.env.RPC_URL = "http://localhost:9/rpc";

import { createChainClient } from "./chain";
import { ARC_CHAIN, ROBINHOOD_CHAIN } from "./uniswap-v3-pnl";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const realFetch = globalThis.fetch;

/** eth_getTransactionReceipt answers null; every other method gets a harmless placeholder. */
function mockNotFoundRpc() {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const result = body.method === "eth_blockNumber" ? "0x1" : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function messageFor(chain: typeof ARC_CHAIN): Promise<string> {
  mockNotFoundRpc();
  try {
    await createChainClient(chain).analyze(TX);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const arcMessage = await messageFor(ARC_CHAIN);
eq("arc: names the tx hash", arcMessage.includes(TX), true);
eq("arc: points at the wallet-scan workaround", arcMessage.includes("wallet address"), true);
eq("arc: does not leak viem's raw wording", arcMessage.includes("could not be found"), false);

const robinhoodMessage = await messageFor(ROBINHOOD_CHAIN);
eq("robinhood: keeps viem's default not-found wording", robinhoodMessage.includes("could not be found"), true);
eq("robinhood: no Arc-specific wording leaks in", robinhoodMessage.includes("Arc"), false);

globalThis.fetch = realFetch;

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
