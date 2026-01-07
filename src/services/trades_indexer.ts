import { connection, pk } from "../solana.js";
import { env } from "../config.js";

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

const SWAP_IX_NAME = "swap"; // matches IDL (kept)

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
  /**
   * IMPORTANT:
   * Signature-only dedupe is wrong for Solana because one transaction can touch multiple pools.
   * Keep `seen: Set<string>` but store composite key.
   */
  const seenKey = `${t.signature}:${t.pool}`;
  if (store.seen.has(seenKey)) return;

  store.seen.add(seenKey);

  const cur = store.byPool.get(t.pool) ?? [];
  cur.unshift(t);
  store.byPool.set(t.pool, cur.slice(0, 500));
}

/**
 * Best-effort swap detection via log strings (no IDL needed).
 * If you later add an Anchor event parser, you can fill inMint/outMint/amounts.
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

export async function pollTrades(store: TradeStore, pools: string[]) {
  const lookback = env.SIGNATURE_LOOKBACK;

  for (const pool of pools) {
    const sigs = await connection.getSignaturesForAddress(pk(pool), { limit: lookback });

    for (const s of sigs) {
      const seenKey = `${s.signature}:${pool}`;
      if (store.seen.has(seenKey)) continue;

      const tx = await connection.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) continue;

      const logs = tx.meta?.logMessages;
      const isSwap = detectSwapFromLogs(logs);

      if (!isSwap) {
        store.seen.add(seenKey);
        continue;
      }

      /**
       * Production-safe default:
       * store the activity with null amounts/mints until the event parser is wired.
       * This avoids returning invalid swap payloads in /events (which would halt indexing).
       */
      pushTrade(store, {
        signature: s.signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        pool,
        user: null,
        inMint: null,
        outMint: null,
        amountIn: null,
        amountOut: null,
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