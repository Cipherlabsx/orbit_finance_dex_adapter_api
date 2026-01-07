import { Program, web3, type AnchorProvider } from "@coral-xyz/anchor";
import { createRequire } from "node:module";

import type { OrbitFinance } from "../idl/orbit_finance.ts";

const require = createRequire(import.meta.url);
const idl = require("../idl/orbit_finance.json") as OrbitFinance;

export function getProgram(provider: AnchorProvider) {
  return new Program<OrbitFinance>(idl as any, provider);
}

export function requireProgramId(
  program: { programId: web3.PublicKey },
  expected: web3.PublicKey
) {
  if (!program.programId.equals(expected)) {
    throw new Error(
      `ProgramId mismatch: expected ${expected.toBase58()} but Program() uses ${program.programId.toBase58()}.
Check orbit_finance.json 'address'.`
    );
  }
}