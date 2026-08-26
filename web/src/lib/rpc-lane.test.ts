import type { Transport } from "viem";
import { laned, laneUrl, isLaneMethod, isLaneRequest } from "./rpc-lane";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** A transport that records what it was asked for and answers with its own name. */
function spy(name: string) {
  const methods: unknown[] = [];
  const transport = ((_params: unknown) => ({
    config: { key: name },
    value: undefined,
    request: async (args: { method?: unknown }) => {
      methods.push(args?.method);
      return name;
    },
  })) as unknown as Transport;
  return { name, methods, transport };
}

// ---- laneUrl ----------------------------------------------------------------
{
  eq("tags a plain proxy url", laneUrl("https://site.example/rpc"), "https://site.example/rpc?lane=wallet");
  // A base that already carries a query must keep it — concatenation would produce "?a=1?lane=".
  eq("keeps an existing query", laneUrl("https://site.example/rpc?a=1"), "https://site.example/rpc?a=1&lane=wallet");
  // Overwrite rather than append a second one, so the server never sees two lanes.
  eq("replaces an existing lane", laneUrl("https://site.example/rpc?lane=other"), "https://site.example/rpc?lane=wallet");
  // Node smoke runs point RPC_URL straight at an upstream; a bad value must not throw
  // while a module-level client is being built.
  eq("returns an unparseable base untouched", laneUrl("/rpc"), "/rpc");
}

// ---- which methods take the lane --------------------------------------------
{
  eq("eth_getLogs takes the lane", isLaneMethod("eth_getLogs"), true);
  eq("eth_call does not", isLaneMethod("eth_call"), false);
  eq("eth_getBlockByNumber does not", isLaneMethod("eth_getBlockByNumber"), false);
  // A request with no method at all must not be routed to the paid endpoint by accident.
  eq("a missing method does not", isLaneMethod(undefined), false);
  eq("a non-string method does not", isLaneMethod(42), false);
}

// ---- which REQUESTS take the lane -------------------------------------------
// `eth_call` splits on its block tag rather than on the method. A call pinned to a past
// block is an ARCHIVE read: the public node answers every one of them with
// `-32000 metadata is not found`, which is what leaves a closed position's fee legs
// reading exactly 0 (`~ fees partial`) — v4 #892396's whole +10.04% is fee-growth at its
// mint and exit blocks. A call at the head is not, and those are the bulk of them (token
// symbols and decimals, the current tick), so they stay on the ordinary endpoint.
{
  const call = (blockTag?: unknown) => ({ method: "eth_call", params: [{ to: "0x1", data: "0x2" }, blockTag] });
  eq("a call pinned to a past block takes the lane", isLaneRequest(call("0x2b6b1e4")), true);
  eq("a call at the head does not", isLaneRequest(call("latest")), false);
  eq("nor does one with no block tag at all", isLaneRequest({ method: "eth_call", params: [{ to: "0x1" }] }), false);
  eq("nor pending/safe/finalized", isLaneRequest(call("pending")), false);
  eq("getLogs still takes the lane whatever its params", isLaneRequest({ method: "eth_getLogs", params: [{}] }), true);
  eq("an unrelated method does not", isLaneRequest({ method: "eth_getBlockByNumber", params: ["0x1", false] }), false);
  // Malformed input must never be routed to the paid endpoint by accident.
  eq("a request with no method does not", isLaneRequest({ params: ["0x1"] }), false);
  eq("a call with non-array params does not", isLaneRequest({ method: "eth_call", params: "0x1" }), false);
  eq("undefined does not", isLaneRequest(undefined), false);
}

// ---- routing ----------------------------------------------------------------
{
  const base = spy("default"), lane = spy("lane");
  const t = laned(base.transport, lane.transport)({} as never);

  eq("getLogs goes to the lane", await t.request({ method: "eth_getLogs" } as never), "lane");
  eq("readContract goes to the default", await t.request({ method: "eth_call" } as never), "default");
  eq("blockNumber goes to the default", await t.request({ method: "eth_blockNumber" } as never), "default");
  eq("an archive read goes to the lane", await t.request({ method: "eth_call", params: [{ to: "0x1" }, "0x2b6b1e4"] } as never), "lane");

  eq("the lane saw getLogs and the archive read", lane.methods, ["eth_getLogs", "eth_call"]);
  eq("the default saw the rest", base.methods, ["eth_call", "eth_blockNumber"]);
}

// The transports are built ONCE, at client construction: viem transports carry per-instance
// retry state, and rebuilding one per request would silently discard it.
{
  let built = 0;
  const counting = ((_p: unknown) => { built++; return { config: {}, value: undefined, request: async () => "x" }; }) as unknown as Transport;
  const t = laned(counting, counting)({} as never);
  await t.request({ method: "eth_getLogs" } as never);
  await t.request({ method: "eth_call" } as never);
  eq("transports are instantiated once each, not per request", built, 2);
}

// A custom predicate must be honoured — the routing rule is a default, not a hard-coding.
// It receives the WHOLE request, because `eth_call` is routed on its block tag and a
// predicate given only the method could not express that.
{
  const base = spy("default"), lane = spy("lane");
  const isCall = (r: unknown) => (r as { method?: unknown })?.method === "eth_call";
  const t = laned(base.transport, lane.transport, isCall)({} as never);
  eq("custom predicate routes eth_call", await t.request({ method: "eth_call" } as never), "lane");
  eq("custom predicate leaves getLogs", await t.request({ method: "eth_getLogs" } as never), "default");
}

// Errors from the chosen lane propagate unchanged — the router must not swallow or
// reroute a failure, or a dead paid endpoint would look like a working one.
{
  const boom = ((_p: unknown) => ({
    config: {}, value: undefined,
    request: async () => { throw new Error("upstream exploded"); },
  })) as unknown as Transport;
  const base = spy("default");
  const t = laned(base.transport, boom)({} as never);
  let threw = "";
  try { await t.request({ method: "eth_getLogs" } as never); } catch (e) { threw = (e as Error).message; }
  eq("lane errors propagate", threw, "upstream exploded");
  eq("a lane failure does not fall back to the default", base.methods, []);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
