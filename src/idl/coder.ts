import anchorPkg, { type Idl } from "@coral-xyz/anchor";
const { BorshCoder } = anchorPkg;
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

// EVENTS (Anchor "Program data: <base64>")

export type OrbitDecodedEvent = {
  name: string;
  data: Record<string, any>;
};

/**
 * Try decode ONE log line that looks like:
 *   "Program data: <base64>"
 *
 * Anchor emits event payloads this way.
 */
export function decodeEventLogLine(logLine: string): OrbitDecodedEvent | null {
  if (!logLine.startsWith("Program data: ")) return null;

  try {
    const b64 = logLine.slice("Program data: ".length).trim();

    // Anchor expects base64 STRING here (typing is correct, runtime matches)
    const evt = coder.events.decode(b64);
    if (!evt) return null;

    return { name: evt.name, data: evt.data as any };
  } catch {
    return null;
  }
}

/**
 * Decode ALL events from a full logs array.
 */
export function decodeEventsFromLogs(logs: readonly string[] | null | undefined): OrbitDecodedEvent[] {
  if (!logs || logs.length === 0) return [];
  const out: OrbitDecodedEvent[] = [];
  for (const line of logs) {
    const e = decodeEventLogLine(line);
    if (e) out.push(e);
  }
  return out;
}