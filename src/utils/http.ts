import { randomUUID } from "node:crypto";

export function reqId() {
  return randomUUID();
}

export function safeNumber(n: bigint): number | null {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (n > max) return null;
  return Number(n);
}