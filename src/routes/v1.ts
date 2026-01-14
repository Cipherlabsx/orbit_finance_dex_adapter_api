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
  /**
   * WebSocket endpoint:
   *   wss://<host>/api/v1/ws
   *
   * Broadcast happens from Solana WS subscription (program_ws.ts) via app.wsHub.broadcast(...)
   */
    await app.register(websocket);

  // Mint a short-lived WS ticket (frontend will fetch this first)
  // GET /api/v1/ws-ticket  -> { ticket, expiresInSec }
  app.get("/ws-ticket", async (req, reply) => {
    try {
      const { ticket, expiresInSec } = mintWsTicket();
      reply.header("cache-control", "no-store");
      return { ticket, expiresInSec };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ticket_error";
      reply.header("cache-control", "no-store");

      // align with your frontend error expectations
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

    // WS subscription + snapshot 
    // store per-socket subscriptions
    const sockAny = conn.socket as any;
    sockAny.__orbitPools = sockAny.__orbitPools ?? new Set<string>();

    conn.socket.on("message", async (raw) => {
      let msg: any = null;
      try {
        const txt = typeof raw === "string" ? raw : raw.toString();
        msg = JSON.parse(txt);
      } catch {
        // ignore invalid JSON
        return;
      }

      // minimal protocol
      // { type: "subscribe", pool: string, limit?: number }
      // { type: "unsubscribe", pool: string }
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

        // remember subscription
        sockAny.__orbitPools.add(pool);

        // send snapshot immediately (from current in-memory tradeStore)
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

      // ignore anything else for now
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

    return await readPool(params.pool);
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

    // Solana mapping: blockNumber == slot
    return await readEventsBySlotRange(app.tradeStore, q.fromBlock, q.toBlock);
  });
}