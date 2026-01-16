// Backfill ALL historic program activity into Supabase.
//
// Writes:
// - dex_events: ALL Anchor events; if none, writes a fallback "tx" row (logs captured)
// - dex_trades: derived swaps (strict vault-delta derivation)
// - dex_pools: upserted whenever we successfully read a pool
//
// Run:
//   tsx src/scripts/backfill_events.ts
//
// Optional env overrides:
//   BACKFILL_PAGE_SIZE=500
//   BACKFILL_CONCURRENCY=6
//   BACKFILL_BEFORE_SIGNATURE=<sig>        (resume cursor)
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
  priceNumber: number | null;
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

function eventCandidatePools(evt: OrbitDecodedEvent): string[] {
  const d = evt.data;
  const out: string[] = [];

  const pool = typeof d.pool === "string" ? d.pool : null;

  const poolId =
    typeof (d as { poolId?: unknown }).poolId === "string"
      ? (d as { poolId: string }).poolId
      : null;

  const pairId =
    typeof (d as { pairId?: unknown }).pairId === "string"
      ? (d as { pairId: string }).pairId
      : null;

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

async function loadPoolCached(cache: Map<string, PoolView>, pool: string): Promise<PoolView | null> {
  const hit = cache.get(pool);
  if (hit) return hit;

  try {
    const v = await readPool(pool);

    const pv: PoolView = {
      pool,
      baseMint: String(v.baseMint),
      quoteMint: String(v.quoteMint),
      baseDecimals: Number(v.baseDecimals),
      quoteDecimals: Number(v.quoteDecimals),
      baseVault: String(v.baseVault),
      quoteVault: String(v.quoteVault),
      priceNumber: v.priceNumber === null ? null : Number(v.priceNumber),
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

async function processSignature(params: {
  connection: Connection;
  programIdStr: string;
  sigInfo: ConfirmedSignatureInfo;
  opts: BackfillOpts;
  poolCache: Map<string, PoolView>;
}): Promise<{ signature: string; wroteEvents: number; wroteTrades: number; skipped: boolean }> {
  const { connection, programIdStr, sigInfo, opts, poolCache } = params;

  const signature = sigInfo.signature;

  let tx: VersionedTransactionResponse | null = null;
  try {
    tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    return { signature, wroteEvents: 0, wroteTrades: 0, skipped: true };
  }

  if (!tx) return { signature, wroteEvents: 0, wroteTrades: 0, skipped: true };

  const slot = typeof tx.slot === "number" ? tx.slot : null;
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;

  // Deterministic per-slot ordering
  const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, signature) : 0;

  const logs = toLogs(tx);
  const decoded = decodeEventsFromLogs(logs);

  // 1) Always write events row(s)
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

  // 2) Materialize swaps -> dex_trades
  // Prefer pool discovery from event data (best)
  const poolsFromEvents = uniqStrings(decoded.flatMap(eventCandidatePools));
  const pools: string[] = [...poolsFromEvents];

  // Fallback discovery: scan some tx accounts and probe readPool()
  if (pools.length === 0) {
    const keys = getAccountKeys(tx);
    const max = Math.min(keys.length, opts.scanAccountsMax);

    for (let i = 0; i < max; i += 1) {
      const addr = keys[i]!.toBase58();
      const pv = await loadPoolCached(poolCache, addr);
      if (pv) pools.push(addr);
    }
  }

  const uniqPools = uniqStrings(pools);

  let wroteTrades = 0;

  for (const pool of uniqPools) {
    const pv = await loadPoolCached(poolCache, pool);
    if (!pv) continue;

    // keep dex_pools fresh
    await upsertDexPool({
      pool: pv.pool,
      programId: programIdStr,
      baseMint: pv.baseMint,
      quoteMint: pv.quoteMint,
      baseDecimals: pv.baseDecimals,
      quoteDecimals: pv.quoteDecimals,
      lastPriceQuotePerBase: pv.priceNumber,
    });

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
  }

  return { signature, wroteEvents, wroteTrades, skipped: false };
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
        `[backfill] done. pages=${page - 1} tx=${totalTx} eventRows=${totalEventRows} trades=${totalTrades}`
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
            skipped: true,
          }))
        )
      );

      for (const r of results) {
        totalTx += 1;
        totalEventRows += r.wroteEvents;
        totalTrades += r.wroteTrades;
      }
    }

    console.log(
      `[backfill] page=${page} fetched=${sigs.length} totalTx=${totalTx} eventRows=${totalEventRows} trades=${totalTrades} before=${before}`
    );
  }
}

run().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[backfill] fatal: ${msg}`);
  process.exit(1);
});