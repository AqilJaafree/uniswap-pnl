/**
 * A shared rate budget, for an API that counts requests per minute rather than
 * concurrent ones.
 *
 * GeckoTerminal's free tier allows ~30 calls/minute. The volume layer used to bound
 * CONCURRENCY instead, which is not the same quantity and does not bound this one: two
 * in flight at ~200ms each is 300-400 calls/minute, an order of magnitude over. What
 * happens then is worth spelling out, because it does not look like a rate limit from
 * the browser:
 *
 *   light burst      the API answers 429 WITH `access-control-allow-origin: *`
 *   sustained abuse  Cloudflare answers 429 with NO such header
 *
 * The second one never reaches JavaScript. `fetch` rejects with an opaque TypeError, the
 * console says "blocked by CORS policy", and a handler that switches on `res.status`
 * never runs -- so every pool is reported as unreadable and the cause is misfiled as a
 * network fault. Staying under the limit is the only fix; detecting it afterwards is not.
 *
 * The arithmetic is pure and the clock is a parameter, so the waiting can be tested
 * without any actual waiting -- see token-bucket.test.ts.
 */

export interface BucketState {
  /** Whole and fractional tokens available as of `at`. */
  tokens: number;
  /** The moment `tokens` was accurate. May be in the FUTURE, once reserved ahead. */
  at: number;
}

export function bucketState(burst: number, now = 0): BucketState {
  return { tokens: burst, at: now };
}

/**
 * Take one token, and say how long the caller must wait before spending it.
 *
 * The returned state has the token REMOVED even when the wait is non-zero -- the slot is
 * reserved, not merely predicted. That is what makes this safe for concurrent callers:
 * fifty of them taking at once get fifty different wait times, spread across two minutes,
 * instead of fifty identical ones that all fire together and re-trip the limit. It is the
 * same lesson as the RPC gate in rate-limit.ts, from the other direction.
 */
export function takeToken(
  state: BucketState,
  now: number,
  perMinute: number,
  burst: number,
): { waitMs: number; state: BucketState } {
  const perMs = perMinute / 60_000;
  // The frontier: the later of `now` and the moment the bucket is already reserved to.
  // Never refill backwards -- `at` is ahead of `now` whenever a previous caller reserved
  // into the future, and elapsed time is zero from that reservation's point of view.
  const frontier = Math.max(now, state.at);
  const tokens = Math.min(burst, state.tokens + (frontier - state.at) * perMs);
  // Every wait returned here is measured from NOW, not from the frontier. Measuring it
  // from the frontier is the bug this was first written with, and its unit test caught:
  // each of N queued callers was told to wait one token's worth, so they all woke within
  // the same instant and the burst the bucket exists to prevent happened anyway.
  const untilFrontier = frontier - now;

  if (tokens >= 1) return { waitMs: untilFrontier, state: { tokens: tokens - 1, at: frontier } };

  // Short by this much; a token arrives at exactly this rate.
  const extra = Math.ceil((1 - tokens) / perMs);
  return { waitMs: untilFrontier + extra, state: { tokens: 0, at: frontier + extra } };
}

export interface Bucket {
  /** Resolves when this caller is allowed to make its request. */
  take(): Promise<void>;
  /** How long a `take()` right now would have to wait. For progress copy. */
  waitMs(): number;
  /**
   * Halve the rate, down to the floor. Returns the new rate.
   *
   * Because the published limit is not the real one. Measured against GeckoTerminal:
   * pacing at 25/min, under their documented ~30/min, still drew intermittent refusals.
   * A number picked in advance cannot be right for a provider whose real allowance
   * varies with load, with the endpoint, and with how much you have already asked for —
   * so the only reliable source for it is the provider's own refusals.
   */
  slow(): number;
  /**
   * Report a clean response. After a RUN of them the rate climbs back toward the ceiling.
   *
   * Without this the bucket is a one-way ratchet: one refusal in the first ten seconds of
   * a scan halves the rate for the entire life of the page, a second halves it again, and
   * it sits at the floor for the next ten minutes with the provider answering everything
   * happily. Measured: a 20-pool volume run settled at 6/min from a ceiling of 20 and took
   * 247s. Halving on refusal is only half a control loop.
   *
   * Additive increase, multiplicative decrease — the same shape TCP uses, and the same one
   * the RPC gate in rate-limit.ts arrived at: back off fast, recover slowly, and only on
   * evidence. A run rather than a single success, because the request right after a
   * refusal succeeding proves very little.
   */
  ok(): void;
  /** The current rate, per minute. */
  rate(): number;
}

/**
 * The async wrapper. `sleep` and `now` are injectable for tests; nothing else here is
 * worth a seam.
 */
export function tokenBucket(opts: {
  perMinute: number;
  burst?: number;
  /** Never slow below this, however many refusals arrive. */
  floorPerMinute?: number;
  /** Clean responses in a row before the rate widens. */
  recoverAfter?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Bucket {
  // The opening rate is also the CEILING: recovery climbs back to it and never past it.
  const ceiling = opts.perMinute;
  let perMinute = ceiling;
  const floor = opts.floorPerMinute ?? Math.max(1, Math.round(ceiling / 4));
  const recoverAfter = opts.recoverAfter ?? 5;
  const step = ceiling / 4;
  let clean = 0;
  const burst = opts.burst ?? Math.max(1, Math.min(perMinute, 5));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state = bucketState(burst, now());

  return {
    async take() {
      // Reserve SYNCHRONOUSLY, before the first await: two callers that both read the
      // state and then both write it would hand out the same slot twice.
      const { waitMs, state: next } = takeToken(state, now(), perMinute, burst);
      state = next;
      if (waitMs > 0) await sleep(waitMs);
    },
    waitMs() {
      return takeToken(state, now(), perMinute, burst).waitMs;
    },
    slow() {
      clean = 0;
      perMinute = Math.max(floor, perMinute / 2);
      // Drop whatever credit is banked as well. Slowing the refill but letting a full
      // bucket drain at once would put the next few requests back-to-back, which is the
      // shape that drew the refusal in the first place.
      state = { tokens: 0, at: Math.max(now(), state.at) };
      return perMinute;
    },
    ok() {
      if (perMinute >= ceiling) return;
      if (++clean < recoverAfter) return;
      clean = 0;
      perMinute = Math.min(ceiling, perMinute + step);
      // Deliberately does NOT hand back the tokens that slow() dropped. Widening the
      // refill is the recovery; releasing a burst at the same moment is how a scan
      // re-trips the limit it just climbed out of.
    },
    rate() {
      return perMinute;
    },
  };
}
