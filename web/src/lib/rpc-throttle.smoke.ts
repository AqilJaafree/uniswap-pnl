/**
 * Diagnostic-only: cap in-flight RPC requests and retry 429/5xx with backoff.
 * Import this FIRST (before ./chain) — ESM runs module bodies in import order, and
 * ./chain builds its viem client at load time.
 *
 * Why: the public Robinhood RPC rejects heavy parallel fan-out. Unthrottled, whole
 * positions fail and land in `skipped`, which would silently understate any audit.
 */
const MAX_INFLIGHT = Number(process.env.RPC_MAX_INFLIGHT ?? 3);
const MAX_ATTEMPTS = 7;

let inflight = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise<void>((resolve) => waiters.push(() => { inflight++; resolve(); }));
}
function release(): void {
  inflight--;
  waiters.shift()?.();
}

const rawFetch = globalThis.fetch.bind(globalThis);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export let rpcCalls = 0;
export let rpcRetries = 0;

globalThis.fetch = async function throttledFetch(input: any, init?: any): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await acquire();
    let res: Response | undefined;
    try {
      rpcCalls++;
      res = await rawFetch(input, init);
    } catch (e) {
      lastErr = e;
    } finally {
      release();
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (attempt === MAX_ATTEMPTS - 1) break;
    rpcRetries++;
    await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 200));
  }
  if (lastErr) throw lastErr;
  throw new Error("RPC exhausted retries (429/5xx)");
} as typeof fetch;
