// Writes:
// - dex_events: ALL Anchor events (evt.name) with full logs.
//              If none decoded, writes a fallback "tx" row (logs captured).
// - dex_events: ALSO writes a Gecko-ready "swap" event row *when* we can derive a real Trade
//              and have non-junk pool state (price + reserves FROM POST VAULT BALANCES).
// - dex_trades: derived swaps (strict vault-delta derivation).
// - dex_pools: upserted whenever we successfully read a pool.
// - dex_pools: updates liquidity_quote on LIQ events using POST VAULT BALANCES.
//
// Run:
//   tsx src/scripts/backfill_events.ts
//   (or npm run backfill:events)
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
import {
  upsertDexPool,
  writeDexEvent,
  writeDexTrade,
  updateDexPoolLiquidityState,
} from "../supabase.js";
import { formatEventData, getStandardEventType } from "../services/event_formatters.js";

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

  activeBin: number;

  // Used for:
  // - liquidity_quote = quoteUi + baseUi * priceNumber
  // - Gecko swap payload uses this as priceNative (string)
  priceNumber: number | null;
};

const LIQ_EVENT_NAMES = new Set([
  "LiquidityWithdrawnUser",
  "LiquidityDepositedUser",
  "LiquidityAddedUser",
  "LiquidityRemovedUser",
]);

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

function pickFirstPoolFromEvent(evt: OrbitDecodedEvent): string | null {
  const cands = eventCandidatePools(evt);
  return cands.length ? cands[0]! : null;
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
      baseMint: String((v as any).baseMint),
      quoteMint: String((v as any).quoteMint),
      baseDecimals: Number((v as any).baseDecimals),
      quoteDecimals: Number((v as any).quoteDecimals),
      baseVault: String((v as any).baseVault),
      quoteVault: String((v as any).quoteVault),
      activeBin: Number((v as any).activeBin ?? 0),
      priceNumber: (v as any).priceNumber === null ? null : Number((v as any).priceNumber),
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

    if (Array.isArray(anyBlock?.signatures)) {
      for (const s of anyBlock.signatures) if (typeof s === "string") sigs.push(s);
    } else if (Array.isArray(anyBlock?.transactions)) {
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

// Post-vault reserves (correct) helpers
// These mirror your program_ws live indexer logic.

type TokenBalanceLike = { accountIndex?: number; uiTokenAmount?: { amount?: string } };
type AccountKeyLike = PublicKey | string | { pubkey: PublicKey };

function keyToString(k: AccountKeyLike | null): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  if ("pubkey" in k) return k.pubkey.toBase58();
  return k.toBase58();
}

function getAllAccountKeys(tx: VersionedTransactionResponse): AccountKeyLike[] {
  const msg = tx.transaction.message;

  // legacy
  if ("accountKeys" in msg) return msg.accountKeys as AccountKeyLike[];

  // v0
  const staticKeys = msg.staticAccountKeys as PublicKey[];
  const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []) as PublicKey[];
  const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []) as PublicKey[];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function findAccountIndex(tx: VersionedTransactionResponse, address: string): number {
  const keys = getAllAccountKeys(tx);
  for (let i = 0; i < keys.length; i++) {
    if (keyToString(keys[i] ?? null) === address) return i;
  }
  return -1;
}

function toAmountMap(balances: readonly TokenBalanceLike[] | null | undefined): Map<number, bigint> {
  const m = new Map<number, bigint>();
  for (const b of balances ?? []) {
    const idx = Number(b.accountIndex);
    const raw = b.uiTokenAmount?.amount;
    if (!Number.isFinite(idx) || typeof raw !== "string") continue;
    try {
      m.set(idx, BigInt(raw));
    } catch {
      /* ignore */
    }
  }
  return m;
}

/**
 * Compute vault reserves AFTER this tx from tx.meta.postTokenBalances.
 * This is the most correct "post-event reserves" available to an indexer.
 */
function getPostVaultReservesAtoms(
  tx: VersionedTransactionResponse,
  poolView: PoolView
): { base: bigint; quote: bigint } | null {
  if (!tx.meta) return null;

  const baseIdx = findAccountIndex(tx, poolView.baseVault);
  const quoteIdx = findAccountIndex(tx, poolView.quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const post = toAmountMap(tx.meta.postTokenBalances as any);

  const basePost = post.get(baseIdx);
  const quotePost = post.get(quoteIdx);
  if (basePost == null || quotePost == null) return null;

  return { base: basePost, quote: quotePost };
}

function computeLiquidityQuoteFromPostBalances(args: {
  tx: VersionedTransactionResponse;
  poolView: PoolView;
}): number | null {
  const { tx, poolView } = args;

  const post = getPostVaultReservesAtoms(tx, poolView);
  if (!post) return null;

  const px = poolView.priceNumber;
  if (px == null || !Number.isFinite(px) || px <= 0) return null;

  // NOTE: Number(BigInt) is safe for typical vault sizes, but could overflow in extreme cases.
  // For production-hardening, switch to decimal math (bigint division) if you expect giant values.
  const baseUi = Number(post.base) / 10 ** poolView.baseDecimals;
  const quoteUi = Number(post.quote) / 10 ** poolView.quoteDecimals;

  const liq = quoteUi + baseUi * px;
  return Number.isFinite(liq) ? liq : null;
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

  const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, signature) : 0;

  const logs = toLogs(tx);
  const decoded = decodeEventsFromLogs(logs);

  // Persist ALL Anchor events using formatters
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
      const evtPool = pickFirstPoolFromEvent(evt);

      // Load pool view if available for formatting
      let poolView: PoolView | null = null;
      if (evtPool) {
        poolView = await loadPoolCached(poolCache, evtPool);
      }

      // Format event data using Coingecko-compliant formatters
      let formattedEventData: any = null;
      if (poolView) {
        try {
          formattedEventData = formatEventData({
            tx,
            eventName: evt.name,
            eventData: evt.data ?? {},
            trade: null, // Will be filled separately for swaps
            poolView,
          });
        } catch {
          // Fallback to raw data if formatting fails
          formattedEventData = safeEventData(evt.data);
        }
      } else {
        // No pool view, use raw data
        formattedEventData = safeEventData(evt.data);
      }

      // Get standardized event type
      const standardEventType = getStandardEventType(evt.name);

      await writeDexEvent({
        signature,
        slot,
        blockTime,
        programId: programIdStr,
        eventType: standardEventType,
        txnIndex,
        eventIndex: i,
        eventData: formattedEventData,
        logs,
      });

      // If this is a LIQ event and we have pool view, update dex_pools.liquidity_quote
      // using POST vault balances for this transaction (same as live stream).
      if (poolView && slot != null && LIQ_EVENT_NAMES.has(evt.name)) {
        try {
          const liq = computeLiquidityQuoteFromPostBalances({ tx, poolView });
          if (liq != null) {
            await updateDexPoolLiquidityState({
              pool: evtPool!,
              slot,
              liquidityQuote: liq,
            });
          }
        } catch {
          // never fail backfill on liquidity patch
        }
      }
    }
  }

  const wroteEvents = decoded.length === 0 ? 1 : decoded.length;

  // Discover candidate pools (events first, then account-scan fallback)
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

    // ALSO write Gecko-ready "swap" row for /events consumers
    const geckoData = formatEventData({
      tx,
      eventName: "SwapExecuted",
      eventData: {},
      trade,
      poolView: pv,
    });
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