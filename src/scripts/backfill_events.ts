// Backfill ALL historic program activity into Supabase.
//
// Writes:
// - dex_events: ALL Anchor events (evt.name) with full logs.
//              If none decoded, writes a fallback "tx" row (logs captured).
// - dex_events: ALSO writes a Gecko-ready "swap" event row *when* we can derive a real Trade
//              and have non-junk pool state (price + reserves).
// - dex_trades: derived swaps (strict vault-delta derivation).
// - dex_pools: upserted whenever we successfully read a pool.
//
// Run:
//   tsx src/scripts/backfill_events.ts
//
// Optional env overrides:
//   BACKFILL_PAGE_SIZE=500
//   BACKFILL_CONCURRENCY=6
//   BACKFILL_BEFORE_SIGNATURE=<sig>        (resume cursor; "before" for getSignaturesForAddress)
//   BACKFILL_SCAN_ACCOUNTS_MAX=60          (fallback scan limit for pool discovery)

import "dotenv/config";
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from "@solana/web3.js";

import { env } from "../config.js";
import { decodeEventsFromLogs, type OrbitDecodedEvent } from "../idl/coder.js";
import { readPool } from "../services/pool_reader.js";
import { deriveTradeFromTransaction } from "../services/trade_derivation.js";
import { upsertDexPool, writeDexEvent, writeDexTrade } from "../supabase.js";
import type { Trade } from "../services/trades_indexer.js";

type BackfillOpts = {
  pageSize: number;
  concurrency: number;
  beforeSignature: string | null;
  scanAccountsMax: number;
};

type PoolView = {
  pool: string;

  baseMint: string;
  quoteMint: string;

  baseDecimals: number;
  quoteDecimals: number;

  baseVault: string;
  quoteVault: string;

  // Needed to write Gecko "swap" event_data without junk:
  // - priceNative must be > 0 (string)
  // - reserves must be present
  priceNumber: number | null;
  reserveBaseAtoms: string | null;
  reserveQuoteAtoms: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const x = Math.floor(n);
  return Math.min(hi, Math.max(lo, x));
}

function parseOpts(): BackfillOpts {
  const pageSizeRaw = Number(process.env.BACKFILL_PAGE_SIZE ?? env.BACKFILL_PAGE_SIZE ?? 500);
  const concurrencyRaw = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
  const beforeSignatureRaw = String(process.env.BACKFILL_BEFORE_SIGNATURE ?? "").trim();
  const scanAccountsMaxRaw = Number(process.env.BACKFILL_SCAN_ACCOUNTS_MAX ?? 60);

  return {
    pageSize: clampInt(pageSizeRaw, 10, 1000, 500),
    concurrency: clampInt(concurrencyRaw, 1, 20, 6),
    beforeSignature: beforeSignatureRaw.length ? beforeSignatureRaw : null,
    scanAccountsMax: clampInt(scanAccountsMaxRaw, 5, 200, 60),
  };
}

function toLogs(tx: VersionedTransactionResponse | null): string[] {
  const logs = tx?.meta?.logMessages ?? null;
  if (!logs || !Array.isArray(logs)) return [];
  const out: string[] = [];
  for (const x of logs) if (typeof x === "string") out.push(x);
  return out;
}

function getAccountKeys(tx: VersionedTransactionResponse): PublicKey[] {
  const msg = tx.transaction.message;

  // legacy
  if ("accountKeys" in msg) {
    const ks = msg.accountKeys as PublicKey[];
    return Array.isArray(ks) ? ks : [];
  }

  // v0
  const staticKeys = msg.staticAccountKeys;
  const loadedW = tx.meta?.loadedAddresses?.writable ?? [];
  const loadedR = tx.meta?.loadedAddresses?.readonly ?? [];
  return [...staticKeys, ...loadedW, ...loadedR];
}

function safeEventData(d: OrbitDecodedEvent["data"] | null | undefined): Record<string, unknown> | null {
  if (!d || typeof d !== "object") return null;
  return d as Record<string, unknown>;
}

/**
 * Best-effort pool discovery from decoded event payload.
 * (Your Anchor events sometimes contain pool/poolId/pairId.)
 */
function eventCandidatePools(evt: OrbitDecodedEvent): string[] {
  const d = evt.data;
  const out: string[] = [];

  const pool = typeof (d as any)?.pool === "string" ? (d as any).pool : null;

  const poolId = typeof (d as any)?.poolId === "string" ? (d as any).poolId : null;

  const pairId = typeof (d as any)?.pairId === "string" ? (d as any).pairId : null;

  if (pool) out.push(pool);
  if (poolId) out.push(poolId);
  if (pairId) out.push(pairId);

  return out;
}

function uniqStrings(xs: string[]): string[] {
  const s = new Set<string>();
  for (const x of xs) if (x && typeof x === "string") s.add(x);
  return [...s];
}

/**
 * Decimalize bigint atoms into a decimal string (no rounding, trims trailing zeros).
 * This matches your earlier events.ts helper and is safe for Gecko payloads.
 */
function decimalize(atoms: bigint, decimals: number): string {
  const sign = atoms < 0n ? "-" : "";
  const x = atoms < 0n ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = x % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length ? `${sign}${whole.toString()}.${fracStr}` : `${sign}${whole.toString()}`;
}

function isPositiveNumber(n: number | null): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

async function loadPoolCached(cache: Map<string, PoolView>, pool: string): Promise<PoolView | null> {
  const hit = cache.get(pool);
  if (hit) return hit;

  try {
    const v = await readPool(pool);

    // NOTE: your readPool() (from earlier code) exposes these:
    // - baseMint/quoteMint, baseDecimals/quoteDecimals
    // - baseVault/quoteVault
    // - priceNumber
    // - binReserveBaseAtoms/binReserveQuoteAtoms
    //
    // If any of these differ in your actual implementation, adjust the field names here.
    const pv: PoolView = {
      pool,
      baseMint: String((v as any).baseMint),
      quoteMint: String((v as any).quoteMint),
      baseDecimals: Number((v as any).baseDecimals),
      quoteDecimals: Number((v as any).quoteDecimals),
      baseVault: String((v as any).baseVault),
      quoteVault: String((v as any).quoteVault),
      priceNumber: (v as any).priceNumber === null ? null : Number((v as any).priceNumber),

      reserveBaseAtoms:
        typeof (v as any).binReserveBaseAtoms === "string" || typeof (v as any).binReserveBaseAtoms === "number"
          ? String((v as any).binReserveBaseAtoms)
          : null,
      reserveQuoteAtoms:
        typeof (v as any).binReserveQuoteAtoms === "string" || typeof (v as any).binReserveQuoteAtoms === "number"
          ? String((v as any).binReserveQuoteAtoms)
          : null,
    };

    cache.set(pool, pv);
    return pv;
  } catch {
    return null;
  }
}

/**
 * Deterministic txnIndex:
 * - For a given slot, fetch the block (signatures only) and map signature->index.
 * - Cache per slot for speed.
 *
 * Important for Gecko determinism: /events is ordered by (slot, txn_index, event_index).
 */
type TxnIndexCacheEntry = { ts: number; map: Map<string, number> };
const TXN_INDEX_CACHE = new Map<number, TxnIndexCacheEntry>();
const TXN_INDEX_TTL_MS = 60_000;

async function getTxnIndexForSignature(connection: Connection, slot: number, sig: string): Promise<number> {
  const now = Date.now();
  const hit = TXN_INDEX_CACHE.get(slot);

  if (hit && now - hit.ts < TXN_INDEX_TTL_MS) {
    return hit.map.get(sig) ?? 0;
  }

  const map = new Map<string, number>();

  try {
    const block = await connection.getBlock(slot, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "signatures",
      rewards: false,
    });

    const sigs: string[] = [];
    const anyBlock = block as any;

    // Some RPCs return `signatures: string[]`
    if (Array.isArray(anyBlock?.signatures)) {
      for (const s of anyBlock.signatures) if (typeof s === "string") sigs.push(s);
    }
    // Others return `transactions: [{ transaction: { signatures: string[] } }]`
    else if (Array.isArray(anyBlock?.transactions)) {
      for (const t of anyBlock.transactions) {
        const s0 = t?.transaction?.signatures?.[0];
        if (typeof s0 === "string") sigs.push(s0);
      }
    }

    for (let i = 0; i < sigs.length; i++) map.set(sigs[i]!, i);
  } catch {
    // ignore; fallback txnIndex=0
  }

  TXN_INDEX_CACHE.set(slot, { ts: now, map });
  return map.get(sig) ?? 0;
}

/**
 * Build the Gecko-ready dex_events.event_data payload for event_type='swap'
 * as expected by your DB-backed events.ts:
 *
 * {
 *   maker?: string,
 *   pairId: string,
 *   asset0In?, asset1In?, asset0Out?, asset1Out?,
 *   priceNative: string,
 *   reserves: { asset0: string, asset1: string }
 * }
 */
function buildGeckoSwapEventData(args: {
  trade: Trade;
  pool: PoolView;
}): Record<string, unknown> | null {
  const { trade, pool } = args;

  // Hard correctness: Gecko halts on junk priceNative/reserves.
  if (!isPositiveNumber(pool.priceNumber)) return null;
  if (!pool.reserveBaseAtoms || !pool.reserveQuoteAtoms) return null;

  let reserveBase: bigint;
  let reserveQuote: bigint;
  try {
    reserveBase = BigInt(pool.reserveBaseAtoms);
    reserveQuote = BigInt(pool.reserveQuoteAtoms);
  } catch {
    return null;
  }

  const reserves = {
    asset0: decimalize(reserveBase, pool.baseDecimals),
    asset1: decimalize(reserveQuote, pool.quoteDecimals),
  };

  // Trade must have raw amounts + mints to emit amounts
  const hasAmounts = !!trade.amountIn && !!trade.amountOut && !!trade.inMint && !!trade.outMint;

  let asset0In: string | undefined;
  let asset1In: string | undefined;
  let asset0Out: string | undefined;
  let asset1Out: string | undefined;

  if (hasAmounts) {
    try {
      const inAtoms = BigInt(trade.amountIn!);
      const outAtoms = BigInt(trade.amountOut!);

      // asset0 = base, asset1 = quote
      if (trade.inMint === pool.baseMint && trade.outMint === pool.quoteMint) {
        asset0In = decimalize(inAtoms, pool.baseDecimals);
        asset1Out = decimalize(outAtoms, pool.quoteDecimals);
      } else if (trade.inMint === pool.quoteMint && trade.outMint === pool.baseMint) {
        asset1In = decimalize(inAtoms, pool.quoteDecimals);
        asset0Out = decimalize(outAtoms, pool.baseDecimals);
      }
      // else: mint mismatch (don’t emit amounts)
    } catch {
      // don’t emit amounts
    }
  }

  const payload: Record<string, unknown> = {
    pairId: pool.pool,
    priceNative: String(pool.priceNumber),
    reserves,
  };

  if (trade.user) payload.maker = trade.user;

  // Only include amounts if they satisfy Gecko “one-side in, other-side out”
  if (asset0In && asset1Out) {
    payload.asset0In = asset0In;
    payload.asset1Out = asset1Out;
  } else if (asset1In && asset0Out) {
    payload.asset1In = asset1In;
    payload.asset0Out = asset0Out;
  }

  return payload;
}

async function processSignature(params: {
  connection: Connection;
  programIdStr: string;
  sigInfo: ConfirmedSignatureInfo;
  opts: BackfillOpts;
  poolCache: Map<string, PoolView>;
}): Promise<{ signature: string; wroteEvents: number; wroteTrades: number; wroteGeckoSwaps: number; skipped: boolean }> {
  const { connection, programIdStr, sigInfo, opts, poolCache } = params;

  const signature = sigInfo.signature;

  let tx: VersionedTransactionResponse | null = null;
  try {
    tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    return { signature, wroteEvents: 0, wroteTrades: 0, wroteGeckoSwaps: 0, skipped: true };
  }

  if (!tx) return { signature, wroteEvents: 0, wroteTrades: 0, wroteGeckoSwaps: 0, skipped: true };

  const slot = typeof tx.slot === "number" ? tx.slot : null;
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;

  // Deterministic per-slot ordering
  const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, signature) : 0;

  const logs = toLogs(tx);
  const decoded = decodeEventsFromLogs(logs);

  // 1) Persist raw Anchor event rows (and fallback "tx") to dex_events
  if (decoded.length === 0) {
    await writeDexEvent({
      signature,
      slot,
      blockTime,
      programId: programIdStr,
      eventType: "tx",
      txnIndex,
      eventIndex: 0,
      eventData: null,
      logs,
    });
  } else {
    for (let i = 0; i < decoded.length; i += 1) {
      const evt = decoded[i]!;
      await writeDexEvent({
        signature,
        slot,
        blockTime,
        programId: programIdStr,
        eventType: evt.name,
        txnIndex,
        eventIndex: i,
        eventData: safeEventData(evt.data),
        logs,
      });
    }
  }

  const wroteEvents = decoded.length === 0 ? 1 : decoded.length;

  // 2) Discover candidate pools (events first, then account-scan fallback)
  const poolsFromEvents = uniqStrings(decoded.flatMap(eventCandidatePools));
  const pools: string[] = [...poolsFromEvents];

  if (pools.length === 0) {
    const keys = getAccountKeys(tx);
    const max = Math.min(keys.length, opts.scanAccountsMax);

    for (let i = 0; i < max; i += 1) {
      const addr = keys[i]!.toBase58();
      const pv = await loadPoolCached(poolCache, addr);
      if (pv) pools.push(addr);
    }
  }

  // Deterministic per-tx order if multiple pools matched
  const uniqPools = uniqStrings(pools).sort((a, b) => a.localeCompare(b));

  let wroteTrades = 0;
  let wroteGeckoSwaps = 0;

  // We may derive multiple swaps in one tx (multi-pool). Ensure stable eventIndex for event_type='swap'.
  let swapEventIndex = 0;

  for (const poolAddr of uniqPools) {
    const pv = await loadPoolCached(poolCache, poolAddr);
    if (!pv) continue;

    // keep dex_pools fresh
    await upsertDexPool({
      pool: pv.pool,
      programId: programIdStr,
      baseMint: pv.baseMint,
      quoteMint: pv.quoteMint,
      baseDecimals: pv.baseDecimals,
      quoteDecimals: pv.quoteDecimals,
      // lastPriceQuotePerBase: pv.priceNumber,
    });

    // Derive strict swap trade (vault delta)
    const trade = deriveTradeFromTransaction(tx, {
      pool: pv.pool,
      baseVault: pv.baseVault,
      quoteVault: pv.quoteVault,
      baseMint: pv.baseMint,
      quoteMint: pv.quoteMint,
    });

    if (!trade) continue;

    await writeDexTrade(trade);
    wroteTrades += 1;

    // ALSO write Gecko-ready "swap" row for /events consumers (Coingecko adapter)
    const geckoData = buildGeckoSwapEventData({ trade, pool: pv });
    if (geckoData) {
      await writeDexEvent({
        signature,
        slot,
        blockTime,
        programId: programIdStr,
        eventType: "swap",
        txnIndex,
        eventIndex: swapEventIndex++,
        eventData: geckoData,
        logs,
      });
      wroteGeckoSwaps += 1;
    }
  }

  return { signature, wroteEvents, wroteTrades, wroteGeckoSwaps, skipped: false };
}

async function run(): Promise<void> {
  const opts = parseOpts();

  const connection = new Connection(env.SOLANA_RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  const programId = new PublicKey(env.ORBIT_PROGRAM_ID);
  const programIdStr = programId.toBase58();

  let before: string | undefined = opts.beforeSignature ?? undefined;

  let totalTx = 0;
  let totalEventRows = 0;
  let totalTrades = 0;
  let totalGeckoSwaps = 0;
  let page = 0;

  const poolCache = new Map<string, PoolView>();

  console.log(`[backfill] program=${programIdStr}`);
  console.log(`[backfill] rpc=${env.SOLANA_RPC_URL}`);
  console.log(
    `[backfill] pageSize=${opts.pageSize} concurrency=${opts.concurrency} scanAccountsMax=${opts.scanAccountsMax}`
  );
  if (before) console.log(`[backfill] resume_before=${before}`);

  while (true) {
    page += 1;

    let sigs: ConfirmedSignatureInfo[] = [];
    try {
      sigs = await connection.getSignaturesForAddress(programId, {
        limit: opts.pageSize,
        before,
      });
    } catch {
      console.log(`[backfill] getSignaturesForAddress failed page=${page}, backing off...`);
      await sleep(1500);
      page -= 1;
      continue;
    }

    if (sigs.length === 0) {
      console.log(
        `[backfill] done. pages=${page - 1} tx=${totalTx} eventRows=${totalEventRows} trades=${totalTrades} geckoSwaps=${totalGeckoSwaps}`
      );
      break;
    }

    before = sigs[sigs.length - 1]!.signature;

    let idx = 0;
    while (idx < sigs.length) {
      const chunk = sigs.slice(idx, idx + opts.concurrency);
      idx += opts.concurrency;

      const results = await Promise.all(
        chunk.map((sigInfo) =>
          processSignature({
            connection,
            programIdStr,
            sigInfo,
            opts,
            poolCache,
          }).catch(() => ({
            signature: sigInfo.signature,
            wroteEvents: 0,
            wroteTrades: 0,
            wroteGeckoSwaps: 0,
            skipped: true,
          }))
        )
      );

      for (const r of results) {
        totalTx += 1;
        totalEventRows += r.wroteEvents;
        totalTrades += r.wroteTrades;
        totalGeckoSwaps += r.wroteGeckoSwaps;
      }
    }

    console.log(
      `[backfill] page=${page} fetched=${sigs.length} totalTx=${totalTx} eventRows=${totalEventRows} trades=${totalTrades} geckoSwaps=${totalGeckoSwaps} before=${before}`
    );
  }
}

run().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[backfill] fatal: ${msg}`);
  process.exit(1);
});