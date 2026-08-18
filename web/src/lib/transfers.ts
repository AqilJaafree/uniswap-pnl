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
 * Pure and chain-free so the chunking and grouping can be unit-tested — see
 * transfers.test.ts. The fetching itself lives in chain.ts, where the client is.
 */
import type { NftTransfer } from "./ownership";

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

/**
 * Group transfer logs by the tokenId they belong to.
 *
 * EVERY requested id gets an entry, including ids the query returned nothing for. That
 * distinction is load-bearing: restrictToOwner treats "no transfer logs at all" as "I
 * cannot establish ownership, do not truncate the lifecycle on a guess", and it must
 * reach that conclusion from a real empty result rather than from a missing map key it
 * cannot tell apart from "never fetched".
 */
export function groupByTokenId(
  requested: readonly bigint[],
  logs: readonly { tokenId: bigint; transfer: NftTransfer }[],
): Map<bigint, NftTransfer[]> {
  const out = new Map<bigint, NftTransfer[]>();
  for (const id of requested) out.set(id, []);
  for (const { tokenId, transfer } of logs) {
    const bucket = out.get(tokenId);
    // A log for an id nobody asked about is dropped rather than added: it can only come
    // from a filter that was wider than intended, and letting it through would silently
    // widen the ownership window of a position this scan never enumerated.
    if (bucket) bucket.push(transfer);
  }
  // ownershipOf walks these in chain order; a topic-array query returns logs interleaved
  // across ids and across chunks, so ordering here is not optional.
  for (const bucket of out.values()) {
    bucket.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber ? -1 : 1);
  }
  return out;
}
