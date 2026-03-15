import { createClient } from "@supabase/supabase-js";
import type { Trade } from "./services/trades_indexer.js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

type DexPoolTombstoneRow = {
  pool: string;
  policy?: string | null;
};

const DEX_POOL_TOMBSTONE_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.DEX_POOL_TOMBSTONE_CACHE_TTL_MS ?? 30_000) || 30_000
);
const DEX_POOL_TOMBSTONE_WARN_MODE =
  (process.env.DEX_POOL_TOMBSTONE_LOG_MODE ?? "warn_once").toLowerCase() === "silent"
    ? "silent"
    : "warn_once";

let dexPoolTombstoneCache = new Set<string>();
let dexPoolTombstoneCacheFetchedAt = 0;
let dexPoolTombstoneRefreshPromise: Promise<Set<string>> | null = null;
let dexPoolTombstoneTableWarned = false;
const dexPoolTombstoneWarnedContexts = new Set<string>();

function nowIso() {
  return new Date().toISOString();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizePool(pool: string | null | undefined): string | null {
  const p = typeof pool === "string" ? pool.trim() : "";
  return p.length >= 32 ? p : null;
}

function poolCandidateToString(value: unknown, depth = 0): string | null {
  if (value == null || depth > 3) return null;

  if (typeof value === "string") {
    const p = normalizePool(value);
    return p;
  }

  if (typeof value !== "object") return null;

  const v = value as Record<string, unknown> & {
    toBase58?: () => string;
    toString?: (...args: any[]) => string;
  };

  if (typeof v.toBase58 === "function") {
    try {
      const p = normalizePool(v.toBase58());
      if (p) return p;
    } catch {}
  }

  if (typeof v.toString === "function") {
    try {
      const s = v.toString();
      if (s !== "[object Object]") {
        const p = normalizePool(s);
        if (p) return p;
      }
    } catch {}
  }

  const nestedKeys = ["pool", "pairId", "poolId", "pubkey", "publicKey", "key"] as const;
  for (const key of nestedKeys) {
    const nested = poolCandidateToString(v[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function poolFromEventData(eventData: any): string | null {
  if (!eventData || typeof eventData !== "object") return null;
  const obj = eventData as Record<string, unknown>;
  const candidates = [obj.pool, obj.pairId, obj.poolId];
  for (const c of candidates) {
    const p = poolCandidateToString(c);
    if (p) return p;
  }
  return null;
}

async function refreshDexPoolTombstoneCache(force = false): Promise<Set<string>> {
  const now = Date.now();
  if (!force && now - dexPoolTombstoneCacheFetchedAt < DEX_POOL_TOMBSTONE_CACHE_TTL_MS) {
    return dexPoolTombstoneCache;
  }

  if (dexPoolTombstoneRefreshPromise) {
    return dexPoolTombstoneRefreshPromise;
  }

  dexPoolTombstoneRefreshPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from("dex_indexer_pool_tombstones")
        .select("pool,policy")
        .returns<DexPoolTombstoneRow[]>();

      if (error) {
        // Fail open to avoid breaking environments where the tombstone table is not deployed yet.
        if (!dexPoolTombstoneTableWarned) {
          dexPoolTombstoneTableWarned = true;
          console.warn(
            `[TOMBSTONES] Failed to load dex_indexer_pool_tombstones (fail-open): ${error.message}`
          );
        }
        dexPoolTombstoneCacheFetchedAt = now;
        return dexPoolTombstoneCache;
      }

      dexPoolTombstoneCache = new Set(
        (data ?? [])
          .map((r) => normalizePool(r.pool))
          .filter((p): p is string => p != null)
      );
      dexPoolTombstoneCacheFetchedAt = now;
      return dexPoolTombstoneCache;
    } finally {
      dexPoolTombstoneRefreshPromise = null;
    }
  })();

  return dexPoolTombstoneRefreshPromise;
}

export async function primeDexPoolTombstoneCache(): Promise<void> {
  await refreshDexPoolTombstoneCache(true);
}

export function isDexPoolTombstonedCached(pool: string | null | undefined): boolean {
  const p = normalizePool(pool);
  return p ? dexPoolTombstoneCache.has(p) : false;
}

export async function isDexPoolTombstoned(pool: string | null | undefined): Promise<boolean> {
  const p = normalizePool(pool);
  if (!p) return false;
  const cache = await refreshDexPoolTombstoneCache();
  return cache.has(p);
}

export async function filterDexTombstonedPools<T extends string>(pools: readonly T[]): Promise<T[]> {
  if (!Array.isArray(pools) || pools.length === 0) return [];
  const cache = await refreshDexPoolTombstoneCache();
  return pools.filter((pool) => {
    const p = normalizePool(pool);
    return !(p && cache.has(p));
  });
}

export function warnDexPoolTombstoneOnce(pool: string, context: string): void {
  if (DEX_POOL_TOMBSTONE_WARN_MODE !== "warn_once") return;
  const p = normalizePool(pool);
  if (!p) return;
  const key = `${context}:${p}`;
  if (dexPoolTombstoneWarnedContexts.has(key)) return;
  dexPoolTombstoneWarnedContexts.add(key);
  console.warn(`[TOMBSTONES] Skipping tombstoned pool ${p} (${context})`);
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
  reserveBaseUi?: number | null;
  reserveQuoteUi?: number | null;
  creatorFeeVault?: string | null;
  holdersFeeVault?: string | null;
  nftFeeVault?: string | null;
  protocolFeeVault?: string | null;
}) {
  if (await isDexPoolTombstoned(p.pool)) {
    warnDexPoolTombstoneOnce(p.pool, "upsertDexPool");
    return;
  }

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
  if (p.reserveBaseUi !== undefined && p.reserveBaseUi !== null && Number.isFinite(p.reserveBaseUi)) {
    row.reserve_base_ui = p.reserveBaseUi;
  }
  if (p.reserveQuoteUi !== undefined && p.reserveQuoteUi !== null && Number.isFinite(p.reserveQuoteUi)) {
    row.reserve_quote_ui = p.reserveQuoteUi;
  }
  if (p.creatorFeeVault !== undefined) row.creator_fee_vault = p.creatorFeeVault;
  if (p.holdersFeeVault !== undefined) row.holders_fee_vault = p.holdersFeeVault;
  if (p.nftFeeVault !== undefined) row.nft_fee_vault = p.nftFeeVault;
  if (p.protocolFeeVault !== undefined) row.protocol_fee_vault = p.protocolFeeVault;

  try {
    await upsertWithFallback("dex_pools", row, ["pool"]);
  } catch (error: any) {
    const msg = String(error?.message ?? "").toLowerCase();
    if (msg.includes("protocol_fee_vault")) {
      // Backward-compatible fallback if protocol_fee_vault column is not migrated yet.
      const legacyRow = { ...row };
      delete legacyRow.protocol_fee_vault;
      await upsertWithFallback("dex_pools", legacyRow, ["pool"]);
      return;
    }
    throw error;
  }
}

export async function writeDexTrade(trade: Trade) {
  if (await isDexPoolTombstoned(trade.pool)) {
    warnDexPoolTombstoneOnce(trade.pool, "writeDexTrade");
    return;
  }

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
  pool?: string | null;
}) {
  const eventPool = normalizePool(params.pool) ?? poolFromEventData(params.eventData);
  if (await isDexPoolTombstoned(eventPool)) {
    warnDexPoolTombstoneOnce(eventPool!, "writeDexEvent");
    return;
  }

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
  if (await isDexPoolTombstoned(params.pool)) {
    warnDexPoolTombstoneOnce(params.pool, "updateDexPoolLiveState");
    return;
  }

  const { data: cur, error: readErr } = await supabase
    .from("dex_pools")
    .select("last_update_slot,last_trade_sig")
    .eq("pool", params.pool)
    .maybeSingle();

  if (readErr) {
    throw new Error(`updateDexPoolLiveState read failed: ${readErr.message}`);
  }

  const curSlot = (cur?.last_update_slot ?? null) as number | null;
  const curSig = (cur as any)?.last_trade_sig as string | null | undefined;
  if (curSlot != null) {
    if (params.slot < curSlot) return;
    if (params.slot === curSlot && curSig === params.signature) return;
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
  if (await isDexPoolTombstoned(pool)) {
    warnDexPoolTombstoneOnce(pool, "updateDexPoolLiquidityState");
    return;
  }

  const gate = `latest_liq_event_slot.is.null,latest_liq_event_slot.lte.${slot}`;

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
  if (await isDexPoolTombstoned(pool)) {
    warnDexPoolTombstoneOnce(pool, "updateDexPoolTvlLocked");
    return;
  }

  // Allow same-slot updates too; Solana frequently has multiple relevant txs in one slot.
  const gate = `latest_liq_event_slot.is.null,latest_liq_event_slot.lte.${slot}`;

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

// NFT STAKING
export type NftStakeRow = {
  id?: string;
  nft_mint: string;
  owner_wallet: string;
  staked_at: string; // ISO timestamp
  unlock_at: string; // ISO timestamp
  lock_duration_seconds: number;
  status: "active" | "unlocked" | "withdrawn" | "expired";
  reward_tier?: "standard" | "premium" | "legendary";
  reward_multiplier?: number;
  rewards_claimed?: string;
  last_claim_at?: string;
  escrow_pda?: string;
  stake_signature: string;
  withdraw_signature?: string;
  associated_pool?: string;
  nft_collection: string;
  nft_metadata?: Record<string, any>;
};

/**
 * Insert new NFT stake
 */
export async function insertNftStake(stake: Omit<NftStakeRow, "id">): Promise<void> {
  const { error } = await supabase.from("nft_stakes").insert(stake);

  if (error) {
    throw new Error(`insertNftStake failed: ${error.message}`);
  }

  console.log(`[SUPABASE] Inserted NFT stake: ${stake.nft_mint} by ${stake.owner_wallet}`);
}

/**
 * Update NFT stake on unstake
 */
export async function updateNftStakeOnUnstake(params: {
  nftMint: string;
  ownerWallet: string;
  withdrawSignature: string;
  rewardsClaimed?: string;
}): Promise<void> {
  const { nftMint, ownerWallet, withdrawSignature, rewardsClaimed } = params;

  const { error } = await supabase
    .from("nft_stakes")
    .update({
      status: "withdrawn",
      withdraw_signature: withdrawSignature,
      rewards_claimed: rewardsClaimed,
      updated_at: nowIso(),
    })
    .eq("nft_mint", nftMint)
    .eq("owner_wallet", ownerWallet)
    .eq("status", "active");

  if (error) {
    throw new Error(`updateNftStakeOnUnstake failed: ${error.message}`);
  }

  console.log(`[SUPABASE] Updated NFT stake on unstake: ${nftMint}`);
}

/**
 * Update rewards claimed
 */
export async function updateNftStakeRewardsClaimed(params: {
  nftMint: string;
  ownerWallet: string;
  rewardsClaimed: string;
  claimedAt: string;
}): Promise<void> {
  const { nftMint, ownerWallet, rewardsClaimed, claimedAt } = params;

  const { error } = await supabase
    .from("nft_stakes")
    .update({
      rewards_claimed: rewardsClaimed,
      last_claim_at: claimedAt,
      updated_at: nowIso(),
    })
    .eq("nft_mint", nftMint)
    .eq("owner_wallet", ownerWallet)
    .eq("status", "active");

  if (error) {
    throw new Error(`updateNftStakeRewardsClaimed failed: ${error.message}`);
  }

  console.log(`[SUPABASE] Updated rewards claimed: ${rewardsClaimed} for ${nftMint}`);
}

/**
 * Get active NFT stakes for an owner
 */
export async function getActiveNftStakes(ownerWallet: string): Promise<NftStakeRow[]> {
  const { data, error } = await supabase
    .from("nft_stakes")
    .select("*")
    .eq("owner_wallet", ownerWallet)
    .eq("status", "active")
    .order("staked_at", { ascending: false });

  if (error) {
    throw new Error(`getActiveNftStakes failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Get NFT stake by mint
 */
export async function getNftStakeByMint(nftMint: string): Promise<NftStakeRow | null> {
  const { data, error } = await supabase
    .from("nft_stakes")
    .select("*")
    .eq("nft_mint", nftMint)
    .eq("status", "active")
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows returned
    throw new Error(`getNftStakeByMint failed: ${error.message}`);
  }

  return data;
}

/**
 * Mark expired stakes as unlocked
 * Run this periodically to update status
 */
export async function markExpiredStakesAsUnlocked(): Promise<number> {
  const { data, error } = await supabase
    .from("nft_stakes")
    .update({ status: "unlocked", updated_at: nowIso() })
    .eq("status", "active")
    .lt("unlock_at", nowIso())
    .select();

  if (error) {
    throw new Error(`markExpiredStakesAsUnlocked failed: ${error.message}`);
  }

  const count = data?.length || 0;
  if (count > 0) {
    console.log(`[SUPABASE] Marked ${count} expired stakes as unlocked`);
  }

  return count;
}
/**
 * Get NFT staking statistics
 * Returns counts of active/total stakes per collection
 */
export async function getNftStakingStats(collection?: string): Promise<{
  totalStaked: number;
  totalSupply: number | null;
  stakingPercentage: number | null;
  activeStakes: number;
  withdrawnStakes: number;
  unlockedStakes: number;
}> {
  // Build query filters
  let query = supabase
    .from("nft_stakes")
    .select("status");

  if (collection) {
    query = query.eq("nft_collection", collection);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`getNftStakingStats failed: ${error.message}`);
  }

  const stakes = data || [];
  const activeStakes = stakes.filter(s => s.status === "active").length;
  const withdrawnStakes = stakes.filter(s => s.status === "withdrawn").length;
  const unlockedStakes = stakes.filter(s => s.status === "unlocked").length;
  const totalStaked = activeStakes + unlockedStakes;

  // Get total supply from collection config if available
  // For now, return null - this can be enhanced with collection metadata
  const totalSupply = null;
  const stakingPercentage = totalSupply ? (totalStaked / totalSupply) * 100 : null;

  return {
    totalStaked,
    totalSupply,
    stakingPercentage,
    activeStakes,
    withdrawnStakes,
    unlockedStakes,
  };
}
