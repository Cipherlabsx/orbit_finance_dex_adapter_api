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

function isOnConflictTargetError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  return (
    msg.toLowerCase().includes("on conflict") ||
    msg.toLowerCase().includes("constraint") ||
    msg.toLowerCase().includes("duplicate key") ||
    msg.toLowerCase().includes("there is no unique or exclusion constraint") ||
    msg.toLowerCase().includes("conflict target")
  );
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
    if (!isOnConflictTargetError(error)) break;
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
}) {
  await upsertWithFallback(
    "dex_pools",
    {
      pool: p.pool,
      program_id: p.programId,
      base_mint: p.baseMint,
      quote_mint: p.quoteMint,
      base_decimals: p.baseDecimals,
      quote_decimals: p.quoteDecimals,
      updated_at: nowIso(),
    },
    ["pool"]
  );
}

export async function writeDexTrade(trade: Trade) {
  if (!trade.inMint || !trade.outMint || !trade.amountIn || !trade.amountOut) return;

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

  await upsertWithFallback("dex_trades", row, ["signature,pool", "signature"]);
}

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

  await upsertWithFallback("dex_events", row, [
    "slot,txn_index,event_index,event_type",
    "signature,event_index,event_type",
    "signature,event_index",
  ]);
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

  if (readErr) throw new Error(`updateDexPoolLiveState read failed: ${readErr.message}`);

  const curSlot = (cur?.last_update_slot ?? null) as number | null;
  if (curSlot != null && params.slot <= curSlot) {
    return;
  }

  /** never overwrite price with null */
  const update: Record<string, any> = {
    active_bin: params.activeBin,
    last_update_slot: params.slot,
    last_trade_sig: params.signature,
    updated_at: nowIso(),
  };

  if (params.priceQuotePerBase != null && Number.isFinite(params.priceQuotePerBase)) {
    update.last_price_quote_per_base = params.priceQuotePerBase;
  }

  const { error: updErr } = await supabase
    .from("dex_pools")
    .update(update)
    .eq("pool", params.pool);

  if (updErr) throw new Error(`updateDexPoolLiveState update failed: ${updErr.message}`);
}