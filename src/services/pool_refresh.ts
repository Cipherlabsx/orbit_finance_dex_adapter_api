/**
 * Pool Refresh Service
 *
 * Fetches fresh pool data from on-chain and updates the database
 * Called after deposit/withdraw operations to keep database in sync with on-chain truth
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROGRAM_ID = new PublicKey("Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM");

type BinData = {
  binId: number;
  price: number;
  baseUi: number;
  quoteUi: number;
};

type PoolRow = {
  pool: string;
  base_decimals: number;
  quote_decimals: number;
  bin_step_bps: number;
  active_bin: number | null;
};

/**
 * Refreshes pool bin data from on-chain and updates database
 *
 * CRITICAL: Always updates the database, even if bins are empty
 * This ensures database stays in sync with on-chain truth after operations
 */
export async function refreshPoolBins(
  connection: Connection,
  supabase: SupabaseClient,
  poolAddress: string
): Promise<{ success: boolean; bins: BinData[] | null; error?: string }> {
  try {
    // Fetch pool metadata from database
    const { data: pool, error: fetchError } = await supabase
      .from("dex_pools")
      .select("pool, base_decimals, quote_decimals, bin_step_bps, active_bin")
      .eq("pool", poolAddress)
      .single();

    if (fetchError || !pool) {
      return { success: false, bins: null, error: "Pool not found in database" };
    }

    if (!pool.active_bin) {
      return { success: false, bins: null, error: "Pool has no active_bin set" };
    }

    // Fetch bins from on-chain
    const bins = await fetchPoolBinsFromChain(connection, pool as PoolRow);

    // CRITICAL FIX: Always update database, even if bins are empty
    // This prevents stale data when liquidity is withdrawn
    const binsToStore = bins.length > 0 ? bins : null;

    const { error: updateError } = await supabase
      .from("dex_pools")
      .update({
        bins: binsToStore,
        bins_updated_at: new Date().toISOString(),
      })
      .eq("pool", poolAddress);

    if (updateError) {
      return {
        success: false,
        bins: null,
        error: `Database update failed: ${updateError.message}`,
      };
    }

    console.log(
      `Refreshed pool ${poolAddress}: ${bins.length} bins (${binsToStore ? "stored" : "cleared"})`
    );

    return { success: true, bins: binsToStore };
  } catch (error) {
    console.error(`Error refreshing pool ${poolAddress}:`, error);
    return {
      success: false,
      bins: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches bin data from on-chain for a pool
 */
async function fetchPoolBinsFromChain(
  connection: Connection,
  pool: PoolRow
): Promise<BinData[]> {
  const poolPubkey = new PublicKey(pool.pool);
  const activeBin = pool.active_bin!;
  const radius = 100; // ±100 bins around active bin

  const bins: BinData[] = [];

  // Calculate bin range
  const startBin = activeBin - radius;
  const endBin = activeBin + radius;

  // Group into BinArray accounts (64 bins per array)
  const startArray = Math.trunc(startBin / 64) * 64;
  const endArray = Math.trunc(endBin / 64) * 64;

  for (let lowerIndex = startArray; lowerIndex <= endArray; lowerIndex += 64) {
    const binArrayPda = deriveBinArrayPda(poolPubkey, lowerIndex);

    try {
      const accountInfo = await connection.getAccountInfo(binArrayPda);

      if (!accountInfo || accountInfo.data.length < 44) {
        continue; // BinArray doesn't exist or invalid
      }

      // Parse BinArray: discriminator(8) + pool(32) + lower_bin_index(4) + bins(64*24)
      const data = accountInfo.data;
      const binsData = data.subarray(44);

      // Parse each bin (24 bytes minimum)
      for (let binOffset = 0; binOffset < 64; binOffset++) {
        const binStart = binOffset * 24;
        if (binStart + 24 > binsData.length) break;

        const binData = binsData.subarray(binStart, binStart + 24);

        // Read u64 little-endian fields
        const totalShares = readU64LE(binData, 0);
        const baseReserves = readU64LE(binData, 8);
        const quoteReserves = readU64LE(binData, 16);

        // Skip bins with no liquidity
        if (totalShares === 0n) continue;

        const binId = lowerIndex + binOffset;

        // Calculate price from bin ID
        const price = calculatePriceFromBin(binId, pool.bin_step_bps);

        // Convert reserves to UI amounts
        const baseUi = Number(baseReserves) / Math.pow(10, pool.base_decimals);
        const quoteUi = Number(quoteReserves) / Math.pow(10, pool.quote_decimals);

        bins.push({
          binId,
          price,
          baseUi,
          quoteUi,
        });
      }
    } catch (error) {
      // BinArray doesn't exist or error fetching - skip
      continue;
    }
  }

  // Sort by bin ID
  bins.sort((a, b) => a.binId - b.binId);

  return bins;
}

function deriveBinArrayPda(pool: PublicKey, lowerIndex: number): PublicKey {
  const lowerIndexBuffer = Buffer.alloc(4);
  lowerIndexBuffer.writeInt32LE(lowerIndex, 0);

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), pool.toBuffer(), lowerIndexBuffer],
    PROGRAM_ID
  );

  return pda;
}

function calculatePriceFromBin(binId: number, binStepBps: number): number {
  const step = binStepBps / 10000;
  const base = 1 + step;
  return Math.pow(base, binId);
}

function readU64LE(buffer: Uint8Array, offset: number): bigint {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return view.getBigUint64(offset, true); // true = little endian
}
