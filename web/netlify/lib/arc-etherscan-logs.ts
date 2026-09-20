/**
 * Arc's free RPC tier turns a genesis-to-head, single-address+topic search into hundreds
 * of chunked calls — dRPC caps eth_getLogs at 10,000 blocks/call, QuickNode at 100,000,
 * and Arc is ~21.6M blocks tall after only 3 days of mainnet. `analyzeTx`'s per-tokenId
 * mint search (chain.ts) has no wallet-lane fallback tier to spill that volume to, and it
 * rate-limited BOTH providers in testing (verified live: repeated 429s, from a real
 * browser, on a single tx-hash lookup — see robinhood-v3-lp-pnl memory for the
 * investigation).
 *
 * Etherscan's V2 API (Arc is chainid 5042 there, confirmed live) indexes logs by
 * address+topic rather than scanning block ranges, so the SAME query costs ONE call
 * regardless of chain height — verified against a real, previously-hard-to-find mint
 * (token #50770 on Arc's PositionManager): one call, instant, correct block (21,160,307,
 * properly before the tx that referenced it).
 *
 * This translates a standard eth_getLogs JSON-RPC request into that API and its response
 * back into the standard eth_getLogs result shape, so chain.ts's client.getLogs() call
 * sites need no changes at all — the swap happens entirely server-side, in rpc.ts.
 *
 * Deliberately narrow: only the single-address, non-OR-topics shape every real call site in
 * this app actually uses (see chain.ts's `client.getLogs` calls — all pass one address and
 * plain `args`, never an array topic or multiple addresses). Anything else, or any failure
 * along the way, returns null rather than throwing — the caller falls back to the ordinary
 * RPC upstream chain, which already has its own resilience.
 */

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown[];
}

interface GetLogsParams {
  address?: string;
  topics?: (string | null | undefined)[];
  fromBlock?: string;
  toBlock?: string;
}

interface EtherscanLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  transactionHash: string;
  transactionIndex: string;
}

/** A hex JSON-RPC block tag → the decimal string Etherscan's API expects. Named tags pass through unchanged. */
function toDecimalBlock(tag: string | undefined): string {
  if (tag === undefined) return "latest";
  if (tag === "latest" || tag === "earliest" || tag === "pending") return tag;
  return BigInt(tag).toString(10);
}

/**
 * Builds the query string for a single-address, up-to-4-topic eth_getLogs request. Returns
 * null when the shape isn't one this translation supports (an OR-array topic, or no address
 * at all) — the caller must fall back to the ordinary RPC path.
 */
export function buildEtherscanLogsQuery(reqBody: JsonRpcRequest, apiKey: string): string | null {
  if (reqBody.method !== "eth_getLogs") return null;
  const p = reqBody.params?.[0] as GetLogsParams | undefined;
  if (!p || typeof p.address !== "string") return null;
  const topics = p.topics ?? [];
  if (topics.some((t) => Array.isArray(t))) return null;

  const qs = new URLSearchParams({
    chainid: "5042",
    module: "logs",
    action: "getLogs",
    address: p.address,
    fromBlock: toDecimalBlock(p.fromBlock),
    toBlock: toDecimalBlock(p.toBlock),
    apikey: apiKey,
  });
  // Etherscan requires an explicit AND between every pair of topic positions actually used
  // — topic0_1_opr, topic1_3_opr, etc., named by the two indices being joined, not by how
  // many topics are present. Skipped (null) positions never get an opr naming them.
  let prevIndex: number | null = null;
  topics.forEach((t, i) => {
    if (t === null || t === undefined) return;
    qs.set(`topic${i}`, t);
    if (prevIndex !== null) qs.set(`topic${prevIndex}_${i}_opr`, "and");
    prevIndex = i;
  });
  return qs.toString();
}

/** Etherscan's log shape → the standard eth_getLogs result shape. */
function toStandardLog(l: EtherscanLog) {
  return { ...l, removed: false };
}

/**
 * Fetches via Etherscan's V2 API and returns a ready-to-serve JSON-RPC response body, or
 * null when this request's shape isn't supported, no API key is configured, or the
 * Etherscan call itself failed — any of those falls back to the ordinary RPC upstream
 * chain rather than becoming a thrown error.
 */
export async function tryArcLogsViaEtherscan(
  reqBody: JsonRpcRequest,
  apiKey: string | undefined,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  if (!apiKey) return null;
  const qs = buildEtherscanLogsQuery(reqBody, apiKey);
  if (qs === null) return null;
  try {
    const res = await fetchFn(`https://api.etherscan.io/v2/api?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    // status "0" with an EMPTY-array result means "no matches" (a real answer, not a
    // failure); status "0" with a STRING result is Etherscan's error-message shape (bad
    // key, rate limit, malformed query) and must fall back, not be served as an empty log
    // list — those look identical downstream (`status !== "1"`) without checking the type.
    if (data.status !== "1" && typeof data.result === "string") return null;
    const logs = Array.isArray(data.result) ? data.result.map(toStandardLog) : [];
    return JSON.stringify({ jsonrpc: "2.0", id: reqBody.id ?? null, result: logs });
  } catch {
    return null;
  }
}
