import { env } from "../config.js";
import type { Connection } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";

/**
 * Streamflow realtime staking indexer:
 * - Hydrate current balances from DB on boot
 * - Listen to new stake/unstake txs via onLogs mentions
 * - Immediately upsert/delete changed owners + update vault totals
 */

const TX_OPTS = {
  commitment: "finalized" as const,
  maxSupportedTransactionVersion: 0,
};

type VaultRow = {
  id: number;
  token_mint: string;
  scan_address: string;
  stake_program: string;
  decimals: number;
  enabled: boolean;
};

type StakeRow = {
  vault_id: number;
  owner: string;
  staked_raw: string; // bigint-as-string
  updated_at?: string;
};

type EventRow = {
  vault_id: number;
  signature: string;
  block_time: number;
  slot: number;
  owner: string;
  delta_raw: string; // bigint-as-string
  balance_after_raw: string; // bigint-as-string
  processed_at?: string;
};

type VaultState = {
  // config
  id: number;
  tokenMint: string;
  scanAddress: string;
  stakeProgram: string;
  decimals: number;

  // state (positive-only)
  byOwner: Map<string, bigint>; // owner -> staked_raw (>0)
  holders: bigint; // count of owners with >0
  total: bigint; // sum of staked_raw (>0)

  // dedupe
  seenSigs: Set<string>;

  // dirty tracking (for immediate flush)
  dirtyOwners: Set<string>;
  dirtyTotals: boolean;
};

export type StreamflowStakeStore = {
  byVaultId: Map<number, VaultState>;
  // fast query by owner across vaults
  byOwner: Map<string, Map<number, bigint>>;
};

export function createStreamflowStakeStore(): StreamflowStakeStore {
  return { byVaultId: new Map(), byOwner: new Map() };
}

// helpers

function bigFromTokenAmountString(amountStr: unknown): bigint {
  // ONLY accept the integer string from uiTokenAmount.amount
  if (typeof amountStr !== "string" || !amountStr) return 0n;
  return BigInt(amountStr);
}

function txTouchesStakeProgram(tx: any, programId: string): boolean {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  for (const line of logs) {
    if (typeof line === "string" && line.includes(`Program ${programId} `)) return true;
  }
  return false;
}

type OwnerDelta = Map<string, bigint>;

type TransactionMetadata = {
  signature: string;
  blockTime: number | null;
  slot: number;
};

function computeOwnerDeltasLikeStakeJson(tx: any, mint: string): OwnerDelta {
  const out: OwnerDelta = new Map();

  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];

  const preMap = new Map<number, { owner: string | null; amt: bigint }>();
  for (const b of pre) {
    if (b?.mint !== mint) continue;
    const owner = (b?.owner ?? null) as string | null;
    const amt = bigFromTokenAmountString(b?.uiTokenAmount?.amount);
    preMap.set(Number(b?.accountIndex ?? -1), { owner, amt });
  }

  const postMap = new Map<number, { owner: string | null; amt: bigint }>();
  for (const b of post) {
    if (b?.mint !== mint) continue;
    const owner = (b?.owner ?? null) as string | null;
    const amt = bigFromTokenAmountString(b?.uiTokenAmount?.amount);
    postMap.set(Number(b?.accountIndex ?? -1), { owner, amt });
  }

  const indices = new Set<number>([...preMap.keys(), ...postMap.keys()]);
  for (const idx of indices) {
    const a = preMap.get(idx);
    const b = postMap.get(idx);

    const owner = (b?.owner ?? a?.owner) ?? null;
    if (!owner) continue;

    const preAmt = a?.amt ?? 0n;
    const postAmt = b?.amt ?? 0n;

    const delta = postAmt - preAmt; 
    if (delta === 0n) continue;

    const stakedChange = -delta; 
    out.set(owner, (out.get(owner) ?? 0n) + stakedChange);
  }

  return out;
}

export function fmtUiFromRaw(raw: string, decimals: number): string {
  const r = raw.trim();
  if (!r) return "0";
  if (decimals <= 0) return r;

  const neg = r.startsWith("-");
  const digits = neg ? r.slice(1) : r;

  const pad = decimals + 1;
  const s = digits.length >= pad ? digits : "0".repeat(pad - digits.length) + digits;

  const intPart = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, "");
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");

  const out = fracPart.length ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

// db

let SUPA: any | null = null;

async function getSupa(): Promise<any | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  if (SUPA) return SUPA;
  const m = await import("@supabase/supabase-js");
  SUPA = m.createClient(url, key, { auth: { persistSession: false } });
  return SUPA;
}

async function fetchEnabledVaults(): Promise<VaultRow[]> {
  const supa = await getSupa();
  if (!supa) return [];

  const { data, error } = await supa
    .from("streamflow_vaults")
    .select("id, token_mint, scan_address, stake_program, decimals, enabled")
    .eq("enabled", true);

  if (error) throw error;
  return (data ?? []) as VaultRow[];
}

// store state

function ensureVaultState(store: StreamflowStakeStore, v: VaultRow): VaultState {
  const hit = store.byVaultId.get(v.id);
  if (hit) return hit;

  const st: VaultState = {
    id: v.id,
    tokenMint: String(v.token_mint),
    scanAddress: String(v.scan_address),
    stakeProgram: String(v.stake_program),
    decimals: Number(v.decimals ?? 0),

    byOwner: new Map(),
    holders: 0n,
    total: 0n,

    seenSigs: new Set(),
    dirtyOwners: new Set(),
    dirtyTotals: false,
  };

  store.byVaultId.set(v.id, st);
  return st;
}

/**
 * realtime deltas require a correct starting point.
 * So we load current stakes from DB.
 */
async function hydrateVaultFromDb(store: StreamflowStakeStore, v: VaultRow) {
  const supa = await getSupa();
  if (!supa) return;

  const st = ensureVaultState(store, v);

  // reset vault state
  st.byOwner.clear();
  st.dirtyOwners.clear();
  st.dirtyTotals = false;
  st.holders = 0n;
  st.total = 0n;

  // also clear owner index entries for this vault
  for (const [owner, m] of store.byOwner.entries()) {
    if (m.delete(v.id) && m.size === 0) store.byOwner.delete(owner);
  }

  const { data, error } = await supa
    .from("streamflow_stakes")
    .select("owner, staked_raw")
    .eq("vault_id", v.id);

  if (error) throw error;

  for (const r of data ?? []) {
    const owner = String((r as any).owner);
    const raw = BigInt(String((r as any).staked_raw ?? "0"));
    if (raw <= 0n) continue;

    st.byOwner.set(owner, raw);
    st.holders += 1n;
    st.total += raw;

    const m = store.byOwner.get(owner) ?? new Map<number, bigint>();
    m.set(v.id, raw);
    store.byOwner.set(owner, m);
  }

  // Load seen signatures from events table to prevent reprocessing
  const { data: eventsData, error: eventsError } = await supa
    .from("streamflow_events")
    .select("signature")
    .eq("vault_id", v.id);

  if (!eventsError) {
    for (const e of eventsData ?? []) {
      const sig = String((e as any).signature);
      if (sig) st.seenSigs.add(sig);
    }
  }
}

/**
 * Get the last processed event for a vault to detect where to resume from
 */
async function getLastProcessedEvent(vaultId: number): Promise<{ slot: number; blockTime: number } | null> {
  const supa = await getSupa();
  if (!supa) return null;

  const { data, error } = await supa
    .from("streamflow_events")
    .select("slot, block_time")
    .eq("vault_id", vaultId)
    .order("slot", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[streamflow_staking] failed to get last event:", error.message ?? error);
    return null;
  }

  if (!data) return null;

  return {
    slot: Number((data as any).slot),
    blockTime: Number((data as any).block_time),
  };
}

/**
 * Fetch and process missing transactions since last processed event
 */
async function recoverMissingTransactions(
  connection: Connection,
  store: StreamflowStakeStore,
  vault: VaultState,
  scanAddress: string,
  writeToDb: boolean
): Promise<number> {
  const lastEvent = await getLastProcessedEvent(vault.id);
  const addr = new PK(scanAddress);

  // Fetch signatures since last processed event (or last 100 if no events yet)
  const limit = lastEvent ? 1000 : 100;
  const sigInfos = await connection.getSignaturesForAddress(addr, { limit });

  let processedCount = 0;

  for (const sigInfo of sigInfos.reverse()) {
    const sig = sigInfo.signature;
    if (!sig) continue;

    // Skip if already seen or if it's older than our last processed event
    if (vault.seenSigs.has(sig)) continue;
    if (lastEvent && sigInfo.slot && sigInfo.slot <= lastEvent.slot) continue;

    try {
      const tx = await connection.getTransaction(sig, TX_OPTS as any);
      if (!tx) continue;

      if (!txTouchesStakeProgram(tx, vault.stakeProgram)) continue;

      const deltas = computeOwnerDeltasLikeStakeJson(tx, vault.tokenMint);
      if (!deltas.size) continue;

      vault.seenSigs.add(sig);
      applyDeltasToStore(store, vault, deltas);

      if (writeToDb) {
        const txMeta: TransactionMetadata = {
          signature: sig,
          blockTime: tx.blockTime ?? null,
          slot: tx.slot,
        };
        await writeEventsAndFlushVault(vault, deltas, txMeta);
      }

      processedCount++;
    } catch (err) {
      console.error(`[streamflow_staking] failed to process tx ${sig}:`, err);
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 100));
  }

  return processedCount;
}

function applyDeltasToStore(store: StreamflowStakeStore, vault: VaultState, deltas: OwnerDelta) {
  for (const [owner, d] of deltas.entries()) {
    if (d === 0n) continue;

    const cur = vault.byOwner.get(owner) ?? 0n; // cur is positive-only
    const next = cur + d;

    const wasHolder = cur > 0n;
    const nextPos = next > 0n ? next : 0n;

    const isHolder = nextPos > 0n;

    if (wasHolder && !isHolder) vault.holders -= 1n;
    if (!wasHolder && isHolder) vault.holders += 1n;

    // total tracks positive-only
    vault.total = vault.total - cur + nextPos;

    if (nextPos === 0n) {
      vault.byOwner.delete(owner);
      vault.dirtyOwners.add(owner);
      vault.dirtyTotals = true;

      const m = store.byOwner.get(owner);
      if (m) {
        m.delete(vault.id);
        if (m.size === 0) store.byOwner.delete(owner);
      }
      continue;
    }

    vault.byOwner.set(owner, nextPos);
    vault.dirtyOwners.add(owner);
    vault.dirtyTotals = true;

    const m = store.byOwner.get(owner) ?? new Map<number, bigint>();
    m.set(vault.id, nextPos);
    store.byOwner.set(owner, m);
  }
}

async function writeEventsAndFlushVault(
  vault: VaultState,
  deltas: OwnerDelta,
  txMeta: TransactionMetadata
) {
  const supa = await getSupa();
  if (!supa) {
    console.log("[streamflow_staking] no supa client (missing SUPABASE_URL / SERVICE_ROLE_KEY)");
    // still clear dirty flags so we don't grow forever in memory
    vault.dirtyOwners.clear();
    vault.dirtyTotals = false;
    return;
  }

  const nowIso = new Date().toISOString();
  const blockTime = txMeta.blockTime ?? Math.floor(Date.now() / 1000);

  // 1. Write events (immutable audit trail)
  const events: EventRow[] = [];
  for (const [owner, delta] of deltas.entries()) {
    if (delta === 0n) continue;

    const balanceAfter = vault.byOwner.get(owner) ?? 0n;
    events.push({
      vault_id: vault.id,
      signature: txMeta.signature,
      block_time: blockTime,
      slot: txMeta.slot,
      owner,
      delta_raw: delta.toString(),
      balance_after_raw: balanceAfter.toString(),
      processed_at: nowIso,
    });
  }

  if (events.length) {
    const { error } = await supa
      .from("streamflow_events")
      .insert(events);
    if (error) {
      // If duplicate, it's fine (idempotency)
      if (!error.message?.includes("duplicate") && !error.message?.includes("unique")) {
        console.error("[streamflow_staking] event insert failed:", error.message ?? error);
      }
    }
  }

  // 2. Update current stakes (state table)
  const upserts: StakeRow[] = [];
  const deletes: string[] = [];

  for (const owner of vault.dirtyOwners.values()) {
    const raw = vault.byOwner.get(owner);
    if (raw === undefined || raw <= 0n) {
      deletes.push(owner);
    } else {
      upserts.push({
        vault_id: vault.id,
        owner,
        staked_raw: raw.toString(),
        updated_at: nowIso,
      });
    }
  }
  vault.dirtyOwners.clear();

  if (upserts.length) {
    const { error } = await supa
      .from("streamflow_stakes")
      .upsert(upserts, { onConflict: "vault_id,owner" });
    if (error) console.error("[streamflow_staking] stake upsert failed:", error.message ?? error);
  }

  if (deletes.length) {
    const { error } = await supa
      .from("streamflow_stakes")
      .delete()
      .eq("vault_id", vault.id)
      .in("owner", deletes);
    if (error) console.error("[streamflow_staking] stake delete failed:", error.message ?? error);
  }

  // 3. Update vault totals
  if (vault.dirtyTotals) {
    vault.dirtyTotals = false;
    const { error } = await supa
      .from("streamflow_vaults")
      .update({
        holders_count: vault.holders.toString(),
        total_staked_raw: vault.total.toString(),
        updated_at: nowIso,
      })
      .eq("id", vault.id);

    if (error) console.error("[streamflow_staking] vault totals update failed:", error.message ?? error);
  }
}

// queries
export function listStreamflowVaults(store: StreamflowStakeStore) {
  return Array.from(store.byVaultId.values()).map((v) => ({
    id: v.id,
    tokenMint: v.tokenMint,
    scanAddress: v.scanAddress,
    stakeProgram: v.stakeProgram,
    decimals: v.decimals,
    holders_raw: v.holders.toString(),
    total_staked_raw: v.total.toString(),
    total_staked_ui: fmtUiFromRaw(v.total.toString(), v.decimals),
  }));
}

export function getOwnerStreamflowStakes(store: StreamflowStakeStore, owner: string) {
  const m = store.byOwner.get(owner);
  if (!m) return [];

  const out: Array<{
    vaultId: number;
    tokenMint: string;
    decimals: number;
    staked_raw: string;
    staked_ui: string;
  }> = [];

  for (const [vaultId, raw] of m.entries()) {
    const v = store.byVaultId.get(vaultId);
    if (!v) continue;
    out.push({
      vaultId,
      tokenMint: v.tokenMint,
      decimals: v.decimals,
      staked_raw: raw.toString(),
      staked_ui: fmtUiFromRaw(raw.toString(), v.decimals),
    });
  }

  out.sort((a, b) => (BigInt(b.staked_raw) > BigInt(a.staked_raw) ? 1 : -1));
  return out;
}

/**
 * Query historical events for an owner from the database
 */
export async function getOwnerStreamflowEvents(opts: {
  owner: string;
  vaultId?: number;
  limit?: number;
  offset?: number;
}) {
  const supa = await getSupa();
  if (!supa) return [];

  let query = supa
    .from("streamflow_events")
    .select("vault_id, signature, block_time, slot, owner, delta_raw, balance_after_raw, processed_at")
    .eq("owner", opts.owner)
    .order("block_time", { ascending: false });

  if (opts.vaultId !== undefined) {
    query = query.eq("vault_id", opts.vaultId);
  }

  if (opts.limit !== undefined) {
    query = query.limit(opts.limit);
  }

  if (opts.offset !== undefined) {
    query = query.range(opts.offset, opts.offset + (opts.limit ?? 100) - 1);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[streamflow_staking] failed to query events:", error.message ?? error);
    return [];
  }

  return (data ?? []).map((e: any) => ({
    vaultId: Number(e.vault_id),
    signature: String(e.signature),
    blockTime: Number(e.block_time),
    slot: Number(e.slot),
    owner: String(e.owner),
    deltaRaw: String(e.delta_raw),
    balanceAfterRaw: String(e.balance_after_raw),
    processedAt: String(e.processed_at),
  }));
}

/**
 * Get event statistics for a vault
 */
export async function getVaultEventStats(vaultId: number) {
  const supa = await getSupa();
  if (!supa) return null;

  const { data, error } = await supa
    .from("streamflow_events")
    .select("slot, block_time")
    .eq("vault_id", vaultId)
    .order("slot", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[streamflow_staking] failed to get vault stats:", error.message ?? error);
    return null;
  }

  if (!data) {
    return { lastSlot: null, lastBlockTime: null, eventCount: 0 };
  }

  const countResult = await supa
    .from("streamflow_events")
    .select("*", { count: "exact", head: true })
    .eq("vault_id", vaultId);

  return {
    lastSlot: Number((data as any).slot),
    lastBlockTime: Number((data as any).block_time),
    eventCount: countResult.count ?? 0,
  };
}

// main service
export function startStreamflowStakingAggregator(opts: {
  connection: Connection;
  stakeStore: StreamflowStakeStore;
  writeToDb?: boolean;
}) {
  const { connection, stakeStore, writeToDb = env.STREAMFLOW_WRITE_DB } = opts;

  let stopped = false;
  const subs: number[] = [];

  const boot = async () => {
    const vaults = await fetchEnabledVaults();

    // ensure + hydrate from DB snapshot
    for (const v of vaults) {
      ensureVaultState(stakeStore, v);
      await hydrateVaultFromDb(stakeStore, v);
    }

    // recover any missing transactions since last boot
    if (writeToDb) {
      console.log("[streamflow_staking] checking for missing transactions...");
      for (const v of vaults) {
        if (stopped) break;
        const vault = stakeStore.byVaultId.get(v.id);
        if (!vault) continue;

        try {
          const recovered = await recoverMissingTransactions(
            connection,
            stakeStore,
            vault,
            v.scan_address,
            writeToDb
          );
          if (recovered > 0) {
            console.log(`[streamflow_staking] vault ${v.id}: recovered ${recovered} missing transactions`);
          }
        } catch (err) {
          console.error(`[streamflow_staking] vault ${v.id}: recovery failed:`, err);
        }
      }
      console.log("[streamflow_staking] recovery complete");
    }

    // subscribe per vault scan address
    for (const v of vaults) {
      if (stopped) break;

      const addr = new PK(v.scan_address);
      const subId = connection.onLogs(
        { mentions: [addr] } as any,
        async (ev) => {
          try {
            if (stopped) return;

            const sig = ev?.signature;
            if (!sig) return;

            const st = stakeStore.byVaultId.get(v.id);
            if (!st) return;

            if (st.seenSigs.has(sig)) return;

            const tx = await connection.getTransaction(sig, TX_OPTS as any);
            if (!tx) return;

            if (!txTouchesStakeProgram(tx, st.stakeProgram)) return;

            const deltas = computeOwnerDeltasLikeStakeJson(tx, st.tokenMint);
            if (!deltas.size) return;

            st.seenSigs.add(sig);
            applyDeltasToStore(stakeStore, st, deltas);

            if (writeToDb) {
              const txMeta: TransactionMetadata = {
                signature: sig,
                blockTime: tx.blockTime ?? null,
                slot: tx.slot,
              };
              await writeEventsAndFlushVault(st, deltas, txMeta);
            } else {
              // don't let dirty sets grow if db writes disabled
              st.dirtyOwners.clear();
              st.dirtyTotals = false;
            }
          } catch {
            // keep alive
          }
        },
        "finalized"
      );

      subs.push(subId);
    }
  };

  boot().catch(() => {});

  return {
    stop: async () => {
      stopped = true;
      for (const id of subs) {
        try {
          await connection.removeOnLogsListener(id);
        } catch {}
      }
      subs.length = 0;
    },
  };
}