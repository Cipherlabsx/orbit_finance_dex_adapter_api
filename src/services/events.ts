import type { TradeStore, Trade } from "./trades_indexer.js";
import { connection } from "../solana.js";
import { readPool } from "./pool_reader.js";

export type StandardsBlock = {
  blockNumber: number;
  blockTimestamp: number;
};

export type StandardsSwapEvent = {
  block: StandardsBlock;
  eventType: "swap";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;

  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;

  priceNative: string;
  reserves: {
    asset0: string;
    asset1: string;
  };
};

export type StandardsEventsResponse = {
  events: StandardsSwapEvent[];
};

/**
 * Decimalize bigint atoms into a decimal string (no rounding, trims trailing zeros).
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
 * Enforces: either (asset0In + asset1Out) OR (asset1In + asset0Out) OR no amounts at all.
 * If malformed, omit amounts to avoid schema-halting.
 */
function normalizeAmounts(args: {
  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;
}): Pick<StandardsSwapEvent, "asset0In" | "asset1In" | "asset0Out" | "asset1Out"> {
  const { asset0In, asset1In, asset0Out, asset1Out } = args;

  const has0In = !!asset0In;
  const has1In = !!asset1In;
  const has0Out = !!asset0Out;
  const has1Out = !!asset1Out;

  const ok =
    (!has0In && !has1In && !has0Out && !has1Out) ||
    (has0In && has1Out && !has1In && !has0Out) ||
    (has1In && has0Out && !has0In && !has1Out);

  if (!ok) return {};

  return {
    ...(asset0In ? { asset0In } : {}),
    ...(asset1In ? { asset1In } : {}),
    ...(asset0Out ? { asset0Out } : {}),
    ...(asset1Out ? { asset1Out } : {}),
  };
}

function toSwapEvent(args: {
  trade: Trade;
  poolId: string;
  slot: number;
  blockTime: number;
  txnIndex: number;
  eventIndex: number;
  maker: string;

  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;

  priceNative: string;
  reserve0: string;
  reserve1: string;
}): StandardsSwapEvent {
  const amounts = normalizeAmounts({
    asset0In: args.asset0In,
    asset1In: args.asset1In,
    asset0Out: args.asset0Out,
    asset1Out: args.asset1Out,
  });

  return {
    block: { blockNumber: args.slot, blockTimestamp: args.blockTime },
    eventType: "swap",
    txnId: args.trade.signature,
    txnIndex: args.txnIndex,
    eventIndex: args.eventIndex,
    maker: args.maker,
    pairId: args.poolId,
    ...amounts,
    priceNative: args.priceNative,
    reserves: { asset0: args.reserve0, asset1: args.reserve1 },
  };
}

/**
 * /events?fromBlock&toBlock (inclusive)
 * Uses in-memory TradeStore + enriches using pool_reader().
 */
export async function readEventsBySlotRange(
  store: TradeStore,
  fromSlot: number,
  toSlot: number,
): Promise<StandardsEventsResponse> {
  const all: Trade[] = [];
  for (const trades of store.byPool.values()) all.push(...trades);

  const filtered = all
    .filter((t) => t.slot >= fromSlot && t.slot <= toSlot)
    .sort((a, b) => (a.slot - b.slot) || a.signature.localeCompare(b.signature));

  // group by signature so eventIndex is stable per tx
  const bySig = new Map<string, Trade[]>();
  for (const t of filtered) {
    const arr = bySig.get(t.signature) ?? [];
    arr.push(t);
    bySig.set(t.signature, arr);
  }

  const events: StandardsSwapEvent[] = [];

  for (const [, trades] of bySig) {
    let eventIndex = 0;

    for (const trade of trades) {
      if (trade.blockTime == null) continue;

      const poolId = trade.pool;

      const pool = await readPool(poolId);

      // Hard correctness: skip if we can't produce valid, non-junk fields
      if (pool.priceNumber == null) continue;
      if (!pool.binReserveBaseAtoms || !pool.binReserveQuoteAtoms) continue;
      if (pool.priceNumber <= 0) continue;

      const reserveBaseAtoms = BigInt(pool.binReserveBaseAtoms);
      const reserveQuoteAtoms = BigInt(pool.binReserveQuoteAtoms);

      const reserve0 = decimalize(reserveBaseAtoms, pool.baseDecimals);
      const reserve1 = decimalize(reserveQuoteAtoms, pool.quoteDecimals);

      const priceNative = String(pool.priceNumber);

      // Amounts: only emit if Trade actually has them *and* mint mapping matches pool
      let asset0In: string | undefined;
      let asset1In: string | undefined;
      let asset0Out: string | undefined;
      let asset1Out: string | undefined;

      if (trade.amountIn && trade.amountOut && trade.inMint && trade.outMint) {
        const inAtoms = BigInt(trade.amountIn);
        const outAtoms = BigInt(trade.amountOut);

        if (trade.inMint === pool.baseMint && trade.outMint === pool.quoteMint) {
          asset0In = decimalize(inAtoms, pool.baseDecimals);
          asset1Out = decimalize(outAtoms, pool.quoteDecimals);
        } else if (trade.inMint === pool.quoteMint && trade.outMint === pool.baseMint) {
          asset1In = decimalize(inAtoms, pool.quoteDecimals);
          asset0Out = decimalize(outAtoms, pool.baseDecimals);
        }
      }

      events.push(
        toSwapEvent({
          trade,
          poolId,
          slot: trade.slot,
          blockTime: trade.blockTime,
          txnIndex: 0, 
          eventIndex: eventIndex++,
          maker: trade.user ?? "11111111111111111111111111111111",
          priceNative,
          reserve0,
          reserve1,
          asset0In,
          asset1In,
          asset0Out,
          asset1Out,
        }),
      );
    }
  }

  return { events };
}

/**
 * /latest-block
 * Must not advertise blocks beyond what /events can serve.
 * We serve from in-memory store safe to return current confirmed slot.
 */
export async function readLatestBlock(): Promise<{ block: StandardsBlock }> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);

  return {
    block: {
      blockNumber: slot,
      blockTimestamp: blockTime ?? Math.floor(Date.now() / 1000),
    },
  };
}