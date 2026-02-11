import { createClient } from "@supabase/supabase-js";
import type { Trade } from "./services/trades_indexer.js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

function nowIso() {
  return new Date().toISOString();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

async function upsertWithFallback(
  table: string,
  row: Record<string, any>,
  conflictTargets: string[]
) {
  let lastErr: any = null;

  for (const onConflict of conflictTargets) {
    const { error } = await supabase.from(table).upsert(row, { onConflict });
    if (!error) return;
    lastErr = error;
  }

  throw lastErr;
}

export async function upsertDexPool(p: {
  pool: string;
  programId: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseVault?: string;
  quoteVault?: string;
  lpMint?: string;
  admin?: string;
  baseFeeBps?: number;
  binStepBps?: number;
  activeBin?: number;
  initialBin?: number;
  pausedBits?: number;
  lastPriceQuotePerBase?: number | null;
  escrowLpAta?: string | null;
  escrowLpRaw?: string | null;
  lpSupplyRaw?: string | null;
  liquidityQuote?: number | null;
  tvlLockedQuote?: number | null;
  creatorFeeVault?: string | null;
  holdersFeeVault?: string | null;
  nftFeeVault?: string | null;
}) {
  const row: any = {
    pool: p.pool,
    program_id: p.programId,
    base_mint: p.baseMint,
    quote_mint: p.quoteMint,
    base_decimals: p.baseDecimals,
    quote_decimals: p.quoteDecimals,
    updated_at: nowIso(),
  };

  // Add optional fields if provided
  if (p.baseVault !== undefined) row.base_vault = p.baseVault;
  if (p.quoteVault !== undefined) row.quote_vault = p.quoteVault;
  if (p.lpMint !== undefined) row.lp_mint = p.lpMint;
  if (p.admin !== undefined) row.admin = p.admin;
  if (p.baseFeeBps !== undefined) row.base_fee_bps = p.baseFeeBps;
  if (p.binStepBps !== undefined) row.bin_step_bps = p.binStepBps;
  if (p.activeBin !== undefined) row.active_bin = p.activeBin;
  if (p.initialBin !== undefined) row.initial_bin = p.initialBin;
  if (p.pausedBits !== undefined) row.paused_bits = p.pausedBits;
  if (p.lastPriceQuotePerBase !== undefined && p.lastPriceQuotePerBase !== null && Number.isFinite(p.lastPriceQuotePerBase)) {
    row.last_price_quote_per_base = p.lastPriceQuotePerBase;
  }
  if (p.escrowLpAta !== undefined) row.escrow_lp_ata = p.escrowLpAta;
  if (p.escrowLpRaw !== undefined) row.escrow_lp_raw = p.escrowLpRaw;
  if (p.lpSupplyRaw !== undefined) row.lp_supply_raw = p.lpSupplyRaw;
  if (p.liquidityQuote !== undefined && p.liquidityQuote !== null && Number.isFinite(p.liquidityQuote)) {
    row.liquidity_quote = p.liquidityQuote;
  }
  if (p.tvlLockedQuote !== undefined && p.tvlLockedQuote !== null && Number.isFinite(p.tvlLockedQuote)) {
    row.tvl_locked_quote = p.tvlLockedQuote;
  }
  if (p.creatorFeeVault !== undefined) row.creator_fee_vault = p.creatorFeeVault;
  if (p.holdersFeeVault !== undefined) row.holders_fee_vault = p.holdersFeeVault;
  if (p.nftFeeVault !== undefined) row.nft_fee_vault = p.nftFeeVault;

  await upsertWithFallback("dex_pools", row, ["pool"]);
}

export async function writeDexTrade(trade: Trade) {
  if (!trade.inMint || !trade.outMint || !trade.amountIn || !trade.amountOut) {
    return;
  }

  const row = {
    signature: trade.signature,
    slot: trade.slot ?? null,
    block_time: trade.blockTime ?? nowUnix(),
    pool: trade.pool,
    user_pubkey: trade.user ?? null,
    in_mint: trade.inMint,
    out_mint: trade.outMint,
    amount_in_raw: trade.amountIn,
    amount_out_raw: trade.amountOut,
    inserted_at: nowIso(),
  };

  await upsertWithFallback("dex_trades", row, [
    "signature,pool",
    "signature",
  ]);
}

/**
 * CANONICAL EVENT WRITE
 *
 * Uniqueness is enforced exclusively by:
 *   (program_id, slot, txn_index, event_index)
 *
 * No upserts.
 * No fallbacks.
 * Replays MUST fail loudly.
 */
export async function writeDexEvent(params: {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  programId: string;
  eventType: string;
  txnIndex: number;
  eventIndex: number;
  eventData: any | null;
  logs: string[] | null;
}) {
  const row = {
    signature: params.signature,
    slot: params.slot,
    block_time: params.blockTime,
    program_id: params.programId,
    event_type: params.eventType,
    txn_index: params.txnIndex,
    event_index: params.eventIndex,
    event_data: params.eventData,
    logs: params.logs,
    inserted_at: nowIso(),
  };

  await supabase
    .from("dex_events")
    .insert(row)
    .throwOnError();
}

export async function updateDexPoolLiveState(params: {
  pool: string;
  activeBin: number;
  priceQuotePerBase: number | null;
  slot: number;
  signature: string;
}) {
  const { data: cur, error: readErr } = await supabase
    .from("dex_pools")
    .select("last_update_slot")
    .eq("pool", params.pool)
    .maybeSingle();

  if (readErr) {
    throw new Error(`updateDexPoolLiveState read failed: ${readErr.message}`);
  }

  const curSlot = (cur?.last_update_slot ?? null) as number | null;
  if (curSlot != null && params.slot <= curSlot) {
    return;
  }

  const update: Record<string, any> = {
    active_bin: params.activeBin,
    last_update_slot: params.slot,
    last_trade_sig: params.signature,
    updated_at: nowIso(),
  };

  // Never overwrite price with null
  if (
    params.priceQuotePerBase != null &&
    Number.isFinite(params.priceQuotePerBase)
  ) {
    update.last_price_quote_per_base = params.priceQuotePerBase;
  }

  const { error: updErr } = await supabase
    .from("dex_pools")
    .update(update)
    .eq("pool", params.pool);

  if (updErr) {
    throw new Error(`updateDexPoolLiveState update failed: ${updErr.message}`);
  }
}

export async function updateDexPoolLiquidityState(args: {
  pool: string;
  slot: number;
  liquidityQuote: number;
}) {
  const { pool, slot, liquidityQuote } = args;

  const gate = `latest_liq_event_slot.is.null,latest_liq_event_slot.lt.${slot}`;

  const patch: Record<string, any> = {
    liquidity_quote: liquidityQuote,
    latest_liq_event_slot: slot,
    updated_at: nowIso(),
  };

  const { error } = await supabase
    .from("dex_pools")
    .update(patch)
    .eq("pool", pool)
    .or(gate);

  if (error) {
    throw new Error(`updateDexPoolLiquidityState failed: ${error.message}`);
  }

  console.log(`[SUPABASE] Updated liquidity_quote for ${pool} to ${liquidityQuote} at slot ${slot}`);
}

/**
 * Update pool's locked TVL when LiquidityLocked event occurs
 */
export async function updateDexPoolTvlLocked(params: {
  pool: string;
  slot: number;
  tvlLockedQuote: number;
}): Promise<void> {
  const { pool, slot, tvlLockedQuote } = params;

  // Slot-gating: only update if slot is newer than latest_liq_event_slot
  const gate = `latest_liq_event_slot.is.null,latest_liq_event_slot.lt.${slot}`;

  const { error } = await supabase
    .from("dex_pools")
    .update({
      tvl_locked_quote: tvlLockedQuote,
      latest_liq_event_slot: slot,
      updated_at: nowIso(),
    })
    .eq("pool", pool)
    .or(gate);

  if (error) {
    console.error(`[SUPABASE] Failed to update TVL locked for ${pool}:`, error);
    throw new Error(`updateDexPoolTvlLocked failed: ${error.message}`);
  }

  console.log(`[SUPABASE] Updated tvl_locked_quote for ${pool} to ${tvlLockedQuote} at slot ${slot}`);
}