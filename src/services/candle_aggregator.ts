import type { Trade, TradeStore } from "./trades_indexer.js";
import { readPool } from "./pool_reader.js";
import { env } from "../config.js";

type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export const TF_LIST: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

const TF_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

function gapFillCandlesAsc(
  candlesAsc: PublicCandle[],
  tf: Timeframe
): PublicCandle[] {
  const step = TF_SEC[tf];
  if (candlesAsc.length === 0) return candlesAsc;

  const out: PublicCandle[] = [];
  let prev = candlesAsc[0]!;

  // normalize first candle time to bucket boundary
  const firstT = Math.floor(prev.time / step) * step;
  prev = { ...prev, time: firstT };
  out.push(prev);

  for (let i = 1; i < candlesAsc.length; i++) {
    const cur0 = candlesAsc[i]!;
    const curT = Math.floor(cur0.time / step) * step;

    // fill missing buckets with flat candles
    let t = prev.time + step;
    while (t < curT) {
      out.push({
        time: t,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volumeQuote: 0,
        tradesCount: 0,
      });
      t += step;
    }

    const cur: PublicCandle = { ...cur0, time: curT };
    out.push(cur);
    prev = cur;
  }

  return out;
}

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

function toUi(rawAtoms: string | null, decimals: number): number {
  if (!rawAtoms) return 0;
  const n = Number(rawAtoms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const denom = 10 ** decimals;
  const ui = n / denom;
  return Number.isFinite(ui) ? ui : 0;
}

function floorBucketStartSec(tsSec: number, tf: Timeframe): number {
  const step = TF_SEC[tf];
  return Math.floor(tsSec / step) * step;
}

function bucketStartIso(tsBucketStartSec: number): string {
  return new Date(tsBucketStartSec * 1000).toISOString();
}

type Candle = {
  pool: string;
  tf: Timeframe;
  bucketStartSec: number;

  open: number;
  high: number;
  low: number;
  close: number;

  volumeQuote: number;
  tradesCount: number;

  updatedAtMs: number;
};

/**
 * Derive a "tick" from a trade:
 * - requires both legs are base+quote
 * - returns price = quote per 1 base
 * - returns volumeQuote in quote units
 */
function tradeToTick(
  meta: PoolMeta,
  t: Trade
): { tsSec: number; price: number; volumeQuote: number } | null {
  const tsSec =
    typeof t.blockTime === "number" && t.blockTime && t.blockTime > 0
      ? t.blockTime
      : Math.floor(Date.now() / 1000);

  const inMint = t.inMint ?? "";
  const outMint = t.outMint ?? "";

  const isBaseQuote =
    (inMint === meta.baseMint && outMint === meta.quoteMint) ||
    (inMint === meta.quoteMint && outMint === meta.baseMint);

  if (!isBaseQuote) return null;

  const amountInUiBase = inMint === meta.baseMint ? toUi(t.amountIn, meta.baseDecimals) : 0;
  const amountInUiQuote = inMint === meta.quoteMint ? toUi(t.amountIn, meta.quoteDecimals) : 0;

  const amountOutUiBase = outMint === meta.baseMint ? toUi(t.amountOut, meta.baseDecimals) : 0;
  const amountOutUiQuote = outMint === meta.quoteMint ? toUi(t.amountOut, meta.quoteDecimals) : 0;

  const baseUi = amountInUiBase > 0 ? amountInUiBase : amountOutUiBase;
  const quoteUi = amountInUiQuote > 0 ? amountInUiQuote : amountOutUiQuote;

  if (!(baseUi > 0) || !(quoteUi > 0)) return null;

  const price = quoteUi / baseUi;
  if (!Number.isFinite(price) || price <= 0) return null;

  return { tsSec, price, volumeQuote: quoteUi };
}

function applyTick(
  c: Candle | null,
  tick: { tsSec: number; price: number; volumeQuote: number },
  pool: string,
  tf: Timeframe
) {
  const bucketStartSec = floorBucketStartSec(tick.tsSec, tf);
  const nowMs = Date.now();

  if (!c || c.bucketStartSec !== bucketStartSec) {
    const p = tick.price;
    const vq = tick.volumeQuote;

    const next: Candle = {
      pool,
      tf,
      bucketStartSec,
      open: p,
      high: p,
      low: p,
      close: p,
      volumeQuote: Number.isFinite(vq) ? vq : 0,
      tradesCount: 1,
      updatedAtMs: nowMs,
    };

    return next;
  }

  const p = tick.price;
  c.high = Math.max(c.high, p);
  c.low = Math.min(c.low, p);
  c.close = p;
  c.volumeQuote += Number.isFinite(tick.volumeQuote) ? tick.volumeQuote : 0;
  c.tradesCount += 1;
  c.updatedAtMs = nowMs;

  return c;
}

type PerPoolCandleState = {
  seen: Set<string>;
  cur: Map<Timeframe, Candle>;
  dirty: Map<string, Candle>; // key = `${tf}:${bucketStartSec}`
};

export type CandleStore = {
  byPool: Map<string, PerPoolCandleState>;
};

export function createCandleStore(): CandleStore {
  return { byPool: new Map() };
}

function stateForPool(store: CandleStore, pool: string): PerPoolCandleState {
  const hit = store.byPool.get(pool);
  if (hit) return hit;

  const st: PerPoolCandleState = {
    seen: new Set(),
    cur: new Map(),
    dirty: new Map(),
  };

  store.byPool.set(pool, st);
  return st;
}

function markDirty(st: PerPoolCandleState, candle: Candle) {
  const k = `${candle.tf}:${candle.bucketStartSec}`;
  st.dirty.set(k, candle);
}

/**
 * Ingest trades from TradeStore into CandleStore.
 * - tradeStore arrays are newest-first, we walk oldest->newest
 * - we dedupe by `${sig}:${pool}`
 */
export async function ingestCandlesFromTradeStore(
  candleStore: CandleStore,
  tradeStore: TradeStore,
  pools: string[]
) {
  for (const pool of pools) {
    const st = stateForPool(candleStore, pool);
    const trades: Trade[] = tradeStore.byPool.get(pool) ?? [];
    if (trades.length === 0) continue;

    const meta = await getPoolMeta(pool);

    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i]!;
      const seenKey = `${t.signature}:${t.pool}`;
      if (st.seen.has(seenKey)) continue;
      st.seen.add(seenKey);

      const tick = tradeToTick(meta, t);
      if (!tick) continue;

      for (const tf of TF_LIST) {
        const cur = st.cur.get(tf) ?? null;
        const next = applyTick(cur, tick, pool, tf);
        st.cur.set(tf, next);
        markDirty(st, next);
      }
    }
  }
}

// --------------------------
// Public getters (for routes)
// --------------------------

export type PublicCandle = {
  time: number; // bucketStartSec (UTC seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volumeQuote: number;
  tradesCount: number;
};

function toPublic(c: Candle): PublicCandle {
  return {
    time: c.bucketStartSec,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volumeQuote: c.volumeQuote,
    tradesCount: c.tradesCount,
  };
}

/**
 * In-memory only (current candle per TF).
 * If you want historical series, serve from DB or keep ring buffers.
 */
export async function getCandles(candleStore: CandleStore, pool: string, tf: Timeframe, limit = 500) {
  // DB authoritative
  const dbCandlesAsc = await readCandlesFromDb(pool, tf, limit);

  if (dbCandlesAsc.length > 0) {
    const filled = gapFillCandlesAsc(dbCandlesAsc, tf);
    return { pool, tf, candles: filled, ts: Date.now(), source: "db" as const };
  }

  // fallback to in-memory if DB not available / empty
  const st = candleStore.byPool.get(pool);
  const cur = st?.cur.get(tf) ?? null;
  const candles = cur ? [toPublic(cur)] : [];
  return { pool, tf, candles: candles.slice(0, limit), ts: Date.now(), source: "mem" as const };
}

export function getCandlesBundle(candleStore: CandleStore, pool: string, limit = 500) {
  const st = candleStore.byPool.get(pool);

  const tfs: Record<Timeframe, PublicCandle[]> = {
    "1m": [],
    "5m": [],
    "15m": [],
    "30m": [],
    "1h": [],
    "4h": [],
    "1d": [],
  };

  if (!st) return { pool, tfs, ts: Date.now() };

  for (const tf of TF_LIST) {
    const cur = st.cur.get(tf) ?? null;
    tfs[tf] = cur ? [toPublic(cur)].slice(0, limit) : [];
  }

  return { pool, tfs, ts: Date.now() };
}

// DB flush (indexer-only)

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

async function readCandlesFromDb(pool: string, tf: Timeframe, limit: number): Promise<PublicCandle[]> {
  const supa = await getSupa();
  if (!supa) return [];

  const { data, error } = await supa
    .from("dex_pool_candles")
    .select("bucket_start, open, high, low, close, volume_quote, trades_count")
    .eq("pool", pool)
    .eq("tf", tf)
    .order("bucket_start", { ascending: false })
    .limit(limit);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[candles] db read failed:", error.message ?? error);
    return [];
  }

  // ascending for chart + gap-fill
  return (data ?? [])
    .slice()
    .reverse()
    .map((r: any) => ({
      time: Math.floor(new Date(r.bucket_start).getTime() / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volumeQuote: Number(r.volume_quote ?? 0),
      tradesCount: Number(r.trades_count ?? 0),
    }));
}

type CandleRow = {
  pool: string;
  tf: Timeframe;
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_quote: number;
  trades_count: number;
  updated_at?: string;
};

async function flushCandlesToDb(candleStore: CandleStore) {
  const supa = await getSupa();
  if (!supa) return;

  const rows: CandleRow[] = [];
  const nowIso = new Date().toISOString();

  for (const [pool, st] of candleStore.byPool.entries()) {
    if (st.dirty.size === 0) continue;

    for (const c of st.dirty.values()) {
      rows.push({
        pool,
        tf: c.tf,
        bucket_start: bucketStartIso(c.bucketStartSec),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume_quote: c.volumeQuote,
        trades_count: c.tradesCount,
        updated_at: nowIso,
      });
    }

    st.dirty.clear();
  }

  if (rows.length === 0) return;

  const { error } = await supa.from("dex_pool_candles").upsert(rows, {
    onConflict: "pool,tf,bucket_start",
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[candles_aggregator] db flush failed:", error.message ?? error);
  }
}

/**
 * Start candle aggregation loop:
 * - ingests from tradeStore frequently
 * - flushes dirty candles to DB in batches
 */
export function startCandleAggregator(opts: {
  tradeStore: TradeStore;
  candleStore: CandleStore;
  pools: string[];

  tickMs?: number;
  flushMs?: number;
  writeToDb?: boolean;
}) {
  const {
    tradeStore,
    candleStore,
    pools,
    tickMs = Number((env as any).CANDLES_TICK_MS ?? 250),
    flushMs = Number((env as any).CANDLES_FLUSH_MS ?? 1000),
    writeToDb = String((env as any).CANDLES_WRITE_DB ?? "true") === "true",
  } = opts;

  let stopped = false;
  let lastFlush = 0;

  const tick = async () => {
    if (stopped) return;

    try {
      await ingestCandlesFromTradeStore(candleStore, tradeStore, pools);

      const now = Date.now();
      if (writeToDb && now - lastFlush >= flushMs) {
        lastFlush = now;
        await flushCandlesToDb(candleStore);
      }
    } catch (e) {
      console.error(`[CANDLE_AGG] Error in tick loop:`, e);
      // keep loop alive but log the error
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

