import { orderUpstreams } from "./lane-order";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const PUB = "https://public.example/rpc";
const PAID = "https://paid.example/v2/PAID-KEY";
const WALLET = "https://wallet.example/v2/WALLET-KEY";
const labels = (u: { label: string }[]) => u.map((x) => x.label);

// ---- ordinary traffic is unchanged by this feature ---------------------------
{
  eq("public only", labels(orderUpstreams({ publicRpc: PUB })), ["public"]);
  eq("public then paid", labels(orderUpstreams({ publicRpc: PUB, paidRpc: PAID })), ["public", "paid"]);
  // A wallet endpoint must not leak into ordinary traffic just because it is configured.
  eq(
    "a configured wallet endpoint is NOT used off-lane",
    labels(orderUpstreams({ publicRpc: PUB, paidRpc: PAID, walletRpc: WALLET })),
    ["public", "paid"],
  );
}

// ---- the wallet lane ---------------------------------------------------------
{
  // FIRST, not last: reaching it only after the public endpoint refuses would still spend
  // the free budget and pay a failed round trip before every heavy query.
  eq(
    "wallet lane tries the dedicated endpoint first",
    labels(orderUpstreams({ publicRpc: PUB, paidRpc: PAID, walletRpc: WALLET, lane: "wallet" })),
    ["wallet", "public", "paid"],
  );
  eq(
    "the ordinary chain still follows as backup",
    orderUpstreams({ publicRpc: PUB, paidRpc: PAID, walletRpc: WALLET, lane: "wallet" }).map((u) => u.url),
    [WALLET, PUB, PAID],
  );
}

// ---- degrade, never fail -----------------------------------------------------
{
  // Unset on Netlify: the scan must still run, on today's endpoints.
  eq(
    "wallet lane without WALLET_RPC_URL falls back to the ordinary order",
    labels(orderUpstreams({ publicRpc: PUB, paidRpc: PAID, lane: "wallet" })),
    ["public", "paid"],
  );
  // A cleared Netlify field arrives as an empty string, not undefined.
  eq(
    "a blank WALLET_RPC_URL is treated as unset",
    labels(orderUpstreams({ publicRpc: PUB, walletRpc: "", lane: "wallet" })),
    ["public"],
  );
  // The lane is a preference, never a requirement — an unknown value is not an error.
  for (const lane of ["", "nonsense", "WALLET", null, undefined]) {
    eq(
      `lane ${JSON.stringify(lane)} uses the ordinary order`,
      labels(orderUpstreams({ publicRpc: PUB, walletRpc: WALLET, lane })),
      ["public"],
    );
  }
}

// ---- the lane never invents an endpoint --------------------------------------
{
  // Every URL returned must be one that was passed in — the lane selects between
  // configured endpoints, it never constructs one.
  const given = new Set([PUB, PAID, WALLET]);
  for (const lane of ["wallet", "other", null]) {
    const urls = orderUpstreams({ publicRpc: PUB, paidRpc: PAID, walletRpc: WALLET, lane }).map((u) => u.url);
    eq(`lane ${JSON.stringify(lane)} returns only configured urls`, urls.every((u) => given.has(u)), true);
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
