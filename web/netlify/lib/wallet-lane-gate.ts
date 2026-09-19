/**
 * Server-side enforcement of who may spend a paid upstream at all — see rpc.ts.
 *
 * Deliberately NOT shared with web/src/lib/wallet-scan-allowlist.ts (the client-side UX
 * gate on the same allowlist name): that file sits outside this edge-function's bundle
 * root, and importing across that boundary risks the exact class of failure Task 4 hit —
 * a Deno bundling error invisible to `vite build`/`tsc`, only caught by `netlify build`
 * (see chain-upstreams.ts's header for the same rule). This file is the REAL enforcement
 * point regardless: the client's gate only decides whether to bother asking; this one
 * decides which endpoint answers.
 *
 * Design: a request declares a `subject` (the wallet address the CURRENT analyze() call
 * is for — see chain.ts's `onFetchRequest` hook). No subject, or a subject not on the
 * list, means every non-public upstream is dropped before this request is ever tried —
 * not just the wallet-tier endpoint, but the ordinary paid-spillover one too. Ordinary
 * (non-allowlisted) traffic gets the free public endpoint and nothing else: if it
 * rate-limits, the request fails rather than spending paid budget on anonymous use.
 */
import type { Upstream } from "./lane-order.ts";

export function isAllowlistedSubject(subject: string | null, envValue: string | undefined): boolean {
  if (!subject || !envValue) return false;
  const target = subject.toLowerCase();
  return envValue
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

export function restrictUpstreams(
  upstreams: Upstream[],
  subject: string | null,
  envValue: string | undefined,
): Upstream[] {
  if (isAllowlistedSubject(subject, envValue)) return upstreams;
  return upstreams.filter((u) => u.label === "public");
}
