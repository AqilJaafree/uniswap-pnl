/**
 * A narrow escape hatch on `ChainConfig.walletScanSupported`: an operator-controlled list
 * of specific addresses allowed to attempt a wallet scan on a chain where it is otherwise
 * refused outright (see chain.ts's `analyze()`) — for testing against one known, small
 * wallet without exposing the feature to arbitrary input. Wallet scanning on Arc is
 * rate-limit- and pruning-prone at scale (see rpc-logs.ts's `getLogsFromGenesis`); a single
 * allowlisted wallet with few positions is a different, much smaller ask than "any wallet."
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
