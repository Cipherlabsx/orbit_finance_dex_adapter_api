/**
 * Backfill script to populate bins column in dex_pools table
 *
 * Reads BinArray accounts from blockchain for each pool and stores liquidity data
 *
 * Usage: npm run backfill:pools:bins
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM");

type PoolRow = {
  pool: string;
  base_decimals: number;
  quote_decimals: number;
  bin_step_bps: number;
  active_bin: number | null;
};

type BinData = {
  binId: number;
  price: number;
  baseUi: number;
  quoteUi: number;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SOLANA_RPC_URL = mustEnv("SOLANA_RPC_URL");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  // Fetch all pools with active_bin
  const { data: pools, error } = await supa
    .from("dex_pools")
    .select("pool, base_decimals, quote_decimals, bin_step_bps, active_bin")
    .not("active_bin", "is", null)
    .returns<PoolRow[]>();

  if (error) {
    throw new Error(`Failed to fetch pools: ${error.message}`);
  }

  if (!pools || pools.length === 0) {
    console.log("No pools found with active_bin set");
    return;
  }

  console.log(`Starting backfill for ${pools.length} pools...`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    console.log(`\n[${i + 1}/${pools.length}] Processing pool: ${pool.pool}`);

    try {
      const bins = await fetchPoolBins(connection, pool);

      if (bins.length === 0) {
        console.log(`  ⚠️  No bins with liquidity found`);
        continue;
      }

      // Update pool with bins
      const { error: updateError } = await supa
        .from("dex_pools")
        .update({
          bins: bins,
          bins_updated_at: new Date().toISOString(),
        })
        .eq("pool", pool.pool);

      if (updateError) {
        throw new Error(`Update failed: ${updateError.message}`);
      }

      console.log(`  ✅ Updated ${bins.length} bins`);
      successCount++;

      // Rate limiting (200ms delay between pools)
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.error(
        `  ❌ Error: ${error instanceof Error ? error.message : String(error)}`
      );
      errorCount++;
    }
  }

  console.log(`\n=== Backfill Complete ===`);
  console.log(`Success: ${successCount} pools`);
  console.log(`Errors: ${errorCount} pools`);
}

async function fetchPoolBins(
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
  const startArray = Math.floor(startBin / 64) * 64;
  const endArray = Math.floor(endBin / 64) * 64;

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
        const baseUi =
          Number(baseReserves) / Math.pow(10, pool.base_decimals);
        const quoteUi =
          Number(quoteReserves) / Math.pow(10, pool.quote_decimals);

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

// Run the script
main()
  .then(() => {
    console.log("\n✅ Backfill completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Backfill failed:", error);
    process.exit(1);
  });
