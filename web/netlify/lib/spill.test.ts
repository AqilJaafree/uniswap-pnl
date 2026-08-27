import { isRateLimitBody, isUnserviceableBody, mightHoldError, spillReason } from "./spill";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const err = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });
const ok = (result: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

// ---- the refusal that started this -------------------------------------------
{
  // Captured verbatim from the public node, answering an eth_call pinned ~500k blocks
  // back. Note the HTTP status was 200: nothing at the transport layer says "I could not
  // serve this", so without this predicate the proxy returns it as the final answer and
  // never tries the archive upstream behind it.
  eq(
    "the public node's archive refusal spills",
    isUnserviceableBody(err(-32000, "metadata is not found, 46577477")),
    true,
  );
  // The same class, worded by the other engines the paid/wallet upstreams may be.
  eq("geth's pruned-state refusal spills", isUnserviceableBody(err(-32000, "missing trie node 0xabc… (path )")), true);
  eq("a missing header spills", isUnserviceableBody(err(-32000, "header not found")), true);
  eq("Alchemy's pruned-state refusal spills", isUnserviceableBody(err(-32000, "No state available for block 0x2c6b742")), true);
  eq("erigon's wording spills", isUnserviceableBody(err(-32000, "state at block 46577477 not found")), true);
}

// ---- what must NOT spill ------------------------------------------------------
{
  // A revert IS an answer. The next upstream would revert identically, so spilling only
  // triples the cost of learning the same thing — and on the last upstream it would
  // change nothing anyway.
  eq("a revert is an answer, not a refusal", isUnserviceableBody(err(3, "execution reverted")), false);
  eq("a successful result does not spill", isUnserviceableBody(ok("0x12")), false);
  // Halving a range or asking another node will not fix a malformed request.
  eq("a bad request does not spill", isUnserviceableBody(err(-32602, "invalid argument 0: hex string has odd length")), false);
  eq("an unparseable body does not spill", isUnserviceableBody("<html>502 Bad Gateway</html>"), false);
  eq("an empty body does not spill", isUnserviceableBody(""), false);
}

// ---- batches ------------------------------------------------------------------
{
  // viem batches. One unserviceable call in a batch makes the whole response unusable,
  // and re-sending the batch to the next upstream is safe because every method here is
  // a read.
  eq(
    "one unserviceable call in a batch spills the batch",
    isUnserviceableBody(JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: "0x12" },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "metadata is not found, 46577477" } },
    ])),
    true,
  );
  eq(
    "an all-good batch does not spill",
    isUnserviceableBody(JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: "0x12" },
      { jsonrpc: "2.0", id: 2, result: "0x34" },
    ])),
    false,
  );
}

// ---- the two predicates stay separate -----------------------------------------
{
  // A rate limit is a "come back later", an unserviceable read is a "not me, ever".
  // Both spill, but they are different facts and the log line names which one fired.
  eq("a rate limit is not an unserviceable read", isUnserviceableBody(err(-32005, "rate limit exceeded")), false);
  eq("an unserviceable read is not a rate limit", isRateLimitBody(err(-32000, "metadata is not found, 46577477")), false);
  eq("the rate-limit predicate still works", isRateLimitBody(err(-32005, "limit exceeded")), true);
  eq("a 429-shaped message is a rate limit", isRateLimitBody(err(-32000, "Too Many Requests")), true);
}

// ---- one parse, one pass -------------------------------------------------------
{
  // The handler asks both questions of every response. Asking them as two predicates
  // parses the body TWICE, and these bodies are getLogs output — megabytes of it — on an
  // edge function with a 50ms CPU budget. spillReason answers both from one parse, and
  // names which rule fired so the log line stays specific.
  eq("no reason to spill a good answer", spillReason(ok("0x12")), null);
  eq("a rate limit is named", spillReason(err(-32005, "limit exceeded")), "rate-limit");
  eq("an unserviceable read is named", spillReason(err(-32000, "metadata is not found, 46577477")), "unserviceable");
  eq("a revert is not a reason", spillReason(err(3, "execution reverted")), null);

  // The cheap reject that makes this affordable is its own function, so it can be
  // asserted directly rather than inferred from a result that would be null either way.
  // A successful body has no `error` member at all, so the common case — a getLogs
  // response worth megabytes — never reaches JSON.parse.
  eq("a successful body cannot hold an error", mightHoldError(ok("0x" + "ab".repeat(4096))), false);
  eq("a batch of results cannot hold an error", mightHoldError(JSON.stringify([{ result: "0x1" }, { result: "0x2" }])), false);
  eq("an error body must be parsed", mightHoldError(err(-32000, "header not found")), true);
  eq("a body mentioning an error is still parsed", spillReason(err(-32000, "header not found")), "unserviceable");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
