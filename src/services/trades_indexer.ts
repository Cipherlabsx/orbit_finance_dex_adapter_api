import crypto from "node:crypto";
import bs58 from "bs58";
import {
  type ConfirmedSignatureInfo,
  type PublicKey,
  type VersionedTransactionResponse,
  MessageV0,
  type Message,
  type VersionedMessage,
} from "@solana/web3.js";

import { connection, pk, PROGRAM_ID } from "../solana.js";
import { env } from "../config.js";
import { readPool } from "./pool_reader.js";

export type Trade = {
  signature: string;
  slot: number;
  blockTime: number | null;

  pool: string;
  user: string | null;

  inMint: string | null;
  outMint: string | null;

  amountIn: string | null; // atoms as string
  amountOut: string | null; // atoms as string
};

export type TradeStore = {
  byPool: Map<string, Trade[]>;
  seen: Set<string>;
};

const SWAP_IX_NAME = "swap";

/**
 * Anchor global instruction discriminator:
 * sha256("global:<name>") first 8 bytes
 */
function anchorDiscriminator(name: string): Buffer {
  const preimage = `global:${name}`;
  const h = crypto.createHash("sha256").update(preimage).digest();
  return h.subarray(0, 8);
}
const SWAP_DISCRIM = anchorDiscriminator(SWAP_IX_NAME);

export function createTradeStore(): TradeStore {
  return { byPool: new Map(), seen: new Set() };
}

export function listIndexedPools(store: TradeStore): string[] {
  return Array.from(store.byPool.keys());
}

export function getTrades(store: TradeStore, pool: string, limit: number): Trade[] {
  const arr = store.byPool.get(pool) ?? [];
  return arr.slice(0, limit);
}

function pushTrade(store: TradeStore, t: Trade) {
  const seenKey = `${t.signature}:${t.pool}`;
  if (store.seen.has(seenKey)) return;

  store.seen.add(seenKey);

  const cur = store.byPool.get(t.pool) ?? [];
  cur.unshift(t);
  store.byPool.set(t.pool, cur.slice(0, 500));
}

/**
 * Best-effort swap detection via log strings.
 */
function detectSwapFromLogs(logs: readonly string[] | null | undefined): boolean {
  if (!logs) return false;

  for (const l of logs) {
    const s = l.toLowerCase();
    if (s.includes("swapexecuted")) return true; // anchor event name (if emitted)
    if (s.includes("instruction: swap")) return true; // anchor log
    if (s.includes(`instruction: ${SWAP_IX_NAME}`)) return true;
  }
  return false;
}

/**
 * Instruction shapes we may see from getTransaction() JSON response.
 * We only need `programIdIndex` + `data` in compiled form.
 */
type CompiledInstructionLike = {
  programIdIndex: number;
  data: string; // base58 or base64 depending on RPC, we support both
};

type LegacyInstructionLike = {
  programId?: PublicKey | string;
  data?: string | Uint8Array | Buffer;
};

/**
 * Robust swap detection by scanning instructions:
 * - programId == PROGRAM_ID
 * - data starts with Anchor discriminator for `swap`
 */
function detectSwapFromInstructions(tx: VersionedTransactionResponse): boolean {
  try {
    const msg = tx.transaction.message;

    // Legacy message has `instructions`
    const legacyIxs: LegacyInstructionLike[] =
      isLegacyMessage(msg) ? (msg.instructions as LegacyInstructionLike[]) : [];

    // v0 message has `compiledInstructions`
    const v0Ixs: CompiledInstructionLike[] =
      isV0Message(msg) ? (msg.compiledInstructions as unknown as CompiledInstructionLike[]) : [];

    const keys = getAllAccountKeys(tx);

    const resolveProgramId = (programIdIndex: number): string | null => {
      const k = keys[programIdIndex];
      return keyToString(k);
    };

    // Legacy-style instructions
    for (const ix of legacyIxs) {
      const pid = keyToString(ix.programId ?? null);
      if (!pid) continue;
      if (pid !== PROGRAM_ID.toBase58()) continue;

      const disc = readDiscriminatorFromAnyData(ix.data);
      if (disc && disc.equals(SWAP_DISCRIM)) return true;
    }

    // V0 compiled instructions
    for (const ix of v0Ixs) {
      const pid = resolveProgramId(Number(ix.programIdIndex));
      if (!pid) continue;
      if (pid !== PROGRAM_ID.toBase58()) continue;

      const disc = readDiscriminatorFromAnyData(ix.data);
      if (disc && disc.equals(SWAP_DISCRIM)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

function readDiscriminatorFromAnyData(data: string | Uint8Array | Buffer | null | undefined): Buffer | null {
  if (!data) return null;

  if (Buffer.isBuffer(data)) return data.length >= 8 ? data.subarray(0, 8) : null;
  if (data instanceof Uint8Array) return data.length >= 8 ? Buffer.from(data).subarray(0, 8) : null;

  // String: try base64 then base58
  if (typeof data === "string") {
    // base64
    try {
      const b64 = Buffer.from(data, "base64");
      if (b64.length >= 8) return b64.subarray(0, 8);
    } catch {
      // ignore
    }

    // base58
    try {
      const b58 = Buffer.from(bs58.decode(data));
      if (b58.length >= 8) return b58.subarray(0, 8);
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Token balance shape we need (RPC jsonParsed style).
 */
type UiTokenAmount = { amount?: string };
type TokenBalanceLike = { accountIndex?: number; uiTokenAmount?: UiTokenAmount };

/**
 * Vault delta extraction
 */
function toAmountMap(balances: readonly TokenBalanceLike[] | null | undefined): Map<number, bigint> {
  const m = new Map<number, bigint>();
  for (const b of balances ?? []) {
    const idx = Number(b.accountIndex);
    const raw = b.uiTokenAmount?.amount;
    if (!Number.isFinite(idx) || typeof raw !== "string") continue;
    try {
      m.set(idx, BigInt(raw));
    } catch {
      // ignore parse errors
    }
  }
  return m;
}

type AccountKeyLike = PublicKey | string | { pubkey: PublicKey };

function keyToString(k: AccountKeyLike | null): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  if ("pubkey" in k) return k.pubkey.toBase58();
  return k.toBase58();
}

function isV0Message(msg: VersionedMessage): msg is MessageV0 {
  return msg instanceof MessageV0;
}

function isLegacyMessage(msg: VersionedMessage): msg is Message {
  return !(msg instanceof MessageV0);
}

function getAllAccountKeys(tx: VersionedTransactionResponse): AccountKeyLike[] {
  const msg = tx.transaction.message;

  // Legacy message: accountKeys exists
  if (isLegacyMessage(msg)) {
    return msg.accountKeys as AccountKeyLike[];
  }

  // v0 message: staticAccountKeys + loaded addresses
  const staticKeys = msg.staticAccountKeys as PublicKey[];
  const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []) as PublicKey[];
  const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []) as PublicKey[];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function findAccountIndex(tx: VersionedTransactionResponse, address: string): number {
  const keys = getAllAccountKeys(tx);
  for (let i = 0; i < keys.length; i++) {
    const s = keyToString(keys[i] ?? null);
    if (s === address) return i;
  }
  return -1;
}

function getFeePayer(tx: VersionedTransactionResponse): string | null {
  const keys = getAllAccountKeys(tx);
  return keyToString(keys[0] ?? null);
}

function computeVaultDeltas(tx: VersionedTransactionResponse, baseVault: string, quoteVault: string) {
  const baseIdx = findAccountIndex(tx, baseVault);
  const quoteIdx = findAccountIndex(tx, quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const pre = toAmountMap((tx.meta?.preTokenBalances ?? null) as readonly TokenBalanceLike[] | null);
  const post = toAmountMap((tx.meta?.postTokenBalances ?? null) as readonly TokenBalanceLike[] | null);

  const basePre = pre.get(baseIdx) ?? 0n;
  const basePost = post.get(baseIdx) ?? 0n;
  const quotePre = pre.get(quoteIdx) ?? 0n;
  const quotePost = post.get(quoteIdx) ?? 0n;

  return {
    baseDelta: basePost - basePre,
    quoteDelta: quotePost - quotePre,
  };
}

// Pool cache
type PoolMini = {
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
};
type PoolCacheEntry = { ts: number; v: PoolMini };
const POOL_CACHE = new Map<string, PoolCacheEntry>();
const POOL_CACHE_TTL_MS = 10_000;

async function getPoolMini(pool: string): Promise<PoolMini> {
  const now = Date.now();
  const hit = POOL_CACHE.get(pool);
  if (hit && now - hit.ts < POOL_CACHE_TTL_MS) return hit.v;

  const p = await readPool(pool);
  const v: PoolMini = {
    baseVault: p.baseVault,
    quoteVault: p.quoteVault,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
  };

  POOL_CACHE.set(pool, { ts: now, v });
  return v;
}

async function processSignatureForPool(store: TradeStore, pool: string, sig: string) {
  const seenKey = `${sig}:${pool}`;
  if (store.seen.has(seenKey)) return;

  let tx: VersionedTransactionResponse | null = null;
  try {
    tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    store.seen.add(seenKey);
    return;
  }

  if (!tx) {
    store.seen.add(seenKey);
    return;
  }

  const logs = tx.meta?.logMessages ?? null;
  const isSwap = detectSwapFromLogs(logs) || detectSwapFromInstructions(tx);

  if (!isSwap) {
    store.seen.add(seenKey);
    return;
  }

  // derive amounts from vault balance deltas
  let poolMini: PoolMini;
  try {
    poolMini = await getPoolMini(pool);
  } catch {
    store.seen.add(seenKey);
    return;
  }

  const deltas = computeVaultDeltas(tx, poolMini.baseVault, poolMini.quoteVault);
  if (!deltas) {
    store.seen.add(seenKey);
    return;
  }

  const { baseDelta, quoteDelta } = deltas;

  if (baseDelta === 0n && quoteDelta === 0n) {
    store.seen.add(seenKey);
    return;
  }

  let inMint: string | null = null;
  let outMint: string | null = null;
  let amountIn: string | null = null;
  let amountOut: string | null = null;

  // vault increased => token went in (user paid that token)
  // vault decreased => token went out (user received that token)
  if (baseDelta > 0n && quoteDelta < 0n) {
    // user paid base, received quote
    inMint = poolMini.baseMint;
    outMint = poolMini.quoteMint;
    amountIn = baseDelta.toString();
    amountOut = (-quoteDelta).toString();
  } else if (quoteDelta > 0n && baseDelta < 0n) {
    // user paid quote, received base
    inMint = poolMini.quoteMint;
    outMint = poolMini.baseMint;
    amountIn = quoteDelta.toString();
    amountOut = (-baseDelta).toString();
  } else {
    // liquidity ops / multi-legged tx
    store.seen.add(seenKey);
    return;
  }

  pushTrade(store, {
    signature: sig,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    pool,
    user: getFeePayer(tx),
    inMint,
    outMint,
    amountIn,
    amountOut,
  });
}

/**
 * LIVE polling (recent signatures)
 */
export async function pollTrades(store: TradeStore, pools: string[]) {
  const lookback = env.SIGNATURE_LOOKBACK;

  for (const pool of pools) {
    let sigs: ConfirmedSignatureInfo[] = [];
    try {
      sigs = await connection.getSignaturesForAddress(pk(pool), { limit: lookback });
    } catch {
      continue;
    }

    for (const s of sigs) {
      const sig = s.signature;
      if (!sig) continue;
      await processSignatureForPool(store, pool, sig);
    }
  }
}

/**
 * HISTORIC backfill (paginated)
 * - walks backwards using `before`
 * - stops after BACKFILL_MAX_SIGNATURES_PER_POOL
 */
export async function backfillTrades(store: TradeStore, pools: string[]) {
  const maxPerPool = env.BACKFILL_MAX_SIGNATURES_PER_POOL;
  const pageSize = Math.max(10, Math.min(1000, env.BACKFILL_PAGE_SIZE));

  if (!Number.isFinite(maxPerPool) || maxPerPool <= 0) return;

  for (const pool of pools) {
    let fetched = 0;
    let before: string | undefined = undefined;

    while (fetched < maxPerPool) {
      const limit = Math.min(pageSize, maxPerPool - fetched);

      let sigs: ConfirmedSignatureInfo[] = [];
      try {
        sigs = await connection.getSignaturesForAddress(pk(pool), { limit, before });
      } catch {
        break;
      }

      if (sigs.length === 0) break;

      fetched += sigs.length;
      before = sigs[sigs.length - 1]?.signature;

      for (const s of sigs) {
        const sig = s.signature;
        if (!sig) continue;
        await processSignatureForPool(store, pool, sig);
      }

      if (sigs.length < limit) break;
    }
  }
}

export function startTradeIndexer(store: TradeStore, pools: string[]) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollTrades(store, pools);
    } catch {
      // keep loop alive
    } finally {
      if (!stopped) setTimeout(tick, env.TRADES_POLL_MS);
    }
  };

  tick();

  return {
    stop() {
      stopped = true;
    },
  };
}