import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import pino from "pino";
import pretty from "pino-pretty";

import { env, corsOrigins, poolsFromEnv } from "./config.js";
import { PROGRAM_ID, connection } from "./solana.js";
import { v1Routes } from "./routes/v1.js";
import { backfillTrades, createTradeStore, startTradeIndexer } from "./services/trades_indexer.js";
import { discoverPools } from "./services/fetch_pools.js";
import { reqId } from "./utils/http.js";

import { createWsHub } from "./services/ws.js";
import { startProgramLogStream } from "./services/program_ws.js";

/**
 * Logger
 * - Production: structured JSON logs (Fly/Logtail/Datadog)
 */
const logger =
  process.env.NODE_ENV === "production"
    ? pino({ level: env.LOG_LEVEL })
    : pino(pretty({ colorize: true, translateTime: "SYS:standard" }));

const app = Fastify({
  logger,
  genReqId: () => reqId(),
  trustProxy: true,
});

/**
 * Security headers (Helmet)
 */
await app.register(helmet, { global: true });

/**
 * CORS
 * - If you provided allowlist, use it
 * - Else allow all (common for adapter endpoints consumed by partners)
 * - Only allow GET (API is read-only)
 */
await app.register(cors, {
  origin: corsOrigins.length ? corsOrigins : true,
  methods: ["GET"],
});

/**
 * Rate limiting
 * - Prevents basic abuse / accidental hammering
 * - 120 req/min per IP is reasonable for adapters
 */
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  allowList: [],
});

/**
 * Decorate runtime constants
 */
app.decorate("dexKey", env.DEX_KEY);
app.decorate("programId", PROGRAM_ID.toBase58());
app.decorate("tradeStore", createTradeStore());
app.decorate("wsHub", createWsHub());

/**
 * poolsList is the canonical list used by:
 * - /api/v1/dex
 * - discovery refresh
 * - trade indexer
 *
 * Start with POOLS env if provided otherwise it may be filled by discovery.
 */
app.decorate("poolsList", [...poolsFromEnv]);

/**
 * Register API routes
 */
await app.register(v1Routes, { prefix: "/api/v1" });

/**
 * CRITICAL INVARIANT: TODO
 * The /dex endpoint returns app.poolsList (discovered pools).
 * The /pools endpoint uses listIndexedPools(app.tradeStore) which is based on tradeStore.byPool keys.
 *
 * If you never "seed" tradeStore.byPool with discovered pools, it remains empty
 * until a trade is seen. That makes /pools return [] even while /dex returns pools.
 */
function seedPoolsIntoTradeStore(pools: string[]) {
  for (const pool of pools) {
    if (!app.tradeStore.byPool.has(pool)) {
      app.tradeStore.byPool.set(pool, []);
    }
  }
}

/**
 * Pool list strategy:
 * - If POOLS env is provided => static allowlist
 * - Else discover on-chain pools
 */
async function refreshPools(reason: string) {
  if (!env.DISCOVER_POOLS) return;

  try {
    const discovered = await discoverPools();

    // Update pools list in-place
    app.poolsList.length = 0;
    app.poolsList.push(...discovered);

    // Seed trade store for immediate visibility
    seedPoolsIntoTradeStore(app.poolsList);

    app.log.info(
      { reason, count: discovered.length, programId: PROGRAM_ID.toBase58() },
      "pools discovered"
    );
  } catch (e) {
    app.log.warn({ err: e, reason }, "pool discovery failed");
  }
}

/**
 * Startup behavior
 */
if (app.poolsList.length === 0) {
  await refreshPools("startup");
}
seedPoolsIntoTradeStore(app.poolsList);

/**
 * One-time historic backfill
 */
await backfillTrades(app.tradeStore, app.poolsList);

/**
 * Start polling-based trade indexer
 */
const indexer = startTradeIndexer(app.tradeStore, app.poolsList);

/**
 * Start WebSocket program log stream
 */
const programStream = startProgramLogStream({
  connection,
  programId: PROGRAM_ID,
  store: app.tradeStore,
  wsHub: app.wsHub,
});

/**
 * Periodic discovery refresh
 */
const interval = setInterval(
  () => refreshPools("periodic"),
  env.DISCOVERY_REFRESH_SEC * 1000
);

/**
 * Graceful shutdown
 */
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  clearInterval(interval);
  indexer.stop();
  await programStream.stop().catch(() => {});
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Listen to server
 */
await app.listen({ port: env.PORT, host: "0.0.0.0" });

app.log.info(
  {
    port: env.PORT,
    programId: PROGRAM_ID.toBase58(),
    pools: app.poolsList,
    dexKey: env.DEX_KEY,
    discoverPools: env.DISCOVER_POOLS,
    refreshSec: env.DISCOVERY_REFRESH_SEC,
  },
  "orbit dex adapter api started"
);