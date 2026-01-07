import { pk } from "../solana.js";
import { env } from "../config.js";
import { readPool } from "./pool_reader.js";

/**
 * Pair schema:
 * - id: pair id (we use pool address)
 * - dexKey
 * - asset0Id / asset1Id
 * - feeBps 
 */
export async function readPair(id: string) {
  const poolId = pk(id).toBase58();
  const p = await readPool(poolId);

  // IMPORTANT: Requires immutable asset ordering.
  // For Orbit: baseMint/quoteMint are canonical in your Pool struct => use them as-is.
  return {
    pair: {
      id: poolId,
      dexKey: env.DEX_KEY,
      asset0Id: p.baseMint,
      asset1Id: p.quoteMint,
      feeBps: p.baseFeeBps ?? undefined,
      // Next iteration:
      // createdAtBlockNumber, createdAtBlockTimestamp, createdAtTxnId, creator, metadata
    },
  };
}