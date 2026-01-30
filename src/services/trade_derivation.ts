import type { VersionedTransactionResponse } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Trade } from "./trades_indexer.js";

/**
 * Minimal pool data required to derive a Trade.
 */
export type PoolMini = {
  pool: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
};

/**
 * Token balance shape we need (RPC jsonParsed style).
 */
type UiTokenAmount = { amount?: string };
type TokenBalanceLike = { accountIndex?: number; uiTokenAmount?: UiTokenAmount };

type AccountKeyLike = PublicKey | string | { pubkey: PublicKey };

/**
 * Utility helpers
 */

function keyToString(k: AccountKeyLike | null): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  if ("pubkey" in k) return k.pubkey.toBase58();
  return k.toBase58();
}

function getAllAccountKeys(tx: VersionedTransactionResponse): AccountKeyLike[] {
  const msg = tx.transaction.message;

  // legacy
  if ("accountKeys" in msg) {
    return msg.accountKeys as AccountKeyLike[];
  }

  // v0
  const staticKeys = msg.staticAccountKeys as PublicKey[];
  const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []) as PublicKey[];
  const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []) as PublicKey[];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function findAccountIndex(tx: VersionedTransactionResponse, address: string): number {
  const keys = getAllAccountKeys(tx);
  for (let i = 0; i < keys.length; i++) {
    if (keyToString(keys[i]) === address) return i;
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

function getFeePayer(tx: VersionedTransactionResponse): string | null {
  const keys = getAllAccountKeys(tx);
  return keyToString(keys[0] ?? null);
}

/**
 * derive Trade
 *
 * Returns:
 * - Trade if tx is a clean swap for this pool
 * - null if not derivable / irrelevant
 */
export function deriveTradeFromTransaction(
  tx: VersionedTransactionResponse,
  pool: PoolMini
): Trade | null {
  if (!tx.meta) return null;

  // locate vault accounts
  const baseIdx = findAccountIndex(tx, pool.baseVault);
  const quoteIdx = findAccountIndex(tx, pool.quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const pre = toAmountMap(tx.meta.preTokenBalances as any);
  const post = toAmountMap(tx.meta.postTokenBalances as any);

  const basePre = pre.get(baseIdx) ?? 0n;
  const basePost = post.get(baseIdx) ?? 0n;
  const quotePre = pre.get(quoteIdx) ?? 0n;
  const quotePost = post.get(quoteIdx) ?? 0n;

  const baseDelta = basePost - basePre;
  const quoteDelta = quotePost - quotePre;

  if (baseDelta === 0n && quoteDelta === 0n) return null;

  let inMint: string | null = null;
  let outMint: string | null = null;
  let amountIn: string | null = null;
  let amountOut: string | null = null;

  // user paid base, received quote
  if (baseDelta > 0n && quoteDelta < 0n) {
    inMint = pool.baseMint;
    outMint = pool.quoteMint;
    amountIn = baseDelta.toString();
    amountOut = (-quoteDelta).toString();
  }
  // user paid quote, received base
  else if (quoteDelta > 0n && baseDelta < 0n) {
    inMint = pool.quoteMint;
    outMint = pool.baseMint;
    amountIn = quoteDelta.toString();
    amountOut = (-baseDelta).toString();
  } else {
    // liquidity ops / complex tx
    return null;
  }

  return {
    signature: tx.transaction.signatures[0]!,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    pool: pool.pool,
    user: getFeePayer(tx),
    inMint,
    outMint,
    amountIn,
    amountOut,
  };
}