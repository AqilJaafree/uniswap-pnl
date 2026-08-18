/**
 * POST /rpc — JSON-RPC *spillover* proxy (Netlify edge function).
 *
 * This is the Netlify port of the `/rpc` handler in `server.mjs` (the Railway
 * server). Same contract, same order: try the free public RPC first, fall back
 * to the paid RPC — key injected here, server-side — only when the public one
 * rate-limits (429), errors (5xx), is unreachable, or signals a rate limit
 * inside a 200 body.
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
 * Env (set on the Netlify project):
 *   PUBLIC_RPC_URL   — free/public RPC (default: Robinhood Chain public RPC)
 *   PAID_RPC_URL     — paid RPC incl. API key (optional; used only on spillover)
 *   WALLET_RPC_URL   — RPC for wallet scans incl. API key (optional; tried first on
 *                      ?lane=wallet, then the ordinary chain as backup)
 *   RPC_TIMEOUT_MS   — per-upstream timeout (default 15000)
 *
 * NONE of these URLs may be logged. The path of an Alchemy URL is an API key, so every
 * log line below names the LABEL ("public"/"paid"/"wallet") and never the endpoint.
 */
import type { Config, Context } from "@netlify/edge-functions";
import { orderUpstreams } from "./lane-order.ts";

const DEFAULT_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;

/**
 * Read config at request time — edge functions must not hold global logic.
 *
 * The ORDER is decided by orderUpstreams (pure, unit-tested); this function only supplies
 * the environment it reads. None of these values may be logged: see the header.
 */
function upstreams(lane: string | null): { url: string; label: string }[] {
  return orderUpstreams({
    publicRpc: Netlify.env.get("PUBLIC_RPC_URL") || DEFAULT_PUBLIC_RPC,
    paidRpc: Netlify.env.get("PAID_RPC_URL") || "",
    walletRpc: Netlify.env.get("WALLET_RPC_URL") || "",
    lane,
  });
}

function timeoutMs(): number {
  return Number(Netlify.env.get("RPC_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS;
}

/** JSON-RPC rate-limit signalled inside a 200 body (some providers do this). */
function isRateLimitBody(text: string): boolean {
  try {
    const j = JSON.parse(text);
    const err = Array.isArray(j) ? j.find((x) => x && x.error)?.error : j?.error;
    if (!err) return false;
    if (err.code === -32005 || err.code === -32097) return true; // limit exceeded
    return /rate.?limit|too many|exceeded|quota/i.test(String(err.message || ""));
  } catch {
    return false;
  }
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
  const lane = new URL(req.url).searchParams.get("lane");
  const chain = upstreams(lane);
  const ms = timeoutMs();
  let lastStatus = 502;

  for (let i = 0; i < chain.length; i++) {
    const { url, label } = chain[i];
    const isLast = i === chain.length - 1;
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
      // Body-level throttle on a 200 → also spill (unless last).
      if (!isLast && upstream.status === 200 && isRateLimitBody(text)) {
        console.warn(`[rpc] ${label} → body rate-limit, spilling over`);
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
