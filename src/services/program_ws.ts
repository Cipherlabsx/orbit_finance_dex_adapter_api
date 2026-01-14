import type { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

import type { TradeStore } from "./trades_indexer.js";
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

      // NOTE: decodeEventsFromLogs must return something compatible with AnchorEvent[]
      const decoded = decodeEventsFromLogs(logs) as AnchorEvent[];

      // ALWAYS persist events
      try {
        if (decoded.length > 0) {
          let i = 0;
          for (const evt of decoded) {
            await writeDexEvent({
              signature: sig,
              slot: tx.slot ?? null,
              blockTime: tx.blockTime ?? null,
              programId: programIdStr,
              eventType: evt.name,
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
                slot: tx.slot ?? null,
                blockTime: tx.blockTime ?? null,
                event: evt.data
                  ? { name: evt.name, data: evt.data }
                  : { name: evt.name },
              },
            });
          }
        } else {
          await writeDexEvent({
            signature: sig,
            slot: tx.slot ?? null,
            blockTime: tx.blockTime ?? null,
            programId: programIdStr,
            eventType: "tx",
            eventIndex: 0,
            eventData: null,
            logs,
          });

          wsHub.broadcast({
            type: "event",
            data: {
              signature: sig,
              slot: tx.slot ?? null,
              blockTime: tx.blockTime ?? null,
              event: {
                name: "tx",
              },
            },
          });
        }
      } catch {
        // never break the stream due to supabase errors
      }

      // Materialize swaps into dex_trades (market data)
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

        let poolView;
        try {
          poolView = await readPool(pool);
        } catch {
          continue;
        }

        // keep pools table fresh
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

        store.seen.add(seenKey);
        const arr = store.byPool.get(pool) ?? [];
        arr.unshift(trade);
        store.byPool.set(pool, arr.slice(0, 500));

        try {
          await writeDexTrade(trade);
        } catch {
          // ignore
        }

        // ✅ include pool so ws hub can route to subscribers
        wsHub.broadcast({ type: "trade", pool, data: trade });

        // because dex_trades PK is signature-only, do NOT try to insert multiple pools per tx.
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