import { env } from "../config.js";
import { readPool } from "./pool_reader.js";
import type { Trade, TradeStore } from "./trades_indexer.js";

type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "24h" | "1d";

export const TF_LIST: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "24h", "1d"];

const TF_WINDOW_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
  "1d": 24 * 60 * 60,
};

type PoolMeta = {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
};

type PoolMetaCacheEntry = { ts: number; v: PoolMeta };
const POOL_META_CACHE = new Map<string, PoolMetaCacheEntry>();
const POOL_META_TTL_MS = 15_000;

function num(x: unknown, fallback = 0): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

async function getPoolMeta(pool: string): Promise<PoolMeta> {
  const now = Date.now();
  const hit = POOL_META_CACHE.get(pool);
  if (hit && now - hit.ts < POOL_META_TTL_MS) return hit.v;

  const p: any = await readPool(pool);

  const v: PoolMeta = {
    baseMint: String(p.baseMint ?? ""),
    quoteMint: String(p.quoteMint ?? ""),
    baseDecimals: num(p.baseDecimals, 0),
    quoteDecimals: num(p.quoteDecimals, 0),
  };

  POOL_META_CACHE.set(pool, { ts: now, v });
  return v;
}

function toUiAmount(rawAtoms: string | null, decimals: number): number {
  if (!rawAtoms) return 0;
  const n = Number(rawAtoms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const denom = 10 ** decimals;
  const ui = n / denom;
  return Number.isFinite(ui) ? ui : 0;
}

/**
 * Quote-volume contribution:
 * - If quote was spent: inMint == quoteMint => amountIn is quote atoms
 * - If quote was received: outMint == quoteMint => amountOut is quote atoms
 * - Else: 0 (we do NOT price-convert base->quote here, candles handle price)
 */
function quoteContribution(meta: PoolMeta, t: Trade): number {
  const inMint = t.inMint ?? "";
  const outMint = t.outMint ?? "";

  if (inMint === meta.quoteMint) return toUiAmount(t.amountIn, meta.quoteDecimals);
  if (outMint === meta.quoteMint) return toUiAmount(t.amountOut, meta.quoteDecimals);
  return 0;
}

type Entry = { ts: number; q: number };

type PerPoolState = {
  entries: Entry[]; // time-ordered (ascending)
  sums: Record<Timeframe, number>;
  startIdx: Record<Timeframe, number>;
  lastTs: number;

  // trade-level dedupe (per pool)
  seen: Set<string>;
};

export type VolumeStore = {
  byPool: Map<string, PerPoolState>;
};

function blankSums(): Record<Timeframe, number> {
  return { "1m": 0, "5m": 0, "15m": 0, "30m": 0, "1h": 0, "4h": 0, "24h": 0, "1d": 0 };
}
function blankIdx(): Record<Timeframe, number> {
  return { "1m": 0, "5m": 0, "15m": 0, "30m": 0, "1h": 0, "4h": 0, "24h": 0, "1d": 0 };
}

export function createVolumeStore(): VolumeStore {
  return { byPool: new Map() };
}

function stateForPool(store: VolumeStore, pool: string): PerPoolState {
  const hit = store.byPool.get(pool);
  if (hit) return hit;

  const st: PerPoolState = {
    entries: [],
    sums: blankSums(),
    startIdx: blankIdx(),
    lastTs: 0,
    seen: new Set(),
  };

  store.byPool.set(pool, st);
  return st;
}

function applyEntry(st: PerPoolState, ts: number, q: number) {
  st.lastTs = Math.max(st.lastTs, ts);

  // add first
  for (const tf of TF_LIST) st.sums[tf] += q;

  // slide windows
  for (const tf of TF_LIST) {
    const cutoff = st.lastTs - TF_WINDOW_SEC[tf];
    let idx = st.startIdx[tf];
    const arr = st.entries;

    while (idx < arr.length && arr[idx]!.ts <= cutoff) {
      st.sums[tf] -= arr[idx]!.q;
      idx++;
    }

    st.startIdx[tf] = idx;
    if (st.sums[tf] < 0) st.sums[tf] = 0;
  }
}

function pruneOld(st: PerPoolState) {
  const arr = st.entries;
  if (arr.length === 0) return;

  const horizon = st.lastTs - (TF_WINDOW_SEC["24h"] + 60); // keep last 24h + 1m buffer
  let keepFrom = 0;
  while (keepFrom < arr.length && arr[keepFrom]!.ts <= horizon) keepFrom++;

  if (keepFrom === 0) return;

  arr.splice(0, keepFrom);

  for (const tf of TF_LIST) {
    st.startIdx[tf] = Math.max(0, st.startIdx[tf] - keepFrom);
  }
}

async function ingestTrade(store: VolumeStore, t: Trade) {
  const pool = t.pool;
  const st = stateForPool(store, pool);

  const seenKey = `${t.signature}:${t.pool}`;
  if (st.seen.has(seenKey)) return;
  st.seen.add(seenKey);

  const meta = await getPoolMeta(pool);
  const q = quoteContribution(meta, t);
  if (!(q > 0)) return;

  const ts =
    typeof t.blockTime === "number" && t.blockTime && t.blockTime > 0
      ? t.blockTime
      : Math.floor(Date.now() / 1000);

  // Usually append
  if (st.entries.length === 0 || ts >= st.entries[st.entries.length - 1]!.ts) {
    st.entries.push({ ts, q });
    applyEntry(st, ts, q);
    pruneOld(st);
    return;
  }

  // Rare out-of-order: insert + recompute (bounded 24h)
  const arr = st.entries;
  let i = arr.length - 1;
  while (i >= 0 && arr[i]!.ts > ts) i--;
  arr.splice(i + 1, 0, { ts, q });

  // reset + replay (entries bounded by 24h anyway)
  st.sums = blankSums();
  st.startIdx = blankIdx();
  st.lastTs = 0;

  for (const e of arr) applyEntry(st, e.ts, e.q);
  pruneOld(st);
}

export function getPoolVolume(volumeStore: VolumeStore, pool: string, tf: Timeframe): number {
  const st = volumeStore.byPool.get(pool);
  if (!st) return 0;
  const v = st.sums[tf];
  return Number.isFinite(v) ? v : 0;
}

export function getPoolVolumesAll(volumeStore: VolumeStore, pool: string): Record<Timeframe, number> {
  const st = volumeStore.byPool.get(pool);
  return st ? { ...st.sums } : { ...blankSums() };
}

/**
 * Ingest new trades from TradeStore into VolumeStore.
 * TradeStore keeps newest-first arrays (unshift). We walk oldest->newest.
 * We stop early when we hit a trade already seen by VolumeStore.
 */
export async function ingestFromTradeStore(volumeStore: VolumeStore, tradeStore: TradeStore, pools: string[]) {
  for (const pool of pools) {
    const st = stateForPool(volumeStore, pool);
    const trades = tradeStore.byPool.get(pool) ?? [];
    if (trades.length === 0) continue;

    // walk from oldest to newest so our volume store remains time-ordered
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i]!;
      const k = `${t.signature}:${t.pool}`;
      if (st.seen.has(k)) {
        // once we hit seen while walking old->new, older ones are also already seen
        continue;
      }
      await ingestTrade(volumeStore, t);
    }
  }
}

// DB flush (indexer-only, NOT routes)

type DbRow = { pool: string; tf: Timeframe; volume_quote: number; updated_at?: string };

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

async function flushToDb(volumeStore: VolumeStore) {
  const supa = await getSupa();
  if (!supa) return;

  const rows: DbRow[] = [];
  const nowIso = new Date().toISOString();

  for (const [pool, st] of volumeStore.byPool.entries()) {
    for (const tf of TF_LIST) {
      const v = Number.isFinite(st.sums[tf]) ? st.sums[tf] : 0;
      rows.push({ pool, tf, volume_quote: v, updated_at: nowIso });
    }
  }

  if (rows.length === 0) return;

  // Upsert into public.dex_pool_volume (pool, tf) PK
  const { error } = await supa.from("dex_pool_volume").upsert(rows, { onConflict: "pool,tf" });
  if (error) {
    // never crash the loop
    // eslint-disable-next-line no-console
    console.error("[volume_aggregator] db flush failed:", error.message ?? error);
  }
}

/**
 * Start rolling volume aggregation.
 * - reads trades from app.tradeStore
 * - updates volumeStore in-memory
 * - flushes to dex_pool_volume
 */
export function startVolumeAggregator(opts: {
  tradeStore: TradeStore;
  volumeStore: VolumeStore;
  pools: string[];

  tickMs?: number;   // how often we ingest from tradeStore
  flushMs?: number;  // how often we upsert to DB
  writeToDb?: boolean;
}) {
  const {
    tradeStore,
    volumeStore,
    pools,
    tickMs = Number((env as any).VOLUME_TICK_MS ?? 500),
    flushMs = Number((env as any).VOLUME_FLUSH_MS ?? 2000),
    writeToDb = String((env as any).VOLUME_WRITE_DB ?? "true") === "true",
  } = opts;

  let stopped = false;
  let lastFlush = 0;

  const tick = async () => {
    if (stopped) return;

    try {
      await ingestFromTradeStore(volumeStore, tradeStore, pools);

      const now = Date.now();
      if (writeToDb && now - lastFlush >= flushMs) {
        lastFlush = now;
        await flushToDb(volumeStore);
      }
    } catch {
      // keep alive
    } finally {
      if (!stopped) setTimeout(tick, tickMs);
    }
  };

  tick();

  return {
    stop() {
      stopped = true;
    },
  };
}