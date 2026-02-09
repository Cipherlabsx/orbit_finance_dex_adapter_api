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

/**
 * Orbit BinArray PDA (for position-bin accounting mode):
 * seeds = ["bin_array", pool, i32(lowerBinIndex LE)]
 */
export function deriveBinArrayPda(programId: PublicKey, pool: PublicKey, lowerBinIndex: number): PublicKey {
  const seedBinArray = Buffer.from("bin_array");
  const seedPool = pool.toBuffer();

  const seedIndex = Buffer.alloc(4);
  seedIndex.writeInt32LE(lowerBinIndex);

  const [pda] = PublicKey.findProgramAddressSync([seedBinArray, seedPool, seedIndex], programId);
  return pda;
}