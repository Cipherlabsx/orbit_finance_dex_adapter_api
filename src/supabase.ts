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
  // PostgREST / Supabase errors vary, these substrings cover the common cases
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
  lastPriceQuotePerBase: number | null;
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
      last_price_quote_per_base: p.lastPriceQuotePerBase,
      updated_at: nowIso(),
    },
    ["pool"] // your schema uses PK(pool)
  );
}

/**
 * Writes ONLY real swaps to dex_trades.
 * - If you keep PK(signature): one row per signature (last one wins)
 * - If you migrate to PK(signature,pool): stores multiple pool trades per tx
 */
export async function writeDexTrade(trade: Trade) {
  // Only persist real swap trades where we derived amounts + mints
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

  // Try first (signature,pool), fallback to old-world (signature)
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

  /**
   * Support BOTH possible schemas:
   *  A) unique/PK(signature,event_index,event_type)
   *  B) unique/PK(signature,event_index)
   */
  await upsertWithFallback("dex_events", row, [
    "slot,txn_index,event_index,event_type",
    "signature,event_index,event_type",
    "signature,event_index",
  ]);
}