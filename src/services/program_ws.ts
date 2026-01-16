// Responsibilities:
// 1) Subscribe to on-chain program logs (connection.onLogs)
// 2) Fetch transaction, decode Anchor events (debug/audit trail)
// 3) Derive a swap Trade (market data) + persist dex_trades
// 4) Persist dex_events WITH txn_index + event_index
//    - "swap" event_data is Gecko-ready (priceNative/reserves/amounts)
//

import type { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

import type { TradeStore, Trade } from "./trades_indexer.js";
import { deriveTradeFromTransaction } from "./trade_derivation.js";
import { readPool } from "./pool_reader.js";
import { decodeEventsFromLogs } from "../idl/coder.js";
import { upsertDexPool, writeDexEvent, writeDexTrade } from "../supabase.js";
import type { WsHub } from "./ws.js";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [k: string]: JsonValue };

type AnchorEvent = {
  name: string;
  data?: JsonObject | null;
};

/**
 * Best-effort: determine pool/pair id from arbitrary event payload.
 * (This is helpful for WS routing and optional debugging.)
 */
function poolFromEventData(data: JsonObject | null | undefined): string | null {
  if (!data) return null;

  const pool = data["pool"];
  const pairId = data["pairId"];
  const poolId = data["poolId"];

  if (typeof pool === "string") return pool;
  if (typeof pairId === "string") return pairId;
  if (typeof poolId === "string") return poolId;

  return null;
}

/**
 * Decimalize bigint atoms into a decimal string.
 * - No rounding
 * - Trims trailing zeros
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

/**
 * Decimalize bigint atoms into a decimal string.
 * - No rounding
 * - Trims trailing zeros
 */

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
  poolView: Awaited<ReturnType<typeof readPool>>
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

/**
 * Strict decimal division to string without floating point.
 * Computes (num / den) as a decimal string with up to `scale` fractional digits.
 * Trims trailing zeros.
 */
function divToDecimalString(num: bigint, den: bigint, scale = 50): string | null {
  if (den === 0n) return null;
  if (num === 0n) return "0";

  const sign = (num < 0n) !== (den < 0n) ? "-" : "";
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;

  const whole = n / d;
  let rem = n % d;

  if (rem === 0n) return sign + whole.toString();

  let frac = "";
  for (let i = 0; i < scale && rem !== 0n; i++) {
    rem *= 10n;
    const digit = rem / d;
    rem = rem % d;
    frac += digit.toString();
  }

  frac = frac.replace(/0+$/, "");
  return frac.length ? `${sign}${whole.toString()}.${frac}` : sign + whole.toString();
}

/**
 * Build swap payload from:
 * - derived Trade (amounts + direction)
 * - poolView (mints/decimals/reserves/price)
 */
function buildSwapEventData(args: {
  tx: VersionedTransactionResponse;
  trade: Trade;
  poolView: Awaited<ReturnType<typeof readPool>>;
}) {
  const { tx, trade, poolView } = args;

  // Need derived amounts + mints
  if (!trade.amountIn || !trade.amountOut || !trade.inMint || !trade.outMint) return null;

  // Need reserves from tx meta (post state)
  const postRes = getPostVaultReservesAtoms(tx, poolView);
  if (!postRes) return null;

  const reserves = {
    // asset0=base, asset1=quote
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  };

  // amounts (decimalized) per rule:
  // either (asset0In + asset1Out) OR (asset1In + asset0Out)
  let asset0In: string | undefined;
  let asset1In: string | undefined;
  let asset0Out: string | undefined;
  let asset1Out: string | undefined;

  const inAtoms = BigInt(trade.amountIn);
  const outAtoms = BigInt(trade.amountOut);

  // Define asset0=base, asset1=quote
  if (trade.inMint === poolView.baseMint && trade.outMint === poolView.quoteMint) {
    asset0In = decimalize(inAtoms, poolView.baseDecimals);
    asset1Out = decimalize(outAtoms, poolView.quoteDecimals);

    // priceNative = amount(asset1) / amount(asset0)
    // Use atoms with decimal adjustment to avoid float:
    // price = (outAtoms / 10^quoteDec) / (inAtoms / 10^baseDec)
    //       = outAtoms * 10^baseDec / (inAtoms * 10^quoteDec)
    const num = outAtoms * 10n ** BigInt(poolView.baseDecimals);
    const den = inAtoms * 10n ** BigInt(poolView.quoteDecimals);
    const priceNative = divToDecimalString(num, den, 50);
    if (!priceNative || priceNative === "0") return null;

    return {
      maker: trade.user ?? "11111111111111111111111111111111",
      pairId: trade.pool,
      asset0In,
      asset1Out,
      priceNative,
      reserves,
    };
  }

  if (trade.inMint === poolView.quoteMint && trade.outMint === poolView.baseMint) {
    asset1In = decimalize(inAtoms, poolView.quoteDecimals);
    asset0Out = decimalize(outAtoms, poolView.baseDecimals);

    // priceNative = amount(asset1) / amount(asset0)
    // Here: amount(asset1)=inAtoms (quote), amount(asset0)=outAtoms (base)
    // price = (inAtoms / 10^quoteDec) / (outAtoms / 10^baseDec)
    //       = inAtoms * 10^baseDec / (outAtoms * 10^quoteDec)
    const num = inAtoms * 10n ** BigInt(poolView.baseDecimals);
    const den = outAtoms * 10n ** BigInt(poolView.quoteDecimals);
    const priceNative = divToDecimalString(num, den, 50);
    if (!priceNative || priceNative === "0") return null;

    return {
      maker: trade.user ?? "11111111111111111111111111111111",
      pairId: trade.pool,
      asset1In,
      asset0Out,
      priceNative,
      reserves,
    };
  }

  // Unknown direction / not a base-quote swap
  return null;
}

/**
 * txnIndex derivation:
 * needs txnIndex = order of tx in block.
 *
 * Strategy:
 * - Fetch block once per slot using transactionDetails:"signatures"
 * - Build map signature->index
 * - Cache per slot (TTL) for speed
 */
type TxnIndexCacheEntry = {
  ts: number;
  map: Map<string, number>;
};

const TXN_INDEX_CACHE = new Map<number, TxnIndexCacheEntry>();
const TXN_INDEX_TTL_MS = 30_000;

async function getTxnIndexForSignature(connection: Connection, slot: number, sig: string) {
  const now = Date.now();
  const hit = TXN_INDEX_CACHE.get(slot);

  if (hit && now - hit.ts < TXN_INDEX_TTL_MS) {
    const idx = hit.map.get(sig);
    return idx ?? 0;
  }

  // Build fresh
  const map = new Map<string, number>();

  try {
    const block = await connection.getBlock(slot, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "signatures",
      rewards: false,
    });

    // web3.js getBlock returns either:
    // - { signatures: string[] } in some modes OR
    // - { transactions: { transaction: { signatures: string[] } }[] } depending on RPC
    //
    // We handle both.
    const sigs: string[] = [];

    const anyBlock = block as any;
    if (Array.isArray(anyBlock?.signatures)) {
      sigs.push(...anyBlock.signatures);
    } else if (Array.isArray(anyBlock?.transactions)) {
      for (const t of anyBlock.transactions) {
        const s0 = t?.transaction?.signatures?.[0];
        if (typeof s0 === "string") sigs.push(s0);
      }
    }

    for (let i = 0; i < sigs.length; i++) {
      const s = sigs[i];
      if (typeof s === "string" && s.length > 0) map.set(s, i);
    }
  } catch {
    // ignore; we'll fallback to 0
  }

  TXN_INDEX_CACHE.set(slot, { ts: now, map });
  return map.get(sig) ?? 0;
}

export function startProgramLogStream(params: {
  connection: Connection;
  programId: PublicKey;
  store: TradeStore;
  wsHub: WsHub;
}) {
  const { connection, programId, store, wsHub } = params;

  const programIdStr = programId.toBase58();
  const seenTx = new Set<string>();

  const subIdPromise = connection.onLogs(
    programId,
    async (logInfo) => {
      const sig = logInfo.signature;
      if (!sig) return;

      // WS can replay, dedupe by signature
      if (seenTx.has(sig)) return;
      seenTx.add(sig);

      let tx: VersionedTransactionResponse | null = null;
      try {
        tx = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      } catch {
        return;
      }
      if (!tx) return;

      const logs = (tx.meta?.logMessages ?? []) as string[];

      // Determine txnIndex deterministically
      const slot = tx.slot ?? null;
      const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, sig) : 0;

      // Decode Anchor events (debug/audit trail)
      const decoded = decodeEventsFromLogs(logs) as AnchorEvent[];

      // Persist decoded events (best-effort, never crash stream)
      try {
        if (decoded.length > 0) {
          let i = 0;
          for (const evt of decoded) {
            await writeDexEvent({
              signature: sig,
              slot,
              blockTime: tx.blockTime ?? null,
              programId: programIdStr,
              eventType: evt.name,
              txnIndex,
              eventIndex: i++,
              eventData: evt.data ?? null,
              logs,
            });

            const evtPool = poolFromEventData(evt.data ?? null);

            wsHub.broadcast({
              type: "event",
              pool: evtPool ?? undefined,
              data: {
                signature: sig,
                slot,
                blockTime: tx.blockTime ?? null,
                event: evt.data ? { name: evt.name, data: evt.data } : { name: evt.name },
              },
            });
          }
        } else {
          // No decoded Anchor events; store a minimal "tx" marker
          await writeDexEvent({
            signature: sig,
            slot,
            blockTime: tx.blockTime ?? null,
            programId: programIdStr,
            eventType: "tx",
            txnIndex,
            eventIndex: 0,
            eventData: null,
            logs,
          });

          wsHub.broadcast({
            type: "event",
            data: {
              signature: sig,
              slot,
              blockTime: tx.blockTime ?? null,
              event: { name: "tx" },
            },
          });
        }
      } catch {
        // Never break the stream due to supabase errors
      }

      // Materialize swaps into dex_trades + write Gecko swap event
      //
      // We scan all account keys and try to treat each as a "pool candidate".
      // On the first pool that yields a valid trade, we persist:
      // - dex_pools upsert
      // - dex_trades write
      // - dex_events swap write with Gecko payload
      //
      // NOTE: you break after first trade because dex_trades PK constraints
      // may be signature-only in some deployments.
      //
      const msg = tx.transaction.message;

      const accountKeys =
        "accountKeys" in msg
          ? (msg.accountKeys as PublicKey[])
          : ([
              ...msg.staticAccountKeys,
              ...(tx.meta?.loadedAddresses?.writable ?? []),
              ...(tx.meta?.loadedAddresses?.readonly ?? []),
            ] as PublicKey[]);

      for (const k of accountKeys) {
        const pool = k.toBase58();
        const seenKey = `${sig}:${pool}`;
        if (store.seen.has(seenKey)) continue;

        let poolView: Awaited<ReturnType<typeof readPool>>;
        try {
          poolView = await readPool(pool);
        } catch {
          continue;
        }

        // keep pools table fresh (best-effort)
        try {
          await upsertDexPool({
            pool,
            programId: programIdStr,
            baseMint: poolView.baseMint,
            quoteMint: poolView.quoteMint,
            baseDecimals: poolView.baseDecimals,
            quoteDecimals: poolView.quoteDecimals,
            lastPriceQuotePerBase: poolView.priceNumber,
          });
        } catch {
          // ignore
        }

        const trade = deriveTradeFromTransaction(tx, {
          pool,
          baseVault: poolView.baseVault,
          quoteVault: poolView.quoteVault,
          baseMint: poolView.baseMint,
          quoteMint: poolView.quoteMint,
        });

        if (!trade) continue;

        // Update in-memory store
        store.seen.add(seenKey);
        const arr = store.byPool.get(pool) ?? [];
        arr.unshift(trade);
        store.byPool.set(pool, arr.slice(0, 500));

        // Persist trade (best-effort)
        try {
          await writeDexTrade(trade);
        } catch {
          // ignore
        }

        // Broadcast trade for app consumers
        wsHub.broadcast({ type: "trade", pool, data: trade });

        // Persist swap event into dex_events
        //
        // This is what /api/v1/events will later serve.
        //
        // eventIndex here is "within the transaction" for swap events.
        // If you later support multiple swap events per tx, increment this.
        try {
          const swapEventData = buildSwapEventData({ tx, trade, poolView });
          if (swapEventData) {
            await writeDexEvent({
              signature: sig,
              slot,
              blockTime: tx.blockTime ?? null,
              programId: programIdStr,
              eventType: "swap",
              txnIndex,
              eventIndex: 0,
              eventData: swapEventData,
              logs,
            });
          }
        } catch {
          // ignore
        }

        // Because dex_trades PK may be signature-only, do NOT insert multiple pools per tx.
        break;
      }
    },
    "confirmed"
  );

  return {
    async stop() {
      const subId = await subIdPromise;
      await connection.removeOnLogsListener(subId);
    },
  };
}