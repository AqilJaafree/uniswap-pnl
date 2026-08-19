/**
 * Fetch every position's ownership history in a handful of queries instead of one each.
 *
 * restrictToOwner needs the ERC-721 Transfer log of ONE tokenId, and asking for them one
 * at a time is what made a large wallet slow: a 112-position wallet issued 112 full-range
 * eth_getLogs, each ~1.4s, none of which can start before the previous position finishes.
 *
 * eth_getLogs accepts an ARRAY in a topic position, so a single query can carry many
 * tokenIds at once and the results are separated locally — measured against the live
 * endpoint before this was written. That turns 112 requests into ceil(112 / CHUNK).
 *
 * Pure and chain-free so the chunking can be unit-tested — see transfers.test.ts. The
 * fetching lives in chain.ts, where the client is; splitting the results back out by
 * tokenId now belongs to chain-cache.ts, which has to do it anyway to keep a cache
 * record per position rather than per chunk.
 */
/**
 * How many tokenIds ride in one query's topic array.
 *
 * Not unbounded: a topic array is part of the request body and providers cap both its
 * length and the response size, and one refused query costs every id in it. 50 keeps a
 * large wallet to a couple of round trips while staying well inside anything observed.
 * The block-range splitting in getLogsChunked still applies on top, per chunk.
 */
export const TOKEN_ID_CHUNK = 50;

export function chunkIds<T>(ids: readonly T[], size = TOKEN_ID_CHUNK): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
