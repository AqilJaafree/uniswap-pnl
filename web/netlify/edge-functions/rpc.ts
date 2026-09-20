/**
 * POST /rpc — JSON-RPC *spillover* proxy (Netlify edge function).
 *
 * This is the Netlify port of the `/rpc` handler in `server.mjs` (the Railway
 * server). Same contract, same order: try the free public RPC first, fall back
 * to the paid RPC — key injected here, server-side — only when the public one
 * rate-limits (429), errors (5xx), is unreachable, signals a rate limit inside a
 * 200 body, or says inside a 200 body that it cannot serve the request at all
 * (see isUnserviceableBody in ../lib/spill.ts — this chain's public node refuses
 * every archive read that way, and treating it as an answer is what silently
 * turned unreadable state into wrong PnL numbers).
 *
 * Why a proxy (unchanged from server.mjs):
 *   - The paid RPC's API key stays server-side — never shipped in the bundle.
 *   - Same-origin /rpc means no CORS at all (the public RPC's Cloudflare layer
 *     emits a duplicated `Access-Control-Allow-Origin: *,*` on throttled
 *     responses, which browsers reject; server-to-server calls don't care).
 *   - Public absorbs ~all traffic; the paid RPC is pure backup → minimal cost.
 *
 * Why an EDGE function rather than a serverless one: this handler is pure I/O.
 * Netlify's 50ms CPU budget excludes time awaiting fetch, and the 40s
 * response-header timeout comfortably clears RPC_TIMEOUT_MS. A synchronous
 * serverless function would cap at 10s — below the 15s upstream timeout the
 * app's wide `getLogs` calls rely on.
 *
 * Lanes: a POST to /rpc?lane=wallet is a WALLET SCAN — in practice eth_getLogs, which is
 * what a wallet analysis is made of (a full-range query per position, each able to split
 * into a cascade of halved ranges). Those get WALLET_RPC_URL first when it is set, so the
 * expensive traffic does not spend the free endpoint's budget and then arrive at the paid
 * one only after being refused. Everything else keeps the plain public-first order. The
 * lane is chosen by the browser but the ENDPOINT is chosen here: the client sends the word
 * "wallet", never a URL.
 *
 * Subject gate: EVERY non-public upstream — the wallet tier above AND the ordinary
 * paid-spillover fallback — additionally requires ?subject=<address> to name an address in
 * WALLET_SCAN_ALLOWLIST (see ../lib/wallet-lane-gate.ts). This is a public, unauthenticated
 * tool; without this, anonymous traffic could freely spend a paid budget meant for a
 * handful of known test wallets. A request with no subject, or one not on the list, is
 * restricted to the free public endpoint ONLY — no wallet tier, no paid fallback on a
 * public failure either. The subject is client-declared, not signed or verified as owned
 * by the caller — the same trust level as the client's own allowlist gate (see
 * web/src/lib/wallet-scan-allowlist.ts): these are known test addresses, not secrets, and
 * this is authorization-by-declaration, not authentication.
 *
 * Env (set on the Netlify project):
 *   PUBLIC_RPC_URL   — free/public RPC (default: Robinhood Chain public RPC)
 *   PAID_RPC_URL     — paid RPC incl. API key (optional; used only on spillover)
 *   WALLET_RPC_URL   — RPC for wallet scans incl. API key (optional; tried first on
 *                      ?lane=wallet, then the ordinary chain as backup)
 *   WALLET_SCAN_ALLOWLIST — comma-separated addresses allowed to reach PAID_RPC_URL /
 *                      WALLET_RPC_URL / ARC_PAID_RPC_URL / ARC_WALLET_RPC_URL at all, via
 *                      ?subject=. Unset means NOBODY reaches a paid upstream, on any chain.
 *   RPC_TIMEOUT_MS   — per-upstream timeout (default 15000)
 *   ARC_RPC_URL      — Arc public/free RPC. NO DEFAULT — an unset value returns a
 *                      distinct "not configured" error rather than guessing an endpoint.
 *                      Was Blockdaemon's node (rpc.blockdaemon.mainnet.arc.io), which had a
 *                      by-hash tx/receipt index gap wide enough to fail 100% of a real
 *                      wallet's positions. Swapped 2026-09-19 to QuickNode: a per-tokenId
 *                      genesis-to-head mint search (analyzeTx's v4 path, chain.ts) never
 *                      attaches a wallet-lane subject, so it can NEVER spill to
 *                      ARC_WALLET_RPC_URL/ARC_PAID_RPC_URL — whatever sits here is the ONLY
 *                      thing that search ever reaches, and it matters which: dRPC's free
 *                      tier caps eth_getLogs at 10,000 blocks per call (~2160+ calls across
 *                      Arc's ~21.6M blocks), QuickNode's at 100,000 (~216) — 10x fewer
 *                      requests for the exact path that has no fallback tier to spill to.
 *   ARC_PAID_RPC_URL — Arc paid RPC incl. API key (optional; spillover only) — dRPC.
 *   ARC_WALLET_RPC_URL — Arc RPC for wallet scans incl. API key (optional) — dRPC.
 *   ETHERSCAN_API_KEY — free Etherscan V2 API key. MUST be set as a PLAIN (non-secret) env
 *                      var — marking it secret made the Netlify MCP write silently no-op
 *                      (the key never actually landed; getAllEnvVars simply omitted it,
 *                      with no error). It's a free-tier key with no billing/wallet access,
 *                      so plain is an acceptable trade for actually working. When set, an
 *                      Arc `eth_getLogs` call in the single-address, non-OR-topics shape
 *                      every real call site uses (see ../lib/arc-etherscan-logs.ts) is
 *                      answered from Etherscan's address+topic INDEX instead of a ranged
 *                      RPC scan — one call regardless of chain height, sidestepping both
 *                      free RPC tiers' block-range caps (and the rate limits that volume
 *                      tripped) entirely. Any unsupported shape, or any failure on
 *                      Etherscan's side, falls through to the ordinary upstream chain below
 *                      unchanged — this is pure upside
 *                      when it works and a no-op when it doesn't.
 *
 * NONE of these URLs may be logged. The path of an Alchemy URL is an API key, so every
 * log line below names the LABEL ("public"/"paid"/"wallet") and never the endpoint.
 */
import type { Config, Context } from "@netlify/edge-functions";
import { resolveChainUpstreams } from "../lib/chain-upstreams.ts";
import { spillReason } from "../lib/spill.ts";
import { restrictUpstreams } from "../lib/wallet-lane-gate.ts";
import type { Upstream } from "../lib/lane-order.ts";
import { tryArcLogsViaEtherscan } from "../lib/arc-etherscan-logs.ts";

const DEFAULT_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;

/**
 * Read config at request time — edge functions must not hold global logic.
 *
 * WHICH env vars to read (Robinhood vs. Arc) and the ORDER once the URLs are known are
 * both decided by resolveChainUpstreams (pure, unit-tested); this function only supplies
 * the environment it reads. None of these values may be logged: see the header.
 */
function upstreams(lane: string | null, chain: string | null): Upstream[] | null {
  const env = {
    PUBLIC_RPC_URL: Netlify.env.get("PUBLIC_RPC_URL"),
    PAID_RPC_URL: Netlify.env.get("PAID_RPC_URL"),
    WALLET_RPC_URL: Netlify.env.get("WALLET_RPC_URL"),
    ARC_RPC_URL: Netlify.env.get("ARC_RPC_URL"),
    ARC_PAID_RPC_URL: Netlify.env.get("ARC_PAID_RPC_URL"),
    ARC_WALLET_RPC_URL: Netlify.env.get("ARC_WALLET_RPC_URL"),
  };
  return resolveChainUpstreams(chain, env, lane, DEFAULT_PUBLIC_RPC);
}

function timeoutMs(): number {
  return Number(Netlify.env.get("RPC_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  // The lane is a hint about WHICH POOL of endpoints to prefer, never an endpoint itself,
  // so an unknown or absent value simply falls through to the ordinary order.
  const reqUrl = new URL(req.url);
  const lane = reqUrl.searchParams.get("lane");
  const chainParam = reqUrl.searchParams.get("chain");
  const subject = reqUrl.searchParams.get("subject");
  const resolved = upstreams(lane, chainParam);
  if (resolved === null) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${chainParam} chain not configured` } }),
      { status: 501, headers: JSON_HEADERS },
    );
  }

  // Arc only: try Etherscan's indexed log API before ever touching a ranged-RPC upstream —
  // see the header's ETHERSCAN_API_KEY entry. A batch request (a JSON array, no top-level
  // `.method`) or any shape tryArcLogsViaEtherscan doesn't support falls through untouched.
  if (chainParam === "arc") {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { /* not JSON — fall through */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const viaEtherscan = await tryArcLogsViaEtherscan(
        parsed as { method?: string; id?: unknown; params?: unknown[] },
        Netlify.env.get("ETHERSCAN_API_KEY"),
        fetch,
        timeoutMs(),
      );
      if (viaEtherscan !== null) return new Response(viaEtherscan, { status: 200, headers: JSON_HEADERS });
    }
  }

  // See the header's "Subject gate": drops every non-public upstream unless `subject` is
  // on WALLET_SCAN_ALLOWLIST. Applied AFTER lane ordering so an allowlisted wallet keeps
  // the wallet-first order, and a non-allowlisted one loses the wallet tier entirely
  // rather than merely being reordered behind it.
  const chainUpstreams = restrictUpstreams(resolved, subject, Netlify.env.get("WALLET_SCAN_ALLOWLIST"));
  const ms = timeoutMs();
  let lastStatus = 502;

  for (let i = 0; i < chainUpstreams.length; i++) {
    const { url, label } = chainUpstreams[i];
    const isLast = i === chainUpstreams.length - 1;
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(ms),
      });
      lastStatus = upstream.status;
      // HTTP-level throttle/error → spill to next upstream (unless this is the last).
      if (!isLast && (upstream.status === 429 || upstream.status >= 500)) {
        console.warn(`[rpc] ${label} → HTTP ${upstream.status}, spilling over`);
        continue;
      }
      const text = await upstream.text();
      // A 200 is not always an answer. Two bodies mean "try someone else":
      //   rate-limit     — a throttle signalled in the body rather than the status
      //   unserviceable  — "I cannot serve this at all". The public node refuses every
      //                    archive read this way (`-32000 metadata is not found`, at HTTP
      //                    200), and without this the chain STOPS HERE: the request never
      //                    reaches the archive upstream behind it, and the browser gets a
      //                    hard error for a read it had every right to expect. See
      //                    ../lib/spill.ts for why that error then becomes a wrong number
      //                    rather than a visible failure.
      // One call, so the body — often megabytes of getLogs output — is parsed at most once.
      const spill = isLast || upstream.status !== 200 ? null : spillReason(text);
      if (spill) {
        console.warn(`[rpc] ${label} → ${spill === "rate-limit" ? "body rate-limit" : "cannot serve this request"}, spilling over`);
        continue;
      }
      return new Response(text, { status: upstream.status, headers: JSON_HEADERS });
    } catch (err) {
      const name = (err as Error)?.name || "error";
      console.warn(`[rpc] ${label} → ${name}${isLast ? "" : ", spilling over"}`);
      if (isLast) break;
    }
  }

  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "all RPC upstreams failed" } }),
    { status: lastStatus >= 400 ? lastStatus : 502, headers: JSON_HEADERS },
  );
};

export const config: Config = {
  path: "/rpc",
};
