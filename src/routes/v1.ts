import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { env, HTTP_BASE, poolsFromEnv } from "../config.js";
import { readBins, readPool } from "../services/pool_reader.js";
import { getTrades, listIndexedPools } from "../services/trades_indexer.js";
import { readAsset } from "../services/assets.js";
import { readPair } from "../services/pairs.js";
import { readEventsBySlotRange, readLatestBlock } from "../services/events.js";
import { verifyWsTicket, mintWsTicket } from "../services/ws_auth.js";
import { getPoolVolumesAll } from "../services/volume_aggregator.js";
import { getCandles, getCandlesBundle } from "../services/candle_aggregator.js";
import { getOwnerStreamflowStakes, listStreamflowVaults } from "../services/streamflow_staking_indexer.js";
import { dbListPools, dbGetPool } from "../services/pool_db.js";

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

const TF_ALLOW = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "24h", "1d"]);

function parseTf(tfRaw: unknown, fallback: string) {
  const tf = (typeof tfRaw === "string" ? tfRaw : fallback).trim();
  return TF_ALLOW.has(tf) ? tf : fallback;
}

function parsePoolsCsv(poolsRaw: unknown): string[] {
  if (typeof poolsRaw !== "string" || !poolsRaw.trim()) return [];
  return poolsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
}

export async function v1Routes(app: FastifyInstance) {
  await app.register(websocket);

  // GET /api/v1/ws-ticket  -> { ticket, expiresInSec }
  app.get("/ws-ticket", async (req, reply) => {
    try {
      const { ticket, expiresInSec } = mintWsTicket();
      reply.header("cache-control", "no-store");
      return { ticket, expiresInSec };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ticket_error";
      reply.header("cache-control", "no-store");

      if (msg === "missing_server_secret") {
        reply.code(500);
        return { error: "missing_server_secret" };
      }

      reply.code(500);
      return { error: "ticket_error" };
    }
  });

  app.get("/ws", { websocket: true }, (conn, req) => {
    const url = new URL(req.url, HTTP_BASE);
    const ticket = url.searchParams.get("ticket");
    const v = verifyWsTicket(ticket);

    if (!v.ok) {
      conn.socket.close(1008, `unauthorized:${v.reason}`);
      return;
    }

    app.wsHub.add(conn.socket);

    conn.socket.send(
      JSON.stringify({
        type: "hello",
        programId: app.programId,
        ts: Date.now(),
      })
    );

    conn.socket.on("close", () => {
      try {
        const sockAny = conn.socket as any;
        if (sockAny.__orbitPools?.clear) sockAny.__orbitPools.clear();
      } catch {}
      app.wsHub.remove(conn.socket);
    });

    const sockAny = conn.socket as any;
    sockAny.__orbitPools = sockAny.__orbitPools ?? new Set<string>();

    conn.socket.on("message", async (raw) => {
      let msg: any = null;
      try {
        const txt = typeof raw === "string" ? raw : raw.toString();
        msg = JSON.parse(txt);
      } catch {
        return;
      }

      const type = typeof msg?.type === "string" ? msg.type : "";

      if (type === "subscribe") {
        const parsed = z
          .object({
            type: z.literal("subscribe"),
            pool: z.string().min(32),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          })
          .safeParse(msg);

        if (!parsed.success) {
          conn.socket.send(JSON.stringify({ type: "error", error: "bad_subscribe" }));
          return;
        }

        const { pool, limit } = parsed.data;

        const notAllowed = assertPoolAllowed(pool);
        if (notAllowed) {
          conn.socket.send(JSON.stringify({ type: "error", error: notAllowed.error, pool }));
          return;
        }

        sockAny.__orbitPools.add(pool);

        const trades = getTrades(app.tradeStore, pool, limit ?? 10)
          .slice()
          .sort((a, b) => {
            const ta = a.blockTime ?? 0;
            const tb = b.blockTime ?? 0;
            if (tb !== ta) return tb - ta;
            return (b.slot ?? 0) - (a.slot ?? 0);
          });

        conn.socket.send(
          JSON.stringify({
            type: "snapshot",
            pool,
            trades,
            ts: Date.now(),
          })
        );

        return;
      }

      if (type === "unsubscribe") {
        const parsed = z
          .object({
            type: z.literal("unsubscribe"),
            pool: z.string().min(32),
          })
          .safeParse(msg);

        if (!parsed.success) return;

        sockAny.__orbitPools?.delete(parsed.data.pool);
        return;
      }
    });
  });

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

    const row = await dbGetPool(params.pool);
    if (!row) return { error: "pool_not_found", pool: params.pool };
    return row;
  });

  app.get("/bins/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({
        radius: z.coerce.number().int().min(10).max(2000).default(60),
        limit: z.coerce.number().int().min(20).max(4000).default(180),
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

    return await readEventsBySlotRange(app.tradeStore, q.fromBlock, q.toBlock);
  });

  // GET /api/v1/volumes?tf=24h&pools=pool1,pool2
  // - If pools omitted -> active pools
  // - Returns per-pool volumes for the requested tf (default 24h) + ts
  app.get("/volumes", async (req) => {
    const q = z
      .object({
        tf: z.string().optional(),
        pools: z.string().optional(),
      })
      .parse((req.query ?? {}) as any);

    const tf = parseTf(q.tf, "24h");
    const requestedPools = parsePoolsCsv(q.pools);
    const pools = requestedPools.length ? requestedPools : getActivePools(app);

    const out: Record<string, any> = {};

    for (const pool of pools) {
      const notAllowed = assertPoolAllowed(pool);
      if (notAllowed) continue;

      // returns { "1m":..., "5m":..., ... "24h":..., "1d":... }
      const all = getPoolVolumesAll(app.volumeStore, pool as any);
      out[pool] = all[tf as keyof typeof all] ?? 0;
    }

    return { tf, volumes: out, ts: Date.now() };
  });

  // GET /api/v1/candles/:pool?tf=30m&limit=500
  app.get("/candles/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({
        tf: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      })
      .parse((req.query ?? {}) as any);

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    const tf = parseTf(q.tf, "30m");
    return getCandles(app.candleStore, params.pool, tf as any, q.limit);
  });

  // GET /api/v1/candles-bundle/:pool?limit=500
  // Returns current candle for all TFs.
  app.get("/candles-bundle/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      })
      .parse((req.query ?? {}) as any);

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    return getCandlesBundle(app.candleStore, params.pool, q.limit);
  });

  // GET /api/v1/streamflow/vaults
  app.get("/streamflow/vaults", async () => {
    return { vaults: listStreamflowVaults((app as any).stakeStore), ts: Date.now() };
  });

  // GET /api/v1/streamflow/stakes/:owner
  app.get("/streamflow/stakes/:owner", async (req) => {
    const params = z.object({ owner: z.string().min(32) }).parse(req.params);
    const rows = getOwnerStreamflowStakes((app as any).stakeStore, params.owner);
    return { owner: params.owner, rows, ts: Date.now() };
  });
}

