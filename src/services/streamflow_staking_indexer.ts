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

async function flushVaultNow(vault: VaultState) {
  const supa = await getSupa();
  if (!supa) {
    console.log("[streamflow_staking] no supa client (missing SUPABASE_URL / SERVICE_ROLE_KEY)");
    // still clear dirty flags so we don't grow forever in memory
    vault.dirtyOwners.clear();
    vault.dirtyTotals = false;
    return;
  }

  const nowIso = new Date().toISOString();

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
              await flushVaultNow(st);
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