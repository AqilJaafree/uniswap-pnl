import { isAllowlistedSubject, restrictUpstreams } from "./wallet-lane-gate";
import type { Upstream } from "./lane-order";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";
const ALLOWLIST = `0x1111111111111111111111111111111111111111,${WALLET}`;

// ---- isAllowlistedSubject -----------------------------------------------------
eq("no subject at all is never allowlisted", isAllowlistedSubject(null, ALLOWLIST), false);
eq("no env value is never allowlisted, even a matching subject", isAllowlistedSubject(WALLET, undefined), false);
eq("a listed subject passes", isAllowlistedSubject(WALLET, ALLOWLIST), true);
eq("case-insensitive", isAllowlistedSubject(WALLET.toLowerCase(), ALLOWLIST.toUpperCase()), true);
eq("an unlisted subject is refused", isAllowlistedSubject("0x2222222222222222222222222222222222222222", ALLOWLIST), false);

// ---- restrictUpstreams: this is what actually decides which endpoint gets hit -
const upstreams: Upstream[] = [
  { url: "https://wallet.example", label: "wallet" },
  { url: "https://public.example", label: "public" },
  { url: "https://paid.example", label: "paid" },
];

eq(
  "an allowlisted subject keeps every upstream, unchanged order",
  restrictUpstreams(upstreams, WALLET, ALLOWLIST),
  upstreams,
);
eq(
  "no subject drops every non-public upstream — no wallet tier, no paid spillover",
  restrictUpstreams(upstreams, null, ALLOWLIST).map((u) => u.label),
  ["public"],
);
eq(
  "an unlisted subject is treated exactly like no subject at all",
  restrictUpstreams(upstreams, "0x2222222222222222222222222222222222222222", ALLOWLIST).map((u) => u.label),
  ["public"],
);
eq(
  "an unset allowlist env restricts everyone, even a real-looking subject",
  restrictUpstreams(upstreams, WALLET, undefined).map((u) => u.label),
  ["public"],
);
eq(
  "a public-only upstream list (no paid/wallet configured) is untouched either way",
  restrictUpstreams([{ url: "https://public.example", label: "public" }], null, ALLOWLIST),
  [{ url: "https://public.example", label: "public" }],
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
