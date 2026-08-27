import { isPermanentReadFailure } from "./read-failure";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** viem wraps an RPC error and puts the upstream's own wording in `details`. */
const viemErr = (details: string) =>
  Object.assign(new Error("Missing or invalid parameters."), { details, shortMessage: "Missing or invalid parameters." });

// ---- permanent: the state is not there, and asking again will not conjure it ----
{
  eq("a pruned block is permanent", isPermanentReadFailure(viemErr("metadata is not found, 46577477")), true);
  eq("a missing trie node is permanent", isPermanentReadFailure(viemErr("missing trie node 0xabc")), true);
  eq("no state available is permanent", isPermanentReadFailure(viemErr("No state available for block 0x2c6b742")), true);
  // A revert is a deterministic answer. Retrying it forever would cost the position its
  // whole scan and land it in `skipped` for a question the chain already answered.
  eq("a revert is permanent", isPermanentReadFailure(viemErr("execution reverted")), true);
  // viem does NOT pass the node's wording through for a revert — it raises its own
  // ContractFunctionExecutionError whose text is "The contract function ... reverted."
  // Matching only on "execution reverted" therefore classified every real revert as
  // transient, which meant three retries and then a SKIPPED position for a question the
  // chain had already answered definitively.
  eq(
    "viem's own revert wording is permanent too",
    isPermanentReadFailure(Object.assign(new Error('The contract function "getSlot0" reverted.'), { shortMessage: 'The contract function "getSlot0" reverted.' })),
    true,
  );
  // Calling a contract at a block before it was deployed returns empty data. That is an
  // answer about the chain's history, and retrying it is pointless.
  eq(
    "an empty return is permanent",
    isPermanentReadFailure(Object.assign(new Error("returned no data"), { shortMessage: 'The contract function "getFeeGrowthInside" returned no data ("0x").' })),
    true,
  );
}

// ---- transient: the ROUTE failed, not the chain --------------------------------
{
  // These are the ones that must never be recorded as "this block is pruned". Each is a
  // statement about the proxy or the network, and the state it was asked for may be
  // perfectly readable one second later.
  eq("a rate limit is transient", isPermanentReadFailure(viemErr("rate limit exceeded")), false);
  eq("Too Many Requests is transient", isPermanentReadFailure(new Error("HTTP request failed. Status: 429")), false);
  eq("an exhausted proxy chain is transient", isPermanentReadFailure(viemErr("all RPC upstreams failed")), false);
  eq("a dead socket is transient", isPermanentReadFailure(new Error("fetch failed")), false);
  eq("a dead backend is transient", isPermanentReadFailure(viemErr('Post "http://10.31.64.244:8547/rpc": dial tcp: no route to host')), false);
  eq("a timeout is transient", isPermanentReadFailure(new Error("The request took too long to respond. timeout")), false);
  eq("a 502 is transient", isPermanentReadFailure(new Error("HTTP request failed. Status: 502")), false);
}

// ---- the default matters ------------------------------------------------------
{
  // An unrecognised failure must be treated as TRANSIENT, because the two outcomes are
  // not symmetric: guessing "transient" costs a retry, guessing "permanent" writes a
  // wrong number into a headline that never says it is unsure.
  eq("an unrecognised error is transient", isPermanentReadFailure(new Error("something new")), false);
  eq("a non-error is transient", isPermanentReadFailure(undefined), false);
  eq("a string is transient", isPermanentReadFailure("boom"), false);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
