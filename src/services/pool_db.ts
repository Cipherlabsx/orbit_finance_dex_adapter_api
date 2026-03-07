import {
  supabase,
  filterDexTombstonedPools,
  isDexPoolTombstoned,
  isDexPoolTombstonedCached,
  warnDexPoolTombstoneOnce,
} from "../supabase.js";

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
  protocol_fee_vault?: string | null;
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
  protocol_fee_ui?: string | number | null;
  fees_updated_at: string | null;
  updated_at: string | null;
  bins: string | object | null; // JSONB column storing bin liquidity data
  bins_updated_at: string | null;
};

const POOL_SELECT_BASE = [
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
    "bins",
    "bins_updated_at",
  ];

const POOL_SELECT = [...POOL_SELECT_BASE, "protocol_fee_vault", "protocol_fee_ui"].join(",");
const POOL_SELECT_LEGACY = POOL_SELECT_BASE.join(",");

function isMissingProtocolColumnsError(error: any): boolean {
  const msg = String(error?.message ?? "").toLowerCase();
  return msg.includes("protocol_fee_vault") || msg.includes("protocol_fee_ui");
}

function listPoolsQuery(selectClause: string, allowedPools: string[] | null) {
  let q = supabase.from("dex_pools").select(selectClause);
  if (allowedPools && allowedPools.length) q = q.in("pool", allowedPools);
  return q;
}

export async function dbListPools(pools?: string[]) {
  const allowedPools = pools && pools.length ? await filterDexTombstonedPools(pools) : null;
  if (allowedPools && allowedPools.length === 0) return [];

  let { data, error } = await listPoolsQuery(POOL_SELECT, allowedPools).returns<DbPool[]>();
  if (error && isMissingProtocolColumnsError(error)) {
    // Backward-compatible fallback if protocol columns are not yet migrated.
    const legacy = await listPoolsQuery(POOL_SELECT_LEGACY, allowedPools).returns<DbPool[]>();
    data = legacy.data;
    error = legacy.error;
  }

  if (error) throw new Error(`dbListPools failed: ${error.message}`);
  const rows = data ?? [];
  if (!rows.length) return rows;

  const filtered = rows.filter((r) => !isDexPoolTombstonedCached(r.pool));
  return filtered;
}

export async function dbGetPool(pool: string) {
  if (await isDexPoolTombstoned(pool)) {
    warnDexPoolTombstoneOnce(pool, "dbGetPool");
    return null;
  }

  let { data, error } = await supabase
    .from("dex_pools")
    .select(POOL_SELECT)
    .eq("pool", pool)
    .maybeSingle();

  if (error && isMissingProtocolColumnsError(error)) {
    const legacy = await supabase
      .from("dex_pools")
      .select(POOL_SELECT_LEGACY)
      .eq("pool", pool)
      .maybeSingle();
    data = legacy.data;
    error = legacy.error;
  }

  if (error) throw new Error(`dbGetPool failed: ${error.message}`);
  return (data ?? null) as DbPool | null;
}

/**
 * LIVE STATE UPDATE
 * - slot-gated
 * - price ONLY written if non-null
 * - active_bin always written
 * - liquidity fields optional (only updated if provided)
 */
export async function dbUpdatePoolLiveState(args: {
  pool: string;
  slot: number;
  signature?: string | null;
  activeBin: number | null;
  lastPriceQuotePerBase: number | null;
  // Optional liquidity fields (updated after withdraw/deposit events)
  liquidityQuote?: number | null;
  tvlLockedQuote?: number | null;
  escrowLpRaw?: string | null;
  lpSupplyRaw?: string | null;
}) {
  const {
    pool,
    slot,
    signature,
    activeBin,
    lastPriceQuotePerBase,
    liquidityQuote,
    tvlLockedQuote,
    escrowLpRaw,
    lpSupplyRaw,
  } = args;

  // slot monotonicity guard
  const gate = `last_update_slot.is.null,last_update_slot.lt.${slot}`;

  const update: Record<string, any> = {
    active_bin: activeBin,
    last_update_slot: slot,
    last_trade_sig: signature ?? null,
    updated_at: new Date().toISOString(),
  };

  // never overwrite price with null
  if (
    lastPriceQuotePerBase != null &&
    Number.isFinite(lastPriceQuotePerBase) &&
    lastPriceQuotePerBase > 0
  ) {
    update.last_price_quote_per_base = lastPriceQuotePerBase;
  }

  // Update liquidity fields if provided
  if (liquidityQuote != null && Number.isFinite(liquidityQuote)) {
    update.liquidity_quote = liquidityQuote;
  }

  if (tvlLockedQuote != null && Number.isFinite(tvlLockedQuote)) {
    update.tvl_locked_quote = tvlLockedQuote;
  }

  if (escrowLpRaw != null) {
    update.escrow_lp_raw = escrowLpRaw;
  }

  if (lpSupplyRaw != null) {
    update.lp_supply_raw = lpSupplyRaw;
  }

  const { error } = await supabase
    .from("dex_pools")
    .update(update)
    .eq("pool", pool)
    .or(gate);

  if (error) throw new Error(`dbUpdatePoolLiveState failed: ${error.message}`);
}
