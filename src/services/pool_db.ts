import { supabase } from "../supabase.js";

export type DbPool = {
  pool: string;
  program_id: string | null;

  base_mint: string | null;
  quote_mint: string | null;
  base_decimals: number | null;
  quote_decimals: number | null;

  last_price_quote_per_base: string | number | null;

  base_vault: string | null;
  quote_vault: string | null;
  lp_mint: string | null;

  creator_fee_vault: string | null;
  holders_fee_vault: string | null;
  nft_fee_vault: string | null;

  base_fee_bps: number | null;
  bin_step_bps: number | null;
  paused_bits: number | null;

  active_bin: number | null;
  initial_bin: number | null;

  escrow_lp_ata: string | null;
  escrow_lp_raw: string | number | null;
  liquidity_quote: string | number | null;
  lp_supply_raw: string | number | null;
  tvl_locked_quote: string | number | null;

  creator_fee_ui: string | number | null;
  holders_fee_ui: string | number | null;
  nft_fee_ui: string | number | null;
  fees_updated_at: string | null;

  updated_at: string | null;
};

const POOL_SELECT =
  [
    "pool",
    "program_id",

    "base_mint",
    "quote_mint",
    "base_decimals",
    "quote_decimals",
    "last_price_quote_per_base",

    "base_vault",
    "quote_vault",
    "lp_mint",

    "creator_fee_vault",
    "holders_fee_vault",
    "nft_fee_vault",

    "base_fee_bps",
    "bin_step_bps",
    "paused_bits",

    "active_bin",
    "initial_bin",

    "escrow_lp_ata",
    "escrow_lp_raw",
    "liquidity_quote",
    "lp_supply_raw",
    "tvl_locked_quote",

    "creator_fee_ui",
    "holders_fee_ui",
    "nft_fee_ui",
    "fees_updated_at",

    "updated_at",
  ].join(",");

export async function dbListPools(pools?: string[]) {
  let q = supabase.from("dex_pools").select(POOL_SELECT);

  if (pools && pools.length) q = q.in("pool", pools);

  const { data, error } = await q.returns<DbPool[]>();
  if (error) throw new Error(`dbListPools failed: ${error.message}`);
  return data ?? [];
}

export async function dbGetPool(pool: string) {
  const { data, error } = await supabase
    .from("dex_pools")
    .select(POOL_SELECT)
    .eq("pool", pool)
    .maybeSingle();

  if (error) throw new Error(`dbGetPool failed: ${error.message}`);
  return (data ?? null) as DbPool | null;
}

export async function dbUpdatePoolLiveState(args: {
  pool: string;
  slot: number;
  signature?: string | null;
  activeBin: number | null;
  lastPriceQuotePerBase: number | null;
}) {
  const { pool, slot, signature, activeBin, lastPriceQuotePerBase } = args;

  // Only accept newer updates. Prevent out-of-order overwrites.
  const gate = `last_update_slot.is.null,last_update_slot.lt.${slot}`;

  const { error } = await supabase
    .from("dex_pools")
    .update({
      active_bin: activeBin,
      last_price_quote_per_base: lastPriceQuotePerBase,
      last_update_slot: slot,
      last_trade_sig: signature ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("pool", pool)
    .or(gate);

  if (error) throw new Error(`dbUpdatePoolLiveState failed: ${error.message}`);
}