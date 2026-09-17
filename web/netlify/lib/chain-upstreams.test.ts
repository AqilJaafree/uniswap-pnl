import { resolveChainUpstreams } from "./chain-upstreams";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ROBINHOOD_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";

// Robinhood (chain absent or anything other than "arc"): unchanged behavior, own env vars, has a default.
eq(
  "robinhood, no chain param, no env set → falls back to the hardcoded default",
  resolveChainUpstreams(null, {}, null, ROBINHOOD_DEFAULT),
  [{ url: ROBINHOOD_DEFAULT, label: "public" }],
);
eq(
  "robinhood, PUBLIC_RPC_URL set → used instead of the default",
  resolveChainUpstreams(null, { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://public.example", label: "public" }],
);
eq(
  "robinhood wallet lane → wallet endpoint first",
  resolveChainUpstreams(null, { PUBLIC_RPC_URL: "https://public.example", WALLET_RPC_URL: "https://wallet.example" }, "wallet", ROBINHOOD_DEFAULT),
  [{ url: "https://wallet.example", label: "wallet" }, { url: "https://public.example", label: "public" }],
);
eq(
  "an unrecognized chain param behaves exactly like no chain param (robinhood)",
  resolveChainUpstreams("nonsense", { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://public.example", label: "public" }],
);

// Arc: separate env vars, NO default — unset means "not configured", not a guess.
eq(
  "arc, ARC_RPC_URL unset → not configured (null), regardless of Robinhood's env or default",
  resolveChainUpstreams("arc", { PUBLIC_RPC_URL: "https://public.example" }, null, ROBINHOOD_DEFAULT),
  null,
);
eq(
  "arc, ARC_RPC_URL set → used, own var name",
  resolveChainUpstreams("arc", { ARC_RPC_URL: "https://arc-public.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://arc-public.example", label: "public" }],
);
eq(
  "arc wallet lane uses ARC_WALLET_RPC_URL, not Robinhood's WALLET_RPC_URL",
  resolveChainUpstreams(
    "arc",
    { ARC_RPC_URL: "https://arc-public.example", ARC_WALLET_RPC_URL: "https://arc-wallet.example", WALLET_RPC_URL: "https://robinhood-wallet.example" },
    "wallet",
    ROBINHOOD_DEFAULT,
  ),
  [{ url: "https://arc-wallet.example", label: "wallet" }, { url: "https://arc-public.example", label: "public" }],
);
eq(
  "arc paid spillover uses ARC_PAID_RPC_URL",
  resolveChainUpstreams("arc", { ARC_RPC_URL: "https://arc-public.example", ARC_PAID_RPC_URL: "https://arc-paid.example" }, null, ROBINHOOD_DEFAULT),
  [{ url: "https://arc-public.example", label: "public" }, { url: "https://arc-paid.example", label: "paid" }],
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
