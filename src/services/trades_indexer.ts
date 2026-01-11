import { connection, pk } from "../solana.js";
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
function detectSwapFromLogs(logs: string[] | null | undefined): boolean {
  if (!logs) return false;

  for (const l of logs) {
    const s = l.toLowerCase();
    if (s.includes("swapexecuted")) return true; // anchor event name
    if (s.includes("instruction: swap")) return true; // anchor log
    if (s.includes(`instruction: ${SWAP_IX_NAME}`)) return true;
  }
  return false;
}

// Vault delta extraction
function toAmountMap(balances: any[] | null | undefined): Map<number, bigint> {
  const m = new Map<number, bigint>();
  for (const b of balances ?? []) {
    const idx = Number(b?.accountIndex);
    const raw = b?.uiTokenAmount?.amount; // atoms string
    if (!Number.isFinite(idx) || typeof raw !== "string") continue;
    try {
      m.set(idx, BigInt(raw));
    } catch {
      // ignore parse errors
    }
  }
  return m;
}

function keyToString(k: any): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  // v0 message keys often look like { pubkey: PublicKey, signer: bool, writable: bool }
  const pkObj = k?.pubkey ?? k;
  if (typeof pkObj === "string") return pkObj;
  if (typeof pkObj?.toBase58 === "function") return pkObj.toBase58();
  if (typeof pkObj?.toString === "function") return pkObj.toString();
  return null;
}

function findAccountIndex(tx: any, address: string): number {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  for (let i = 0; i < keys.length; i++) {
    const s = keyToString(keys[i]);
    if (s === address) return i;
  }
  return -1;
}

function computeVaultDeltas(tx: any, baseVault: string, quoteVault: string) {
  const baseIdx = findAccountIndex(tx, baseVault);
  const quoteIdx = findAccountIndex(tx, quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const pre = toAmountMap(tx?.meta?.preTokenBalances);
  const post = toAmountMap(tx?.meta?.postTokenBalances);

  const basePre = pre.get(baseIdx) ?? 0n;
  const basePost = post.get(baseIdx) ?? 0n;
  const quotePre = pre.get(quoteIdx) ?? 0n;
  const quotePost = post.get(quoteIdx) ?? 0n;

  return {
    baseDelta: basePost - basePre,
    quoteDelta: quotePost - quotePre,
  };
}

function getFeePayer(tx: any): string | null {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const payer = keyToString(keys[0]);
  return payer ?? null;
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

// Indexer
export async function pollTrades(store: TradeStore, pools: string[]) {
  const lookback = env.SIGNATURE_LOOKBACK;

  for (const pool of pools) {
    let sigs: any[] = [];
    try {
      sigs = await connection.getSignaturesForAddress(pk(pool), { limit: lookback });
    } catch {
      continue;
    }

    for (const s of sigs) {
      const seenKey = `${s.signature}:${pool}`;
      if (store.seen.has(seenKey)) continue;

      let tx: any = null;
      try {
        tx = await connection.getTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      } catch {
        store.seen.add(seenKey);
        continue;
      }

      if (!tx) {
        store.seen.add(seenKey);
        continue;
      }

      const logs = tx.meta?.logMessages;
      const isSwap = detectSwapFromLogs(logs);

      if (!isSwap) {
        store.seen.add(seenKey);
        continue;
      }

      // derive amounts from vault balance deltas
      let poolMini: PoolMini;
      try {
        poolMini = await getPoolMini(pool);
      } catch {
        store.seen.add(seenKey);
        continue;
      }

      const deltas = computeVaultDeltas(tx, poolMini.baseVault, poolMini.quoteVault);
      if (!deltas) {
        // if the vaults weren't in accountKeys, we can't price/parse.
        store.seen.add(seenKey);
        continue;
      }

      const { baseDelta, quoteDelta } = deltas;

      // ignore "no movement" (or weird cases)
      if (baseDelta === 0n && quoteDelta === 0n) {
        store.seen.add(seenKey);
        continue;
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
        // liquidity ops / fee rebal / multi-legged tx, skip for chart correctness
        store.seen.add(seenKey);
        continue;
      }

      pushTrade(store, {
        signature: s.signature,
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