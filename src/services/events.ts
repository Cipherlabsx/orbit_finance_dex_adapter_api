// Contract:
// - /latest-block: MUST return the latest block (Solana slot) for which /events data is available.
//   => reads latest persisted slot from public.dex_events
//
// - /events?fromBlock&toBlock: MUST return complete, deterministic events for the slot range (inclusive).
//   => reads from public.dex_events ordered by (slot, txn_index, event_index)
//
// - We avoid schema-halting junk (priceNative=0, missing required fields) by skipping invalid rows.
//

import { z } from "zod";
import { connection } from "../solana.js";
import { supabaseAdmin } from "../lib/supabase_admin.js";

export type StandardsBlock = {
  blockNumber: number; // Solana slot
  blockTimestamp: number; // unix seconds (no ms)
};

export type StandardsSwapEvent = {
  block: StandardsBlock;
  eventType: "swap";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;
  priceNative: string;
  reserves: {
    asset0: string;
    asset1: string;
  };
};

export type StandardsLiquidityEvent = {
  block: StandardsBlock;
  eventType: "liquidityDeposit" | "liquidityWithdraw";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  asset0Amount: string;
  asset1Amount: string;
  shares: string;
  priceNative: string;
  reserves: {
    asset0: string;
    asset1: string;
  };
};

export type StandardsGenericEvent = {
  block: StandardsBlock;
  eventType: string;
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  [key: string]: any;
};

export type StandardsEvent = StandardsSwapEvent | StandardsLiquidityEvent | StandardsGenericEvent;

export type StandardsEventsResponse = {
  events: StandardsEvent[];
};

// Schemas for persisted event_data
const ReservesSchema = z.object({
  asset0: z.string().min(1),
  asset1: z.string().min(1),
});

const SwapEventDataSchema = z.object({
  maker: z.string().min(1).optional(),
  pairId: z.string().min(32),
  asset0In: z.string().optional(),
  asset1In: z.string().optional(),
  asset0Out: z.string().optional(),
  asset1Out: z.string().optional(),
  priceNative: z.string().min(1),
  reserves: ReservesSchema,
});

const LiquidityEventDataSchema = z.object({
  maker: z.string().min(1).optional(),
  pairId: z.string().min(32),
  asset0Amount: z.string().min(1),
  asset1Amount: z.string().min(1),
  shares: z.string().optional(),
  priceNative: z.string().optional(),
  reserves: ReservesSchema.optional(),
});

function isPositiveDecimalString(x: string): boolean {
  const n = Number(x);
  return Number.isFinite(n) && n > 0;
}

/**
 * either (asset0In + asset1Out) OR (asset1In + asset0Out) OR none.
 * If malformed, drop amounts (but keep event) to avoid schema-halting.
 */
function normalizeSwapAmounts(args: {
  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;
}): Pick<StandardsSwapEvent, "asset0In" | "asset1In" | "asset0Out" | "asset1Out"> {
  const { asset0In, asset1In, asset0Out, asset1Out } = args;

  const has0In = !!asset0In;
  const has1In = !!asset1In;
  const has0Out = !!asset0Out;
  const has1Out = !!asset1Out;

  const ok =
    (!has0In && !has1In && !has0Out && !has1Out) ||
    (has0In && has1Out && !has1In && !has0Out) ||
    (has1In && has0Out && !has0In && !has1Out);

  if (!ok) return {};
  return {
    ...(asset0In ? { asset0In } : {}),
    ...(asset1In ? { asset1In } : {}),
    ...(asset0Out ? { asset0Out } : {}),
    ...(asset1Out ? { asset1Out } : {}),
  };
}

// DB row typing + converters
type DexEventRow = {
  signature: string;
  slot: number | null;
  block_time: number | null;
  event_type: string;
  txn_index: number;
  event_index: number;
  event_data: any;
};

function rowToSwapEvent(row: DexEventRow): StandardsSwapEvent | null {
  if (row.event_type !== "swap") return null;
  if (row.slot == null || row.block_time == null) return null;

  const parsed = SwapEventDataSchema.safeParse(row.event_data ?? {});
  if (!parsed.success) return null;

  const d = parsed.data;

  // Drop invalid swaps (must be >0)
  if (!isPositiveDecimalString(d.priceNative)) return null;

  // Reserves must be parseable numbers
  const r0 = Number(d.reserves.asset0);
  const r1 = Number(d.reserves.asset1);
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;

  const amounts = normalizeSwapAmounts({
    asset0In: d.asset0In,
    asset1In: d.asset1In,
    asset0Out: d.asset0Out,
    asset1Out: d.asset1Out,
  });

  return {
    block: { blockNumber: row.slot, blockTimestamp: row.block_time },
    eventType: "swap",
    txnId: row.signature,
    txnIndex: row.txn_index ?? 0,
    eventIndex: row.event_index ?? 0,
    maker: d.maker ?? "11111111111111111111111111111111",
    pairId: d.pairId,
    ...amounts,
    priceNative: d.priceNative,
    reserves: { asset0: d.reserves.asset0, asset1: d.reserves.asset1 },
  };
}

function rowToLiquidityEvent(row: DexEventRow): StandardsLiquidityEvent | null {
  if (row.slot == null || row.block_time == null) return null;
  if (row.event_type !== "liquidityDeposit" && row.event_type !== "liquidityWithdraw") return null;

  const parsed = LiquidityEventDataSchema.safeParse(row.event_data ?? {});
  if (!parsed.success) return null;

  const d = parsed.data;

  // Reserves optional for liquidity events, but if present must be sane
  const reserves = d.reserves ?? { asset0: "0", asset1: "0" };

  return {
    block: { blockNumber: row.slot, blockTimestamp: row.block_time },
    eventType: row.event_type as "liquidityDeposit" | "liquidityWithdraw",
    txnId: row.signature,
    txnIndex: row.txn_index ?? 0,
    eventIndex: row.event_index ?? 0,
    maker: d.maker ?? "11111111111111111111111111111111",
    pairId: d.pairId,
    asset0Amount: d.asset0Amount,
    asset1Amount: d.asset1Amount,
    shares: d.shares ?? "0",
    priceNative: d.priceNative ?? "0",
    reserves,
  };
}

function rowToEvent(row: DexEventRow): StandardsEvent | null {
  if (row.slot == null || row.block_time == null) return null;

  if (row.event_type === "swap") return rowToSwapEvent(row);

  if (row.event_type === "liquidityDeposit" || row.event_type === "liquidityWithdraw") {
    return rowToLiquidityEvent(row);
  }

  const data = row.event_data ?? {};
  return {
    block: { blockNumber: row.slot, blockTimestamp: row.block_time },
    eventType: row.event_type,
    txnId: row.signature,
    txnIndex: row.txn_index ?? 0,
    eventIndex: row.event_index ?? 0,
    ...data,
  };
}

// Queries

/**
 * /events?fromBlock&toBlock (inclusive)
 * DB-backed and deterministic.
 *
 * Supports optional event type filtering.
 */
export async function readEventsBySlotRange(
  _storeIgnored: unknown,
  fromSlot: number,
  toSlot: number,
  eventTypes?: string[]
): Promise<StandardsEventsResponse> {
  if (!Number.isFinite(fromSlot) || !Number.isFinite(toSlot)) return { events: [] };
  if (toSlot < fromSlot) return { events: [] };

  let query = supabaseAdmin
    .from("dex_events")
    .select("signature,slot,block_time,event_type,txn_index,event_index,event_data")
    .gte("slot", fromSlot)
    .lte("slot", toSlot)
    .order("slot", { ascending: true })
    .order("txn_index", { ascending: true })
    .order("event_index", { ascending: true });

  if (eventTypes && eventTypes.length > 0) {
    query = query.in("event_type", eventTypes);
  }

  const { data, error } = await query;
  if (error) return { events: [] };

  const rows = (data ?? []) as DexEventRow[];
  const events: StandardsEvent[] = [];

  for (const row of rows) {
    const ev = rowToEvent(row);
    if (ev) events.push(ev);
  }

  return { events };
}

/**
 * /latest-block
 * MUST return latest slot for which /events data is available.
 * Source-of-truth: dex_events.max(slot).
 *
 * If table is empty, we fall back to chain head (so clients still get a sane block).
 */
export async function readLatestBlock(): Promise<{ block: StandardsBlock }> {
  // latest persisted slot from DB
  const { data, error } = await supabaseAdmin
    .from("dex_events")
    .select("slot,block_time")
    .not("slot", "is", null)
    .order("slot", { ascending: false })
    .limit(1);

  if (!error && data && data.length > 0) {
    const row = data[0] as { slot: number | null; block_time: number | null };
    const slot = row.slot ?? null;
    if (slot != null) {
      const ts = row.block_time ?? (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
      return { block: { blockNumber: slot, blockTimestamp: ts } };
    }
  }

  // fallback: chain head (only if DB empty / unavailable)
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);

  return {
    block: {
      blockNumber: slot,
      blockTimestamp: blockTime ?? Math.floor(Date.now() / 1000),
    },
  };
}