import { computeV4PoolId, unpackPositionInfo } from "./v4-decode";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

// Verified live: PositionManager #1 poolKey → this poolId (matches ModifyLiquidity topic1).
eq("poolId #1", computeV4PoolId({
  currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  currency1: "0x42bcDF8d4116545d04dd5b76F48b614450f18B1B",
  fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000",
}), "0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d33cbd7249413a5");

// PositionInfo packing: tickLower at bits 8-31, tickUpper at bits 32-55 (signed 24-bit).
{
  const u24 = (n: number) => BigInt(n & 0xffffff);
  const info = (u24(887220) << 32n) | (u24(-887220) << 8n);
  const r = unpackPositionInfo(info);
  eq("tickLower", r.tickLower, -887220);
  eq("tickUpper", r.tickUpper, 887220);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
