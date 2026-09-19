import { isWalletScanAllowlisted } from "./wallet-scan-allowlist";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const WALLET = "0x7e995decc404633CF2889968537D723c55ffEA2C";

eq("unset env means nobody is allowlisted", isWalletScanAllowlisted(WALLET, undefined), false);
eq("empty string means nobody is allowlisted", isWalletScanAllowlisted(WALLET, ""), false);
eq("a single matching address passes", isWalletScanAllowlisted(WALLET, WALLET), true);
eq("case-insensitive on both sides", isWalletScanAllowlisted(WALLET.toLowerCase(), WALLET.toUpperCase()), true);
eq("one of several, comma-separated", isWalletScanAllowlisted(WALLET, `0x1111111111111111111111111111111111111111,${WALLET},0x2222222222222222222222222222222222222222`), true);
eq("whitespace around entries is trimmed", isWalletScanAllowlisted(WALLET, ` 0x1111111111111111111111111111111111111111 , ${WALLET} `), true);
eq("an address not in the list is refused", isWalletScanAllowlisted(WALLET, "0x1111111111111111111111111111111111111111"), false);
eq("stray commas/blank entries don't match everything", isWalletScanAllowlisted(WALLET, ",,0x1111111111111111111111111111111111111111,,"), false);
eq("a prefix of the address is not a match", isWalletScanAllowlisted(WALLET, WALLET.slice(0, 10)), false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
