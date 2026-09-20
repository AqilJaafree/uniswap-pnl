import { buildEtherscanLogsQuery, tryArcLogsViaEtherscan } from "./arc-etherscan-logs";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);
const TOKEN_ID_TOPIC = "0x" + "c652".padStart(64, "0");
const POSM_V4 = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";

// ---- buildEtherscanLogsQuery: query shape --------------------------------------------

{
  const q = buildEtherscanLogsQuery(
    { method: "eth_getLogs", params: [{ address: POSM_V4, topics: [TRANSFER_TOPIC0, ZERO_TOPIC, null, TOKEN_ID_TOPIC], fromBlock: "0x0", toBlock: "0x1451300" }] },
    "KEY",
  );
  const params = new URLSearchParams(q ?? "");
  eq("chainid is Arc's", params.get("chainid"), "5042");
  eq("module/action target the log index", `${params.get("module")}/${params.get("action")}`, "logs/getLogs");
  eq("address passes through", params.get("address"), POSM_V4);
  eq("hex fromBlock becomes decimal", params.get("fromBlock"), "0");
  eq("hex toBlock becomes decimal", params.get("toBlock"), (0x1451300).toString(10));
  eq("topic0 set", params.get("topic0"), TRANSFER_TOPIC0);
  eq("topic1 set (the zero 'from' filter)", params.get("topic1"), ZERO_TOPIC);
  eq("topic2 skipped — no opr naming it on either side", params.has("topic2"), false);
  eq("topic3 set (the tokenId filter)", params.get("topic3"), TOKEN_ID_TOPIC);
  eq("opr joins topic0 to topic1 (adjacent used positions)", params.get("topic0_1_opr"), "and");
  eq("opr joins topic1 to topic3 (skipping the unused topic2)", params.get("topic1_3_opr"), "and");
  eq("no opr invents a link through the skipped topic2", params.has("topic2_3_opr"), false);
}

eq("wrong method returns null", buildEtherscanLogsQuery({ method: "eth_blockNumber", params: [] }, "KEY"), null);
eq("missing address returns null", buildEtherscanLogsQuery({ method: "eth_getLogs", params: [{ topics: [] }] }, "KEY"), null);
eq(
  "an OR-array topic returns null (unsupported shape, not this app's — falls back)",
  buildEtherscanLogsQuery({ method: "eth_getLogs", params: [{ address: POSM_V4, topics: [[TRANSFER_TOPIC0, ZERO_TOPIC]] }] }, "KEY"),
  null,
);

// ---- tryArcLogsViaEtherscan: end-to-end response translation -------------------------

const mintRequest = { jsonrpc: "2.0", id: 7, method: "eth_getLogs", params: [{ address: POSM_V4, topics: [TRANSFER_TOPIC0, ZERO_TOPIC, null, TOKEN_ID_TOPIC], fromBlock: "0x0", toBlock: "0x1451300" }] };

// Captured verbatim from the live API (token #50770's real mint on Arc) — see the module
// header. Verifies the translation against Etherscan's ACTUAL shape, not a guessed one.
const REAL_ETHERSCAN_RESPONSE = {
  status: "1",
  message: "OK",
  result: [{
    address: POSM_V4,
    topics: [TRANSFER_TOPIC0, ZERO_TOPIC, "0x0000000000000000000000007e995decc404633cf2889968537d723c55ffea2c", TOKEN_ID_TOPIC],
    data: "0x",
    blockNumber: "0x142e173",
    blockHash: "0xb1f60c48ba97c0db4afcaf737407b745d4f76315ab37bcc4acab412f7f342592",
    timeStamp: "0x6aaa9186",
    gasPrice: "0x54f3f62285",
    gasUsed: "0x32e79",
    logIndex: "0x34",
    transactionHash: "0xc84a369b8fdf476ae08c4e04aa4e1493a19858a4f097cde7ddc6fb73f3ea76a0",
    transactionIndex: "0xf",
  }],
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

{
  const out = await tryArcLogsViaEtherscan(mintRequest, "KEY", fakeFetch(200, REAL_ETHERSCAN_RESPONSE), 5000);
  const parsed = out ? JSON.parse(out) : null;
  eq("wraps as a proper JSON-RPC envelope", parsed?.jsonrpc, "2.0");
  eq("carries the caller's id through", parsed?.id, 7);
  eq("returns exactly one log", parsed?.result?.length, 1);
  eq("the log keeps its real block number", parsed?.result?.[0]?.blockNumber, "0x142e173");
  eq("removed:false is synthesized (Etherscan doesn't send it)", parsed?.result?.[0]?.removed, false);
}

eq("no API key configured → null (falls back)", await tryArcLogsViaEtherscan(mintRequest, undefined, fakeFetch(200, REAL_ETHERSCAN_RESPONSE), 5000), null);

eq(
  "unsupported request shape → null before ever calling fetch",
  await tryArcLogsViaEtherscan({ method: "eth_blockNumber", params: [] }, "KEY", (() => { throw new Error("must not be called"); }) as unknown as typeof fetch, 5000),
  null,
);

eq(
  "a genuine 'no matches' answer (empty array, status 1) is served, not mistaken for a failure",
  await tryArcLogsViaEtherscan(mintRequest, "KEY", fakeFetch(200, { status: "1", message: "No records found", result: [] }), 5000).then((r) => r && JSON.parse(r).result),
  [],
);

eq(
  "an Etherscan ERROR (status 0, string result — bad key / rate limit) falls back, not served as empty",
  await tryArcLogsViaEtherscan(mintRequest, "KEY", fakeFetch(200, { status: "0", message: "NOTOK", result: "Max rate limit reached" }), 5000),
  null,
);

eq(
  "a non-OK HTTP status falls back",
  await tryArcLogsViaEtherscan(mintRequest, "KEY", fakeFetch(500, {}), 5000),
  null,
);

eq(
  "a thrown fetch (network error, timeout) falls back rather than propagating",
  await tryArcLogsViaEtherscan(mintRequest, "KEY", (() => { throw new Error("network down"); }) as unknown as typeof fetch, 5000),
  null,
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
