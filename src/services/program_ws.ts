import type { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

import type { TradeStore, Trade } from "./trades_indexer.js";
import { deriveTradeFromTransaction } from "./trade_derivation.js";
import { readPool } from "./pool_reader.js";
import { decodeEventsFromLogs } from "../idl/coder.js";
import {
  updateDexPoolLiveState,
  updateDexPoolLiquidityState,
  updateDexPoolTvlLocked,
  upsertDexPool,
  writeDexEvent,
  writeDexTrade,
  supabase,
  isDexPoolTombstoned,
  warnDexPoolTombstoneOnce,
} from "../supabase.js";
import type { WsHub } from "./ws.js";
import { formatEventData, getStandardEventType } from "./event_formatters.js";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [k: string]: JsonValue };

type AnchorEvent = {
  name: string;
  data?: JsonObject | null;
};

type TokenBalanceLike = {
  accountIndex?: number;
  uiTokenAmount?: { amount?: string };
};

type AccountKeyLike = PublicKey | string | { pubkey: PublicKey };

const LIQ_EVENT_NAMES = new Set([
  "LiquidityDeposited",
  "LiquidityDepositedUser",
  "LiquidityAddedUser",
  "LiquidityRemovedUser",
  "LiquidityWithdrawnUser",
  "LiquidityWithdrawnAdmin",
  "BinLiquidityUpdated",
  "LiquidityLocked",
]);

const TXN_INDEX_FALLBACK_BASE = 1_000_000;

function fallbackTxnIndexFromSignature(sig: string): number {
  // Stable high-range fallback to avoid collisions with real block indexes (typically small integers).
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (Math.imul(31, h) + sig.charCodeAt(i)) | 0;
  }
  return TXN_INDEX_FALLBACK_BASE + (Math.abs(h) % 1_000_000);
}

// Helpers
function isSwapEventName(name: string): boolean {
  return name === "SwapExecuted";
}

function addressFromUnknown(value: unknown, depth = 0): string | null {
  if (value == null || depth > 3) return null;

  if (typeof value === "string") {
    const s = value.trim();
    return s.length >= 32 ? s : null;
  }

  if (typeof value !== "object") return null;

  const v = value as Record<string, unknown> & {
    toBase58?: () => string;
    toString?: (...args: any[]) => string;
  };

  if (typeof v.toBase58 === "function") {
    try {
      const s = v.toBase58();
      if (typeof s === "string" && s.trim().length >= 32) return s.trim();
    } catch {}
  }

  if (typeof v.toString === "function") {
    try {
      const s = v.toString();
      const t = typeof s === "string" ? s.trim() : "";
      if (t.length >= 32 && t !== "[object Object]") return t;
    } catch {}
  }

  const nestedKeys = ["pool", "pairId", "poolId", "pubkey", "publicKey", "key"] as const;
  for (const key of nestedKeys) {
    const nested = addressFromUnknown(v[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function poolFromEventData(data: JsonObject | null | undefined): string | null {
  if (!data) return null;
  return (
    addressFromUnknown((data as any).pool) ??
    addressFromUnknown((data as any).pairId) ??
    addressFromUnknown((data as any).poolId)
  );
}

function firstPoolFromDecodedEvents(decoded: AnchorEvent[]): string | null {
  for (const evt of decoded) {
    const p = poolFromEventData(evt.data ?? null);
    if (p) return p;
  }
  return null;
}

function keyToString(k: AccountKeyLike | null): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  if ("pubkey" in k) return k.pubkey.toBase58();
  return k.toBase58();
}

function getAllAccountKeys(tx: VersionedTransactionResponse): AccountKeyLike[] {
  const msg = tx.transaction.message;

  if ("accountKeys" in msg) {
    return msg.accountKeys as AccountKeyLike[];
  }

  return [
    ...msg.staticAccountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
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
    if (typeof b.accountIndex !== "number") continue;
    if (typeof b.uiTokenAmount?.amount !== "string") continue;
    try {
      m.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    } catch {}
  }
  return m;
}

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

function computeLiquidityQuoteFromPostBalances(args: {
  tx: VersionedTransactionResponse;
  poolView: Awaited<ReturnType<typeof readPool>>;
}): number | null {
  const post = getPostVaultReservesAtoms(args.tx, args.poolView);
  if (!post) return null;

  const baseUi = Number(post.base) / 10 ** args.poolView.baseDecimals;
  const quoteUi = Number(post.quote) / 10 ** args.poolView.quoteDecimals;
  const px = args.poolView.priceNumber;
  if (!Number.isFinite(px) || px! <= 0) return null;

  const liq = quoteUi + baseUi * px!;
  return Number.isFinite(liq) ? liq : null;
}

function extractPriceAfterQ6464FromLogs(logs: readonly string[]): string | null {
  try {
    for (const line of logs) {
      if (!line.toLowerCase().includes("swapexecuted")) continue;
      const jsonStart = line.indexOf("{");
      if (jsonStart < 0) continue;
      const evt = JSON.parse(line.slice(jsonStart));
      const raw = evt?.priceAfterQ6464;
      if (raw == null) continue;
      return raw.toString();
    }
  } catch {}
  return null;
}

/* txnIndex (block order) */
type TxnIndexCacheEntry = { ts: number; map: Map<string, number> };
const TXN_INDEX_CACHE = new Map<number, TxnIndexCacheEntry>();
const TXN_INDEX_TTL_MS = 30_000;

async function getTxnIndexForSignature(
  connection: Connection,
  slot: number,
  sig: string
): Promise<number> {
  const now = Date.now();
  const hit = TXN_INDEX_CACHE.get(slot);

  if (hit && now - hit.ts < TXN_INDEX_TTL_MS) {
    return hit.map.get(sig) ?? fallbackTxnIndexFromSignature(sig);
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
      sigs.push(...anyBlock.signatures);
    } else if (Array.isArray(anyBlock?.transactions)) {
      for (const t of anyBlock.transactions) {
        const s0 = t?.transaction?.signatures?.[0];
        if (typeof s0 === "string") sigs.push(s0);
      }
    }

    sigs.forEach((s, i) => map.set(s, i));
  } catch {}

  TXN_INDEX_CACHE.set(slot, { ts: now, map });
  return map.get(sig) ?? fallbackTxnIndexFromSignature(sig);
}

export function startProgramLogStream(params: {
  connection: Connection;
  programId: PublicKey;
  store: TradeStore;
  wsHub: WsHub;
  onEvent?: () => void;
}) {
  const { connection, programId, store, wsHub, onEvent } = params;

  const programIdStr = programId.toBase58();
  const seenTx = new Set<string>();
  const inflightTx = new Set<string>();

  async function fetchTransactionWithRetry(sig: string): Promise<VersionedTransactionResponse | null> {
    const attempts = 5;
    const delaysMs = [0, 200, 500, 1000, 2000];

    for (let i = 0; i < attempts; i++) {
      const delay = delaysMs[i] ?? 1000;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const tx = await connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (tx) return tx;
      } catch (err) {
        if (i === attempts - 1) {
          console.error(`[PROGRAM_WS] Failed to fetch transaction ${sig}:`, err);
        }
      }
    }

    console.warn(`[PROGRAM_WS] Transaction not found after retries: ${sig}`);
    return null;
  }

  const subIdPromise = Promise.resolve(
    connection.onLogs(
      programId,
      async (logInfo: any) => {
        const sig = logInfo?.signature;
        if (!sig || seenTx.has(sig) || inflightTx.has(sig)) return;
        inflightTx.add(sig);

        // Update last event timestamp for health monitoring
        if (onEvent) onEvent();

        try {
          const tx = await fetchTransactionWithRetry(sig);
          if (!tx) return;
          if (tx.meta?.err) {
            seenTx.add(sig);
            return;
          }

          const logs = tx.meta?.logMessages ?? [];
          const slot = tx.slot ?? null;
          const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, sig) : fallbackTxnIndexFromSignature(sig);
          const decoded = (decodeEventsFromLogs(logs) as AnchorEvent[]) ?? [];
          const poolFromEvents = firstPoolFromDecodedEvents(decoded);

          let cachedPoolView: Awaited<ReturnType<typeof readPool>> | null = null;
          if (poolFromEvents) {
            if (await isDexPoolTombstoned(poolFromEvents)) {
              warnDexPoolTombstoneOnce(poolFromEvents, "program_ws:decoded_pool");
            } else {
              try {
                cachedPoolView = await readPool(poolFromEvents);
              } catch {}
            }
          }

          let eventIndex = 0;
          for (const evt of decoded) {
            if (isSwapEventName(evt.name)) continue;

            const evtPool = poolFromEventData(evt.data ?? null);
            if (evtPool && await isDexPoolTombstoned(evtPool)) {
              warnDexPoolTombstoneOnce(evtPool, `program_ws:event:${evt.name}`);
              continue;
            }
            let poolView = cachedPoolView;

            if (!poolView && evtPool) {
              try {
                poolView = await readPool(evtPool);
              } catch {}
            }

            let formatted = evt.data ?? null;
            if (poolView) {
              try {
                formatted = formatEventData({
                  tx,
                  eventName: evt.name,
                  eventData: evt.data ?? {},
                  trade: null,
                  poolView,
                });
              } catch {}
            }

            await writeDexEvent({
              signature: sig,
              slot,
              blockTime: tx.blockTime ?? null,
              programId: programIdStr,
              eventType: getStandardEventType(evt.name),
              txnIndex,
              eventIndex: eventIndex++,
              eventData: formatted,
              logs,
              pool: evtPool,
            });

          let liqForWs: number | null = null;
          if (evtPool && slot != null && poolView && LIQ_EVENT_NAMES.has(evt.name)) {
            const liq = computeLiquidityQuoteFromPostBalances({ tx, poolView });
            if (liq != null) {
              liqForWs = liq;
              try {
                await updateDexPoolLiquidityState({ pool: evtPool, slot, liquidityQuote: liq });
                console.log(`[PROGRAM_WS] Updated liquidity for ${evtPool}: ${liq}`);
              } catch (err) {
                console.error(`[PROGRAM_WS] FAILED to update liquidity for ${evtPool}:`, err);
                // Don't throw - keep processing other events
              }
            } else {
              console.warn(`[PROGRAM_WS] Could not compute liquidity for ${evtPool} in slot ${slot}`);
            }
          }

          // Handle LiquidityLocked events for tvl_locked_quote
          if (evtPool && slot != null && evt.name === "LiquidityLocked") {
            const lockData = evt.data as any;
            const lpLocked = lockData?.lpLocked || lockData?.amount;

            if (lpLocked && poolView) {
              try {
                // Compute locked LP as quote-equivalent using current pool liquidity
                const liq = computeLiquidityQuoteFromPostBalances({ tx, poolView });
                if (liq != null) {
                  await updateDexPoolTvlLocked({ pool: evtPool, slot, tvlLockedQuote: liq });
                  console.log(`[PROGRAM_WS] Updated TVL locked for ${evtPool}: ${liq}`);
                }
              } catch (err) {
                console.error(`[PROGRAM_WS] Failed to update TVL locked for ${evtPool}:`, err);
              }
            }
          }

          // Handle FeeConfigUpdated events
          if (evtPool && evt.name === "FeeConfigUpdated") {
            const configData = evt.data as any;
            const baseFeeBps = configData?.baseFeeBps;

            if (baseFeeBps != null) {
              try {
                await supabase
                  .from("dex_pools")
                  .update({
                    base_fee_bps: baseFeeBps,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("pool", evtPool);
                console.log(`[PROGRAM_WS] Updated fee config for ${evtPool}: ${baseFeeBps} bps`);
              } catch (err) {
                console.error(`[PROGRAM_WS] Failed to update fee config for ${evtPool}:`, err);
              }
            }
          }

            const wsFormatted =
              liqForWs != null && formatted && typeof formatted === "object"
                ? ({ ...(formatted as Record<string, unknown>), liquidityQuote: liqForWs } as any)
                : formatted;

            wsHub.broadcast({
              type: "event",
              pool: evtPool ?? undefined,
              data: {
                signature: sig,
                slot,
                blockTime: tx.blockTime ?? null,
                activeBin: poolView?.activeBin ?? null,
                event: wsFormatted ? { name: evt.name, data: wsFormatted } : { name: evt.name },
              },
            });
          }

          const msg = tx.transaction.message;
          const keys =
            "accountKeys" in msg
              ? msg.accountKeys
              : [
                  ...msg.staticAccountKeys,
                  ...(tx.meta?.loadedAddresses?.writable ?? []),
                  ...(tx.meta?.loadedAddresses?.readonly ?? []),
                ];

          const pools = poolFromEvents ? [poolFromEvents] : keys.map((k) => k.toBase58());

          for (const pool of pools) {
            if (await isDexPoolTombstoned(pool)) {
              warnDexPoolTombstoneOnce(pool, "program_ws:trade_path");
              if (poolFromEvents) break;
              continue;
            }

            const seenKey = `${sig}:${pool}`;
            if (store.seen.has(seenKey)) continue;

            let poolView: Awaited<ReturnType<typeof readPool>>;
            try {
              poolView = cachedPoolView && pool === poolFromEvents ? cachedPoolView : await readPool(pool);
            } catch {
              if (poolFromEvents) break;
              continue;
            }

            await upsertDexPool({
              pool,
              programId: programIdStr,
              baseMint: poolView.baseMint,
              quoteMint: poolView.quoteMint,
              baseDecimals: poolView.baseDecimals,
              quoteDecimals: poolView.quoteDecimals,
            });

            const trade = deriveTradeFromTransaction(tx, {
              pool,
              baseVault: poolView.baseVault,
              quoteVault: poolView.quoteVault,
              baseMint: poolView.baseMint,
              quoteMint: poolView.quoteMint,
            });
            if (!trade) break;

            const priceAfterQ6464 = extractPriceAfterQ6464FromLogs(logs);
            if (priceAfterQ6464) {
              trade.priceAfterQ6464 = priceAfterQ6464;
            }

            store.seen.add(seenKey);
            store.byPool.set(pool, [trade, ...(store.byPool.get(pool) ?? [])].slice(0, 500));

            await writeDexTrade(trade);

            await updateDexPoolLiveState({
              pool,
              activeBin: poolView.activeBin,
              priceQuotePerBase: poolView.priceNumber,
              slot: tx.slot,
              signature: sig,
            });

            wsHub.broadcast({
              type: "trade",
              pool,
              data: {
                ...trade,
                priceQuotePerBase: poolView.priceNumber ?? null,
                activeBin: poolView.activeBin ?? null,
              } as any,
            });

            const swapEventData = formatEventData({
              tx,
              eventName: "SwapExecuted",
              eventData: {},
              trade,
              poolView,
            });

            if (swapEventData) {
              await writeDexEvent({
                signature: sig,
                slot,
                blockTime: tx.blockTime ?? null,
                programId: programIdStr,
                eventType: "swap",
                txnIndex,
                eventIndex: eventIndex++,
                eventData: swapEventData,
                logs,
                pool,
              });
            }

            break;
          }

          seenTx.add(sig);
        } finally {
          inflightTx.delete(sig);
        }
      },
      "confirmed"
    )
  )
    .catch((error) => {
      console.error("[program_ws] Failed to start log stream:", error.message);
      // Return null on error so server doesn't crash
      return null;
    });

  return {
    async stop() {
      try {
        const subId = await subIdPromise;
        if (subId !== null) {
          await connection.removeOnLogsListener(subId as number);
        }
      } catch (error: any) {
        console.error("[program_ws] Error during stop:", error.message);
      }
    },
  };
}
