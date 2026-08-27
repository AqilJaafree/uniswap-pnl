/**
 * Production server for the LP-PnL SPA.
 *
 * Does two jobs from ONE origin, so the browser never makes a cross-site call:
 *   1. serves the static Vite build from ./dist
 *   2. POST /rpc  — a JSON-RPC *spillover* proxy: try the free public RPC first,
 *      fall back to the paid RPC (key injected here, server-side) only when the
 *      public one rate-limits (429), errors (5xx), is unreachable, or says
 *      inside a 200 body that it cannot serve the request (see spillReason).
 *
 * Why a proxy:
 *   - The paid RPC's API key stays server-side — never shipped in the bundle.
 *   - Same-origin /rpc means no CORS at all (the public RPC's Cloudflare layer
 *     emits a duplicated `Access-Control-Allow-Origin: *,*` on throttled
 *     responses, which browsers reject; server-to-server calls don't care).
 *   - Public absorbs ~all traffic; the paid RPC is pure backup → minimal cost.
 *
 * Env:
 *   PORT             — provided by Railway (default 3000)
 *   PUBLIC_RPC_URL   — free/public RPC (default: Robinhood Chain public RPC)
 *   PAID_RPC_URL     — paid RPC incl. API key (optional; used only on spillover)
 *   RPC_TIMEOUT_MS   — per-upstream timeout (default 15000)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(__dirname, "dist");
const PORT = Number(process.env.PORT) || 3000;
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 15000;

const PUBLIC_RPC = process.env.PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const PAID_RPC = process.env.PAID_RPC_URL || "";
// RPC for wallet scans (eth_getLogs). Tried FIRST on /rpc?lane=wallet, then the ordinary
// chain as backup — see the lane note in netlify/edge-functions/rpc.ts, which this mirrors.
const WALLET_RPC = process.env.WALLET_RPC_URL || "";
// Order defines priority: public first (free), paid last (spillover only).
const UPSTREAMS = [PUBLIC_RPC, PAID_RPC].filter(Boolean);
// Same list with the wallet endpoint in front. Built once: the lane only selects between
// these two orders, it never introduces a URL of its own.
const WALLET_UPSTREAMS = [WALLET_RPC, ...UPSTREAMS].filter(Boolean);
// NEVER log a URL — the path of an Alchemy URL is an API key. Labels only.
const labelFor = (list, i) =>
  list[i] === WALLET_RPC ? "wallet" : list[i] === PUBLIC_RPC ? "public" : "paid";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The two 200-bodies that are not answers. Mirrors netlify/lib/spill.ts, which is the
 * tested copy — this file is plain .mjs and cannot import the .ts module, so the rules
 * are duplicated here on purpose. Change them there and change them here too.
 */
function errorsIn(text) {
  try {
    const j = JSON.parse(text);
    return (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === "object" && x.error).map((x) => x.error);
  } catch {
    return [];
  }
}

/** Cheap reject: a successful body has no `error` member, and these bodies are large. */
function mightHoldError(text) {
  return text.includes('"error"');
}

function isRateLimitError(err) {
  if (err.code === -32005 || err.code === -32097) return true; // limit exceeded
  return /rate.?limit|too many|exceeded|quota/i.test(String(err.message || ""));
}

/**
 * "Not me, ever" — a retention or routing fact, not an answer. The public node refuses
 * every archive read this way, at HTTP 200. `execution reverted` is deliberately absent:
 * a revert IS an answer and the next upstream would revert identically.
 */
const UNSERVICEABLE =
  /metadata is not found|missing trie node|header not found|block not found|no state available|state (?:is )?not available|state at block \S+ not found|pruned/i;

/** Why this response must not be treated as the final answer, from one parse. */
function spillReason(text) {
  if (!mightHoldError(text)) return null;
  const errs = errorsIn(text);
  if (!errs.length) return null;
  if (errs.some(isRateLimitError)) return "rate-limit";
  if (errs.some((e) => UNSERVICEABLE.test(String(e.message || "")))) return "unserviceable";
  return null;
}

async function handleRpc(req, res, body, lane = null) {
  // An unknown or absent lane falls through to the ordinary order, and so does the wallet
  // lane when WALLET_RPC_URL is unset — degrade to today's behaviour, never fail the scan.
  const upstreams = lane === "wallet" && WALLET_RPC ? WALLET_UPSTREAMS : UPSTREAMS;
  let lastStatus = 502;
  for (let i = 0; i < upstreams.length; i++) {
    const url = upstreams[i];
    const isLast = i === upstreams.length - 1;
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      lastStatus = upstream.status;
      // HTTP-level throttle/error → spill to next upstream (unless this is the last).
      if (!isLast && (upstream.status === 429 || upstream.status >= 500)) {
        console.warn(`[rpc] ${labelFor(upstreams, i)} → HTTP ${upstream.status}, spilling over`);
        continue;
      }
      const text = await upstream.text();
      // A 200 is not always an answer — a body-level throttle, or a flat "I cannot serve
      // this", both mean try the next upstream. One call, so a megabyte of getLogs output
      // is parsed at most once. See netlify/lib/spill.ts.
      const spill = isLast || upstream.status !== 200 ? null : spillReason(text);
      if (spill) {
        console.warn(`[rpc] ${labelFor(upstreams, i)} → ${spill === "rate-limit" ? "body rate-limit" : "cannot serve this request"}, spilling over`);
        continue;
      }
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
      return;
    } catch (err) {
      console.warn(`[rpc] ${labelFor(upstreams, i)} → ${err?.name || "error"}${isLast ? "" : ", spilling over"}`);
      if (isLast) break;
    }
  }
  res.writeHead(lastStatus >= 400 ? lastStatus : 502, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "all RPC upstreams failed" } }));
}

function readBody(req, limitBytes = 2_000_000) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        rej(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

async function serveStatic(req, res, pathname) {
  // Resolve within DIST and reject traversal.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let s = await stat(filePath).catch(() => null);
    if (s?.isDirectory()) {
      filePath = join(filePath, "index.html");
      s = await stat(filePath).catch(() => null);
    }
    if (!s) {
      // SPA fallback for non-asset routes; 404 for genuinely missing assets.
      if (extname(rel)) {
        res.writeHead(404).end("not found");
        return;
      }
      filePath = join(DIST, "index.html");
    }
    const ext = extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    const isHashedAsset = filePath.startsWith(join(DIST, "assets"));
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end("server error");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/rpc") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end("method not allowed");
      return;
    }
    try {
      const body = await readBody(req);
      await handleRpc(req, res, body, url.searchParams.get("lane"));
    } catch {
      res.writeHead(413).end("payload too large");
    }
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] RPC upstreams: ${UPSTREAMS.map((_, i) => labelFor(UPSTREAMS, i)).join(" → ") || "(none)"}`);
  console.log(`[server] wallet lane: ${WALLET_UPSTREAMS.map((_, i) => labelFor(WALLET_UPSTREAMS, i)).join(" → ") || "(none)"}`);
  if (!PAID_RPC) console.warn("[server] PAID_RPC_URL not set — no spillover backup configured");
  if (!WALLET_RPC) console.warn("[server] WALLET_RPC_URL not set — wallet scans use the ordinary upstreams");
});
