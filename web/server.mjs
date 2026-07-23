/**
 * Production server for the LP-PnL SPA.
 *
 * Does two jobs from ONE origin, so the browser never makes a cross-site call:
 *   1. serves the static Vite build from ./dist
 *   2. POST /rpc  — a JSON-RPC *spillover* proxy: try the free public RPC first,
 *      fall back to the paid RPC (key injected here, server-side) only when the
 *      public one rate-limits (429), errors (5xx), or is unreachable.
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
// Order defines priority: public first (free), paid last (spillover only).
const UPSTREAMS = [PUBLIC_RPC, PAID_RPC].filter(Boolean);
const labelOf = (i) => (UPSTREAMS[i] === PUBLIC_RPC ? "public" : "paid");

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

/** JSON-RPC rate-limit signalled inside a 200 body (some providers do this). */
function isRateLimitBody(text) {
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

async function handleRpc(req, res, body) {
  let lastStatus = 502;
  for (let i = 0; i < UPSTREAMS.length; i++) {
    const url = UPSTREAMS[i];
    const isLast = i === UPSTREAMS.length - 1;
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
        console.warn(`[rpc] ${labelOf(i)} → HTTP ${upstream.status}, spilling over`);
        continue;
      }
      const text = await upstream.text();
      // Body-level throttle on a 200 → also spill (unless last).
      if (!isLast && upstream.status === 200 && isRateLimitBody(text)) {
        console.warn(`[rpc] ${labelOf(i)} → body rate-limit, spilling over`);
        continue;
      }
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
      return;
    } catch (err) {
      console.warn(`[rpc] ${labelOf(i)} → ${err?.name || "error"}${isLast ? "" : ", spilling over"}`);
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
      await handleRpc(req, res, body);
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
  console.log(`[server] RPC upstreams: ${UPSTREAMS.map((_, i) => labelOf(i)).join(" → ") || "(none)"}`);
  if (!PAID_RPC) console.warn("[server] PAID_RPC_URL not set — no spillover backup configured");
});
