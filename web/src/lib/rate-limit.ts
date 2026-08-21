/**
 * Honouring this RPC's rate limit, instead of treating it as a failed request.
 *
 * The public endpoint answers a burst with `429 Rate Limit Hit, limit will reset in 60
 * seconds`. viem retries it twice, 300ms apart, and then throws — so a limit that clears
 * in a minute ends a scan in under a second, and every position still unread is reported
 * as unreadable. That is not a chain fact; it is a client that would not wait.
 *
 * Two pieces, both pure enough to unit-test without a chain:
 *
 *   rateLimitWaitMs  is this error a rate limit, and how long does it say to wait
 *   createRateLimitGate  ONE pause, shared by every in-flight request
 *
 * The gate is shared on purpose. Per-request backoff would have every one of the eight
 * in-flight calls sleep its own minute and then resume together, re-tripping the limit
 * immediately. One gate means the first 429 pauses everybody, and the endpoint gets the
 * quiet window it asked for.
 */

/** Rate limits say so in words; the status code is on `code` for viem, `status` for fetch. */
const SAYS_RATE_LIMIT = /\brate.?limit|too many requests|\b429\b/i;
/** "limit will reset in 60 seconds" — the endpoint tells us exactly how long to wait. */
const RESET_IN = /reset[^0-9]{0,24}?(\d+)\s*(ms|millisecond|second|sec|minute|min)/i;

/** When the endpoint names no interval. Long enough to be a real pause, short enough to retry. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 15_000;

function textOf(e: unknown): string {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return `${err?.details ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
}

/**
 * Milliseconds to wait, or null when this is not a rate limit at all.
 *
 * Returns a number for a rate limit WITHOUT a stated interval too — the caller still has
 * to wait, it just has to guess. Null means "not my problem, rethrow".
 */
export function rateLimitWaitMs(e: unknown): number | null {
  const err = e as { code?: unknown; status?: unknown };
  const text = textOf(e);
  const byCode = err?.code === 429 || err?.status === 429;
  if (!byCode && !SAYS_RATE_LIMIT.test(text)) return null;

  const m = RESET_IN.exec(text);
  if (!m) return DEFAULT_RATE_LIMIT_WAIT_MS;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RATE_LIMIT_WAIT_MS;
  const unit = m[2].toLowerCase();
  const ms = unit.startsWith("m") && unit !== "min" && unit !== "minute" ? n
    : unit.startsWith("min") ? n * 60_000
    : n * 1000;
  // A stated interval of zero still needs a beat, or the retry lands inside the same window.
  return ms > 0 ? ms : DEFAULT_RATE_LIMIT_WAIT_MS;
}

export interface RateLimitGate {
  /** Resolves once the shared pause has elapsed. Free when there is no pause. */
  wait(): Promise<void>;
  /** Report a rate limit; extends the shared pause, never shortens it. */
  note(waitMs: number): void;
  /** Epoch ms the pause runs to, for tests and for anything that wants to show it. */
  resumeAt(): number;
}

export function createRateLimitGate(opts: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
} = {}): RateLimitGate {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A ceiling, because the interval comes from the endpoint: a malformed or hostile
  // "reset in 86400 seconds" must not park the whole app for a day.
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  let resumeAt = 0;

  return {
    resumeAt: () => resumeAt,
    note(waitMs: number) {
      resumeAt = Math.max(resumeAt, now() + Math.min(Math.max(waitMs, 0), maxWaitMs));
    },
    async wait() {
      // Re-read each time: another request can extend the pause while this one sleeps,
      // and waking early would put it straight back into the limit.
      for (let left = resumeAt - now(); left > 0; left = resumeAt - now()) await sleep(left);
    },
  };
}
