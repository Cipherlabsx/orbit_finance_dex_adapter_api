import type { Trade, TradeStore } from "./trades_indexer.js";
import type { DbPool } from "./pool_db.js";
import { dbListPools } from "./pool_db.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout } from "@solana/spl-token";

type FeeUi = {
  creator: number;
  holders: number;
  nft: number;
};

type FeeStoreState = {
  // pool -> latest fee ui values
  byPool: Map<string, FeeUi>;
  // pool -> last refresh ms
  lastRefreshMs: Map<string, number>;
  // pool -> scheduled refresh timer
  timers: Map<string, NodeJS.Timeout>;
  // cached fee vault addrs (from DB)
  vaults: Map<string, { creator: string | null; holders: string | null; nft: string | null }>;
};

export type FeesStore = FeeStoreState;

function num(x: unknown, fallback = 0): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function getSupaServiceClient(): Promise<any | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const m = await import("@supabase/supabase-js");
  return m.createClient(url, key, { auth: { persistSession: false } });
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let CONN: Connection | null = null;
function getConn(): Connection {
  if (!CONN) {
    CONN = new Connection(mustEnv("SOLANA_RPC_URL"), {
      commitment: "processed",
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 10_000,
    });
  }
  return CONN;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function decodeTokenAccount(data: Buffer | Uint8Array): { mint: string; amountRaw: bigint } | null {
  try {
    const acc = AccountLayout.decode(data);
    const mint = new PublicKey(acc.mint).toBase58();
    const amountRaw = acc.amount as unknown as bigint;
    return { mint, amountRaw };
  } catch {
    return null;
  }
}

async function fetchMintDecimals(conn: Connection, mints: string[]): Promise<Map<string, number>> {
  const uniq = Array.from(new Set(mints)).filter(Boolean);
  const out = new Map<string, number>();
  if (uniq.length === 0) return out;

  const keys = uniq.map((m) => new PublicKey(m));
  for (const b of chunk(keys, 100)) {
    const infos = await conn.getMultipleAccountsInfo(b, "processed");
    for (let i = 0; i < b.length; i++) {
      const k = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;
      try {
        const mint = MintLayout.decode(info.data);
        out.set(k, Number(mint.decimals));
      } catch {}
    }
  }
  return out;
}

function toUi(raw: bigint, decimals: number): number {
  const denom = 10 ** decimals;
  const ui = Number(raw) / denom;
  return Number.isFinite(ui) ? ui : 0;
}

async function readFeeVaultUiBalances(vaults: string[]): Promise<Map<string, number>> {
  const conn = getConn();
  const uniq = Array.from(new Set(vaults)).filter(Boolean);
  const ui = new Map<string, number>();
  if (uniq.length === 0) return ui;

  const keys = uniq.map((v) => new PublicKey(v));
  const mintByVault = new Map<string, string>();
  const rawByVault = new Map<string, bigint>();
  const discoveredMints: string[] = [];

  for (const b of chunk(keys, 100)) {
    const infos = await conn.getMultipleAccountsInfo(b, "processed");
    for (let i = 0; i < b.length; i++) {
      const vaultPk = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;
      const dec = decodeTokenAccount(info.data);
      if (!dec) continue;
      mintByVault.set(vaultPk, dec.mint);
      rawByVault.set(vaultPk, dec.amountRaw);
      discoveredMints.push(dec.mint);
    }
  }

  const decMap = await fetchMintDecimals(conn, discoveredMints);

  for (const [vaultPk, raw] of rawByVault.entries()) {
    const mint = mintByVault.get(vaultPk);
    const dec = mint ? decMap.get(mint) : undefined;
    ui.set(vaultPk, dec == null ? 0 : toUi(raw, dec));
  }

  return ui;
}

export function createFeesStore(): FeesStore {
  return {
    byPool: new Map(),
    lastRefreshMs: new Map(),
    timers: new Map(),
    vaults: new Map(),
  };
}

/**
 * Load fee vault addresses from DB once at startup.
 */
export async function initFeesFromDb(feesStore: FeesStore, pools: string[]) {
  const rows: DbPool[] = await dbListPools(pools);

  for (const r of rows) {
    feesStore.vaults.set(r.pool, {
      creator: r.creator_fee_vault ?? null,
      holders: r.holders_fee_vault ?? null,
      nft: r.nft_fee_vault ?? null,
    });

    feesStore.byPool.set(r.pool, {
      creator: num(r.creator_fee_ui, 0),
      holders: num(r.holders_fee_ui, 0),
      nft: num(r.nft_fee_ui, 0),
    });
  }
}

async function writeFeesToDb(pool: string, fees: FeeUi) {
  const supa = await getSupaServiceClient();
  if (!supa) return;

  const patch = {
    creator_fee_ui: fees.creator,
    holders_fee_ui: fees.holders,
    nft_fee_ui: fees.nft,
    fees_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supa.from("dex_pools").update(patch).eq("pool", pool);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[fees_aggregator] db update failed:", pool, error.message ?? error);
  }
}

/**
 * Refresh fee vault balances for a pool (batched reads).
 */
export async function refreshFeesForPool(feesStore: FeesStore, pool: string) {
  const v = feesStore.vaults.get(pool);
  if (!v) return;

  const vaultList = [v.creator, v.holders, v.nft].filter(Boolean) as string[];
  if (vaultList.length === 0) return;

  const uiByVault = await readFeeVaultUiBalances(vaultList);

  const next: FeeUi = {
    creator: v.creator ? uiByVault.get(v.creator) ?? 0 : 0,
    holders: v.holders ? uiByVault.get(v.holders) ?? 0 : 0,
    nft: v.nft ? uiByVault.get(v.nft) ?? 0 : 0,
  };

  feesStore.byPool.set(pool, next);
  feesStore.lastRefreshMs.set(pool, Date.now());

  // persist so frontend can “stream from DB”
  await writeFeesToDb(pool, next);
}

/**
 * Debounce updates per pool so if multiple swaps land quickly,
 * you refresh once per short window.
 */
export function onNewTradeForFees(opts: {
  feesStore: FeesStore;
  tradeStore: TradeStore;
  trade: Trade;
  debounceMs?: number;   // default 500ms
  minIntervalMs?: number; // default 1000ms
}) {
  const { feesStore, trade, debounceMs = 500, minIntervalMs = 1000 } = opts;
  const pool = trade.pool;

  const last = feesStore.lastRefreshMs.get(pool) ?? 0;
  const now = Date.now();

  // hard guard: don’t refresh more often than minInterval
  if (now - last < minIntervalMs) {
    // schedule one refresh after the interval if none scheduled
    if (!feesStore.timers.has(pool)) {
      const wait = Math.max(0, minIntervalMs - (now - last));
      const t = setTimeout(async () => {
        feesStore.timers.delete(pool);
        try {
          await refreshFeesForPool(feesStore, pool);
        } catch (err) {
          console.error(`[FEES_AGG] Failed to refresh fees for ${pool}:`, err);
        }
      }, wait);
      feesStore.timers.set(pool, t);
    }
    return;
  }

  // debounce: collapse bursts into 1 refresh
  const existing = feesStore.timers.get(pool);
  if (existing) clearTimeout(existing);

  const t = setTimeout(async () => {
    feesStore.timers.delete(pool);
    try {
      await refreshFeesForPool(feesStore, pool);
    } catch (err) {
      console.error(`[FEES_AGG] Failed to refresh fees for ${pool}:`, err);
    }
  }, debounceMs);

  feesStore.timers.set(pool, t);
}

/**
 * Start a lightweight fees aggregator loop.
 * It listens for new trades and triggers fee refreshes.
 */
export function startFeesAggregator(opts: {
  tradeStore: TradeStore;
  feesStore: FeesStore;
  pools: string[];
  tickMs?: number;
  debounceMs?: number;
  minIntervalMs?: number;
}) {
  const {
    tradeStore,
    feesStore,
    pools,
    tickMs = 250,
    debounceMs = 500,
    minIntervalMs = 1000,
  } = opts;

  let lastSeenTradeCount = new Map<string, number>();
  let stopped = false;

  // initialize counters
  for (const pool of pools) {
    lastSeenTradeCount.set(pool, tradeStore.byPool.get(pool)?.length ?? 0);
  }

  const interval = setInterval(() => {
    if (stopped) return;

    for (const pool of pools) {
      const trades = tradeStore.byPool.get(pool);
      if (!trades || trades.length === 0) continue;

      const prev = lastSeenTradeCount.get(pool) ?? 0;
      const cur = trades.length;

      if (cur > prev) {
        // process only NEW trades
        for (let i = prev; i < cur; i++) {
          const trade = trades[i];
          if (!trade) continue;

          onNewTradeForFees({
            feesStore,
            tradeStore,
            trade,
            debounceMs,
            minIntervalMs,
          });
        }

        lastSeenTradeCount.set(pool, cur);
      }
    }
  }, tickMs);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);

      // clear pending timers
      for (const t of feesStore.timers.values()) clearTimeout(t);
      feesStore.timers.clear();
    },
  };
}