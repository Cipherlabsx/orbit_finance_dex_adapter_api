/**
 * Delete a pool from the database
 * Usage: npx ts-node delete_pool.ts <pool_address>
 */

import { supabase } from "./src/supabase.js";

const POOL_ADDRESS = process.argv[2];

if (!POOL_ADDRESS) {
  console.error("❌ Missing pool address");
  console.log("Usage: npx ts-node delete_pool.ts <pool_address>");
  process.exit(1);
}

async function main() {
  console.log(`🗑️  Deleting pool from database: ${POOL_ADDRESS}\n`);

  // First check if pool exists
  const { data: existing, error: fetchError } = await supabase
    .from("dex_pools")
    .select("pool, base_mint, quote_mint, liquidity_quote, updated_at")
    .eq("pool", POOL_ADDRESS)
    .maybeSingle();

  if (fetchError) {
    console.error(`❌ Error fetching pool: ${fetchError.message}`);
    process.exit(1);
  }

  if (!existing) {
    console.log("⚠️  Pool not found in database");
    process.exit(0);
  }

  console.log("📊 Pool found:");
  console.log(`   Base mint: ${existing.base_mint}`);
  console.log(`   Quote mint: ${existing.quote_mint}`);
  console.log(`   Liquidity: ${existing.liquidity_quote}`);
  console.log(`   Updated: ${existing.updated_at}\n`);

  // Delete the pool
  const { error: deleteError } = await supabase
    .from("dex_pools")
    .delete()
    .eq("pool", POOL_ADDRESS);

  if (deleteError) {
    console.error(`❌ Error deleting pool: ${deleteError.message}`);
    process.exit(1);
  }

  console.log("✅ Pool deleted successfully!\n");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
