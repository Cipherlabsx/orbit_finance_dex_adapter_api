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

export type StandardsEventsResponse = {
  events: StandardsSwapEvent[];
};

// ---- Validation of persisted payload (dex_events.event_data) ----
//
// For Step 1 we expect the ingestion path to store Gecko-ready payload in event_data.
// If it's not there yet, events will be skipped (to avoid halting the indexer with junk).
//
const SwapEventDataSchema = z.object({
  maker: z.string().min(1).optional(),
  pairId: z.string().min(32),

  asset0In: z.string().optional(),
  asset1In: z.string().optional(),
  asset0Out: z.string().optional(),
  asset1Out: z.string().optional(),

  priceNative: z.string().min(1),
  reserves: z.object({
    asset0: z.string().min(1),
    asset1: z.string().min(1),
  }),
});

function isPositiveDecimalString(x: string): boolean {
  const n = Number(x);
  return Number.isFinite(n) && n > 0;
}

/**
 * Enforces Gecko rule:
 * - either (asset0In + asset1Out) OR (asset1In + asset0Out) OR none.
 * If malformed, drop amounts (but keep event) to avoid schema-halting.
 */
function normalizeAmounts(args: {
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

  // Gecko will halt on priceNative=0 or invalid
  if (!isPositiveDecimalString(d.priceNative)) return null;

  // Reserves must be numeric-ish (at least parseable)
  const r0 = Number(d.reserves.asset0);
  const r1 = Number(d.reserves.asset1);
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;

  const amounts = normalizeAmounts({
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

/**
 * /events?fromBlock&toBlock (inclusive)
 * DB-backed and deterministic.
 *
 * Note: we keep the first parameter for route compatibility,
 * but we ignore it since DB is the source-of-truth for Gecko.
 */
export async function readEventsBySlotRange(
  _storeIgnored: unknown,
  fromSlot: number,
  toSlot: number
): Promise<StandardsEventsResponse> {
  if (toSlot < fromSlot) return { events: [] };

  const { data, error } = await supabaseAdmin
    .from("dex_events")
    .select("signature,slot,block_time,event_type,txn_index,event_index,event_data")
    .eq("event_type", "swap")
    .gte("slot", fromSlot)
    .lte("slot", toSlot)
    .order("slot", { ascending: true })
    .order("txn_index", { ascending: true })
    .order("event_index", { ascending: true });

  if (error) return { events: [] };

  const rows = (data ?? []) as DexEventRow[];
  const events: StandardsSwapEvent[] = [];

  for (const row of rows) {
    const ev = rowToSwapEvent(row);
    if (ev) events.push(ev);
  }
  return { events };
}

/**
 * /latest-block
 * Gecko rule: latest-block MUST be the latest block where /events has data available.
 *
 * Implementation: max(slot) from dex_events.
 * Fallback: if DB empty (fresh boot), return chain slot.
 */
export async function readLatestBlock(): Promise<{ block: StandardsBlock }> {
  // Must reflect the latest slot for which /events will return data.
  // Since /events serves ONLY event_type='swap', latest-block must be based on that too.
  const { data, error } = await supabaseAdmin
    .from("dex_events")
    .select("slot.max(), block_time.max()")
    .eq("event_type", "swap")
    .not("slot", "is", null);

  const row = (data?.[0] ?? null) as { max?: number | null; max_1?: number | null } | null;
  const maxSlot = row?.max ?? null;
  const maxBlockTime = row?.max_1 ?? null;

  if (!error && maxSlot != null) {
    return {
      block: {
        blockNumber: maxSlot,
        blockTimestamp: maxBlockTime ?? Math.floor(Date.now() / 1000),
      },
    };
  }

  // Fallback if DB empty (fresh boot)
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  return {
    block: {
      blockNumber: slot,
      blockTimestamp: blockTime ?? Math.floor(Date.now() / 1000),
    },
  };
}