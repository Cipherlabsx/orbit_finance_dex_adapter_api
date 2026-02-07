/**
 * Check what exists for a pool in the database
 * Usage: npx tsx check_pool.ts <pool_address>
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Load env first
dotenv.config();

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !key) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

const POOL_ADDRESS = process.argv[2];

if (!POOL_ADDRESS) {
  console.error("❌ Missing pool address");
  console.log("Usage: npx tsx check_pool.ts <pool_address>");
  process.exit(1);
}

async function main() {
  console.log(`🔍 Checking database for pool: ${POOL_ADDRESS}\n`);
  console.log("=" + "=".repeat(60) + "\n");

  // Check pool
  console.log("📊 Pool record:");
  const { data: pool, error: poolError } = await supabase
    .from("dex_pools")
    .select("*")
    .eq("pool", POOL_ADDRESS)
    .maybeSingle();

  if (poolError) {
    console.error(`❌ Error fetching pool: ${poolError.message}`);
  } else if (!pool) {
    console.log("   ⚠️  Pool not found in database\n");
  } else {
    console.log(`   Pool: ${pool.pool}`);
    console.log(`   Program ID: ${pool.program_id}`);
    console.log(`   Base mint: ${pool.base_mint}`);
    console.log(`   Quote mint: ${pool.quote_mint}`);
    console.log(`   Base decimals: ${pool.base_decimals}`);
    console.log(`   Quote decimals: ${pool.quote_decimals}`);
    console.log(`   Base vault: ${pool.base_vault}`);
    console.log(`   Quote vault: ${pool.quote_vault}`);
    console.log(`   LP mint: ${pool.lp_mint}`);
    console.log(`   Creator fee vault: ${pool.creator_fee_vault}`);
    console.log(`   Holders fee vault: ${pool.holders_fee_vault}`);
    console.log(`   NFT fee vault: ${pool.nft_fee_vault}`);
    console.log(`   Bin step: ${pool.bin_step_bps} bps`);
    console.log(`   Active bin: ${pool.active_bin}`);
    console.log(`   Initial bin: ${pool.initial_bin}`);
    console.log(`   Liquidity (quote): ${pool.liquidity_quote}`);
    console.log(`   LP supply: ${pool.lp_supply_raw}`);
    console.log(`   TVL locked (quote): ${pool.tvl_locked_quote}`);
    console.log(`   Escrow LP ATA: ${pool.escrow_lp_ata}`);
    console.log(`   Escrow LP raw: ${pool.escrow_lp_raw}`);
    console.log(`   Creator fee UI: ${pool.creator_fee_ui}`);
    console.log(`   Holders fee UI: ${pool.holders_fee_ui}`);
    console.log(`   NFT fee UI: ${pool.nft_fee_ui}`);
    console.log(`   Paused bits: ${pool.paused_bits}`);
    console.log(`   Last update slot: ${pool.last_update_slot}`);
    console.log(`   Last trade sig: ${pool.last_trade_sig}`);
    console.log(`   Latest liq event slot: ${pool.latest_liq_event_slot}`);
    console.log(`   Fees updated at: ${pool.fees_updated_at}`);
    console.log(`   Bins updated at: ${pool.bins_updated_at}`);
    console.log(`   Updated at: ${pool.updated_at}`);

    // Check bins column
    if (pool.bins) {
      const binsData = typeof pool.bins === 'string' ? JSON.parse(pool.bins) : pool.bins;
      const binCount = Object.keys(binsData).length;
      console.log(`   Bins data: ${binCount} bins stored`);
    } else {
      console.log(`   Bins data: null`);
    }
    console.log();
  }

  // Check trades
  console.log("💱 Trades:");
  const { data: trades, error: tradesError } = await supabase
    .from("dex_trades")
    .select("signature, block_time, user_pubkey, in_mint, out_mint, amount_in_raw, amount_out_raw")
    .eq("pool", POOL_ADDRESS)
    .order("block_time", { ascending: false })
    .limit(10);

  if (tradesError) {
    console.error(`   ❌ Error fetching trades: ${tradesError.message}`);
  } else if (!trades || trades.length === 0) {
    console.log("   No trades found\n");
  } else {
    console.log(`   Found ${trades.length} trades (showing last 10):`);
    for (const trade of trades) {
      console.log(`   - ${trade.signature.slice(0, 8)}... at ${new Date(trade.block_time! * 1000).toISOString()}`);
      console.log(`     User: ${trade.user_pubkey?.slice(0, 8)}...`);
      console.log(`     In: ${trade.amount_in_raw} of ${trade.in_mint.slice(0, 8)}...`);
      console.log(`     Out: ${trade.amount_out_raw} of ${trade.out_mint.slice(0, 8)}...`);
    }
    console.log();
  }

  // Check events
  console.log("📝 Events:");
  const { data: events, error: eventsError } = await supabase
    .from("dex_events")
    .select("signature, slot, block_time, event_type, txn_index, event_index")
    .eq("program_id", pool?.program_id || "Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM")
    .order("slot", { ascending: false })
    .limit(20);

  if (eventsError) {
    console.error(`   ❌ Error fetching events: ${eventsError.message}`);
  } else if (!events || events.length === 0) {
    console.log("   No events found\n");
  } else {
    // Filter events related to this pool by checking event_data
    const poolEvents = [];
    for (const event of events) {
      const { data: fullEvent } = await supabase
        .from("dex_events")
        .select("event_data")
        .eq("signature", event.signature)
        .eq("txn_index", event.txn_index)
        .eq("event_index", event.event_index)
        .single();

      if (fullEvent?.event_data) {
        const eventData = typeof fullEvent.event_data === 'string'
          ? JSON.parse(fullEvent.event_data)
          : fullEvent.event_data;

        if (eventData.pool === POOL_ADDRESS) {
          poolEvents.push({ ...event, event_data: eventData });
        }
      }
    }

    if (poolEvents.length === 0) {
      console.log("   No events found for this pool\n");
    } else {
      console.log(`   Found ${poolEvents.length} events:`);
      for (const event of poolEvents) {
        console.log(`   - ${event.event_type} at slot ${event.slot}`);
        console.log(`     Signature: ${event.signature.slice(0, 8)}...`);
        console.log(`     Time: ${event.block_time ? new Date(event.block_time * 1000).toISOString() : 'unknown'}`);
      }
      console.log();
    }
  }

  console.log("=" + "=".repeat(60));
  console.log("✅ Check complete\n");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
