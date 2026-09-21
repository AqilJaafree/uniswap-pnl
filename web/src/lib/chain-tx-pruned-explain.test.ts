/**
 * analyzeTx used to let a pruned-state read failure (feeGrowthAt/slot0TickAt's fallback
 * chain in chain-v4.ts exhausting itself) reach the browser as viem's raw "Missing or
 * invalid parameters" dump. That's accurate but unactionable — it never said *why* (this
 * sender has no archive-access) or what to do about it (use an allowlisted wallet).
 * explainPrunedTxFailure (chain.ts) rewrites exactly that case into a clear message and
 * defers to the original error everywhere else. Pure function — no RPC mocking needed.
 */
import { explainPrunedTxFailure } from "./chain";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const SENDER = "0x7e995decc404633CF2889968537D723c55ffEA2C";
const prunedErr = Object.assign(new Error("Missing or invalid parameters."), {
  details: "historical state 5f96e0688ef7ba2f6fb96de661ea355ba7cf8fd51090598454769e8f27cbca1d is not available",
});
const revertErr = Object.assign(new Error('The contract function "getSlot0" reverted.'), {
  shortMessage: 'The contract function "getSlot0" reverted.',
});

{
  const explained = explainPrunedTxFailure(prunedErr, false, SENDER);
  eq("non-allowlisted + pruned-state → a rewritten error", explained !== null, true);
  eq("names the sender, checksummed", explained!.message.includes(SENDER), true);
  eq("says why (archive access)", explained!.message.toLowerCase().includes("archive"), true);
  eq("does not leak viem's raw wording", explained!.message.includes("Missing or invalid parameters"), false);
}

eq(
  "allowlisted sender + pruned-state → original error preserved (null)",
  explainPrunedTxFailure(prunedErr, true, SENDER),
  null,
);

eq(
  "non-allowlisted + a REVERT (not an access gap) → original error preserved (null)",
  explainPrunedTxFailure(revertErr, false, SENDER),
  null,
);

eq(
  "non-allowlisted + an unrelated/transient failure → original error preserved (null)",
  explainPrunedTxFailure(new Error("fetch failed"), false, SENDER),
  null,
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
