import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { env, poolsFromEnv } from "../config.js";
import { readBins, readPool } from "../services/pool_reader.js";
import { getTrades, listIndexedPools } from "../services/trades_indexer.js";
import { readAsset } from "../services/assets.js";
import { readPair } from "../services/pairs.js";
import { readEventsBySlotRange, readLatestBlock } from "../services/events.js";

/**
 * Small helper: choose pool set.
 * - If POOLS env is provided => use that (explicit allowlist)
 * - Else => use discovered/indexed pools (runtime)
 */
function getActivePools(app: FastifyInstance): string[] {
  if (poolsFromEnv.length > 0) return poolsFromEnv;
  return listIndexedPools(app.tradeStore);
}

/**
 * Enforce pool allowlist if POOLS is configured.
 */
function assertPoolAllowed(pool: string) {
  if (poolsFromEnv.length > 0 && !poolsFromEnv.includes(pool)) {
    return { error: "pool_not_allowed" as const, pool };
  }
  return null;
}

export async function v1Routes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/dex", async () => {
    const pools = getActivePools(app);
    return {
      dexKey: app.dexKey,
      programId: app.programId,
      pools,
      mode: poolsFromEnv.length > 0 ? "static" : "discovered",
      discoveryEnabled: env.DISCOVER_POOLS,
    };
  });

  app.get("/pools", async () => {
    const pools = getActivePools(app);
    const out = await Promise.all(pools.map((p) => readPool(p)));
    return { pools: out };
  });

  app.get("/pools/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    return await readPool(params.pool);
  });

  app.get("/bins/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({
        radius: z.coerce.number().int().min(10).max(2000).default(30),
        limit: z.coerce.number().int().min(20).max(4000).default(50),
      })
      .parse(req.query ?? {});

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    return await readBins(params.pool, { radius: q.radius, limit: q.limit });
  });

  app.get("/trades/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    const trades = getTrades(app.tradeStore, params.pool, q.limit);
    return { pool: params.pool, trades };
  });

  app.get("/latest-block", async () => {
    return await readLatestBlock();
  });

  app.get("/asset", async (req) => {
    const q = z.object({ id: z.string().min(32) }).parse((req.query ?? {}) as any);
    return await readAsset(q.id);
  });

  app.get("/pair", async (req) => {
    const q = z.object({ id: z.string().min(32) }).parse((req.query ?? {}) as any);
    return await readPair(q.id);
  });

  app.get("/events", async (req) => {
    const q = z
      .object({
        fromBlock: z.coerce.number().int().min(0),
        toBlock: z.coerce.number().int().min(0),
      })
      .parse((req.query ?? {}) as any);

    if (q.toBlock < q.fromBlock) return { events: [] };

    // if POOLS allowlist is configured, filter events down to those pools
    // (events reader can do filtering itself, but this ensures "only allowed pools" for partners)
    if (poolsFromEnv.length > 0) {
      // If your standards_events implementation supports filtering internally, prefer that.
      // Here we just call it and let it emit only what exists in tradeStore, tradeStore itself
      // can be constrained by discovery/POOLS in indexer bootstrap.
    }

    // Solana mapping: blockNumber == slot
    return await readEventsBySlotRange(app.tradeStore, q.fromBlock, q.toBlock);
  });
}