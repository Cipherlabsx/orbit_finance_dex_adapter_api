import { PublicKey } from "@solana/web3.js";

/**
 * Orbit bin PDA:
 * seeds = ["bin", pool, u64(binIndex LE)]
 */
export function deriveBinPda(programId: PublicKey, pool: PublicKey, binIndex: bigint): PublicKey {
  const seedBin = Buffer.from("bin");
  const seedPool = pool.toBuffer();

  const seedIndex = Buffer.alloc(8);
  seedIndex.writeBigUInt64LE(binIndex);

  const [pda] = PublicKey.findProgramAddressSync([seedBin, seedPool, seedIndex], programId);
  return pda;
}