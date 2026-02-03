import type { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

import type { TradeStore, Trade } from "./trades_indexer.js";
import { deriveTradeFromTransaction } from "./trade_derivation.js";
import { readPool } from "./pool_reader.js";
import { decodeEventsFromLogs } from "../idl/coder.js";
import {
  updateDexPoolLiveState,
  updateDexPoolLiquidityState,
  upsertDexPool,
  writeDexEvent,
  writeDexTrade,
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
  "LiquidityWithdrawnUser",
  "LiquidityWithdrawnAdmin",
  "LiquidityLocked",
]);

// Helpers
function isSwapEventName(name: string): boolean {
  return name === "SwapExecuted";
}

function poolFromEventData(data: JsonObject | null | undefined): string | null {
  if (!data) return null;
  if (typeof data.pool === "string") return data.pool;
  if (typeof data.pairId === "string") return data.pairId;
  if (typeof data.poolId === "string") return data.poolId;
  return null;
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

  const subIdPromise = (connection as any)._rpcWebSocket
    .call("logsSubscribe", [{ mentions: [programIdStr] }])
    .then((subId: number) => {
      (connection as any)._rpcWebSocket.on("logsNotification", async (args: any) => {
        if (args.subscription !== subId) return;

        const sig = args.result.value.signature;
        if (!sig || seenTx.has(sig)) return;
        seenTx.add(sig);

        let tx: VersionedTransactionResponse | null = null;
        try {
          tx = await connection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
        } catch {
          return;
        }
        if (!tx || tx.meta?.err) return;

        const logs = tx.meta?.logMessages ?? [];
        const slot = tx.slot ?? null;
        const txnIndex = slot != null ? await getTxnIndexForSignature(connection, slot, sig) : 0;
        const decoded = (decodeEventsFromLogs(logs) as AnchorEvent[]) ?? [];
        const poolFromEvents = firstPoolFromDecodedEvents(decoded);

        let cachedPoolView: Awaited<ReturnType<typeof readPool>> | null = null;
        if (poolFromEvents) {
          try {
            cachedPoolView = await readPool(poolFromEvents);
          } catch {}
        }

        let eventIndex = 0;
        for (const evt of decoded) {
          if (isSwapEventName(evt.name)) continue;

          const evtPool = poolFromEventData(evt.data ?? null);
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
          });

          if (evtPool && slot != null && poolView && LIQ_EVENT_NAMES.has(evt.name)) {
            const liq = computeLiquidityQuoteFromPostBalances({ tx, poolView });
            if (liq != null) {
              await updateDexPoolLiquidityState({ pool: evtPool, slot, liquidityQuote: liq });
            }
          }

          wsHub.broadcast({
            type: "event",
            pool: evtPool ?? undefined,
            data: {
              signature: sig,
              slot,
              blockTime: tx.blockTime ?? null,
              event: formatted ? { name: evt.name, data: formatted } : { name: evt.name },
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

          wsHub.broadcast({ type: "trade", pool, data: trade });

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
              eventIndex: 0,
              eventData: swapEventData,
              logs,
            });
          }

          break;
        }
      });

      return subId;
    });

  return {
    async stop() {
      const subId = await subIdPromise;
      await (connection as any)._rpcWebSocket.call("logsUnsubscribe", [subId]);
    },
  };
}