import { pk } from "../solana.js";
import { env } from "../config.js";
import { readPool } from "./pool_reader.js";
import { supabaseAdmin } from "../lib/supabase_admin.js";

/**
 * Look up pool creation metadata from the poolInit event stored in dex_events.
 * Returns null if no poolInit event is indexed for this pool yet.
 */
async function getPoolCreationInfo(poolId: string): Promise<{
  createdAtBlockNumber?: number;
  createdAtBlockTimestamp?: number;
  createdAtTxnId?: string;
  creator?: string;
} | null> {
  const { data, error } = await supabaseAdmin
    .from("dex_events")
    .select("signature,slot,block_time,event_data")
    .eq("event_type", "poolInit")
    .filter("event_data->>pairId", "eq", poolId)
    .order("slot", { ascending: true })
    .limit(1);

  if (error || !data || data.length === 0) return null;

  const row = data[0] as {
    signature: string;
    slot: number | null;
    block_time: number | null;
    event_data: any;
  };

  const result: {
    createdAtBlockNumber?: number;
    createdAtBlockTimestamp?: number;
    createdAtTxnId?: string;
    creator?: string;
  } = {};

  if (row.slot != null) result.createdAtBlockNumber = row.slot;
  if (row.block_time != null) result.createdAtBlockTimestamp = row.block_time;
  if (row.signature) result.createdAtTxnId = row.signature;

  const creator =
    typeof row.event_data?.creator === "string" && row.event_data.creator.length >= 32
      ? row.event_data.creator
      : null;
  if (creator) result.creator = creator;

  return result;
}

/**
 * Pair schema:
 * - id: pair id (pool address)
 * - dexKey
 * - asset0Id / asset1Id (immutable, follows on-chain baseMint/quoteMint order)
 * - feeBps
 * - createdAtBlockNumber, createdAtBlockTimestamp, createdAtTxnId, creator (from poolInit event)
 */
export async function readPair(id: string) {
  const poolId = pk(id).toBase58();
  const [p, creation] = await Promise.all([
    readPool(poolId),
    getPoolCreationInfo(poolId),
  ]);

  return {
    pair: {
      id: poolId,
      dexKey: env.DEX_KEY,
      asset0Id: p.baseMint,
      asset1Id: p.quoteMint,
      feeBps: p.baseFeeBps ?? undefined,
      ...(creation?.createdAtBlockNumber != null ? { createdAtBlockNumber: creation.createdAtBlockNumber } : {}),
      ...(creation?.createdAtBlockTimestamp != null ? { createdAtBlockTimestamp: creation.createdAtBlockTimestamp } : {}),
      ...(creation?.createdAtTxnId ? { createdAtTxnId: creation.createdAtTxnId } : {}),
      ...(creation?.creator ? { creator: creation.creator } : {}),
    },
  };
}
