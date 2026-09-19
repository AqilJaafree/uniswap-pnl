/**
 * The sole gate on who may run a wallet scan, on EVERY chain (see chain.ts's `analyze()`) —
 * a deliberate access restriction on the public tool, not a per-chain reliability check.
 * Wallet scanning works fine end-to-end on Robinhood; it is restricted there too. Arc's
 * genesis-wide NFT-transfer scan is separately rate-limit- and pruning-prone at scale (see
 * rpc-logs.ts's `getLogsFromGenesis`), which is a different, additional reason an
 * allowlisted address's Arc scan may still be slow or fail — this gate only decides who may
 * attempt one at all.
 *
 * Pure and env-value-shaped rather than reading `process.env`/`import.meta.env` itself, so
 * it is testable without either — see wallet-scan-allowlist.test.ts. The caller resolves
 * the raw env string the same way it already resolves VITE_RPC_URL/RPC_URL.
 */
export function isWalletScanAllowlisted(address: string, envValue: string | undefined): boolean {
  if (!envValue) return false;
  const target = address.toLowerCase();
  return envValue
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}
