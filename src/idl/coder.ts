import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { createRequire } from "node:module";

import type { OrbitFinance } from "./orbit_finance.js";

const require = createRequire(import.meta.url);
const idl = require("./orbit_finance.json") as OrbitFinance;

// Anchor's BorshCoder expects an "Idl" shape
export const ORBIT_IDL = idl as unknown as Idl;
export const coder = new BorshCoder(ORBIT_IDL);

/**
 * Decode an Anchor account from raw account data.
 */
export function decodeAccount<T = any>(accountName: string, data: Buffer): T {
  return coder.accounts.decode(accountName, data) as T;
}

/**
 * Useful for getProgramAccounts() memcmp filters.
 */
export const DISCRIMINATORS = {
  Pool: Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]),
  LiquidityBin: Buffer.from([4, 80, 150, 39, 152, 88, 42, 158]),
  PairRegistry: Buffer.from([180, 142, 99, 6, 243, 194, 134, 152]),
};