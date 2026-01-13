import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import pino from "pino";
import pretty from "pino-pretty";

import { env, corsOrigins, poolsFromEnv } from "./config.js";
import { PROGRAM_ID } from "./solana.js";
import { v1Routes } from "./routes/v1.js";
import { backfillTrades, createTradeStore, startTradeIndexer } from "./services/trades_indexer.js";
import { discoverPools } from "./services/fetch_pools.js";
import { reqId } from "./utils/http.js";

/**
 * Logger
 * - Production: structured JSON logs (Fly/Logtail/Datadog)
 */
const logger =
  process.env.NODE_ENV === "production"
    ? pino({ level: env.LOG_LEVEL })
    : pino(pretty({ colorize: true, translateTime: "SYS:standard" }));

/**
 * Extend Fastify instance typing for app.decorate()
 */
declare module "fastify" {
  interface FastifyInstance {
    dexKey: string;
    programId: string;
    tradeStore: ReturnType<typeof createTradeStore>;
    poolsList: string[];
  }
}

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

/**
 * poolsList is the canonical list used by:
 * - /api/v1/dex
 * - discovery refresh
 * - trade indexer
 *
 * Start with POOLS env if provided otherwise it may be filled by discovery.
 */
app.decorate("poolsList", [...poolsFromEnv]);
await app.register(v1Routes, { prefix: "/api/v1" });

/**
 * CRITICAL INVARIANT:
 * The /dex endpoint returns app.poolsList (discovered pools).
 * The /pools endpoint uses listIndexedPools(app.tradeStore) which is based on tradeStore.byPool keys.
 *
 * If you never "seed" tradeStore.byPool with discovered pools, it remains empty
 * until a trade is seen. That makes /pools return [] even while /dex returns pools.
 *
 * This function ensures:
 * - Every pool in app.poolsList has an entry in tradeStore.byPool immediately.
 * - We never delete anything from tradeStore.
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
 * - If POOLS env is provided => we use that allowlist and DO NOT need discovery.
 * - If POOLS is empty AND DISCOVER_POOLS=true => discover on-chain pools at startup.
 * - Refresh periodically so newly created pools appear without redeploy.
 *
 * - We replace app.poolsList IN-PLACE so any references stay valid.
 * - We then seed tradeStore so /pools works immediately.
 */
async function refreshPools(reason: string) {
  if (!env.DISCOVER_POOLS) return;

  try {
    const discovered = await discoverPools();

    // Update pools list in-place
    app.poolsList.length = 0;
    app.poolsList.push(...discovered);

    // Seed trade store for immediate visibility in /pools
    seedPoolsIntoTradeStore(app.poolsList);

    app.log.info(
      { reason, count: discovered.length, programId: PROGRAM_ID.toBase58() },
      "pools discovered"
    );
  } catch (e) {
    // Never crash the process because discovery failed - keep serving last-known state.
    app.log.warn({ err: e, reason }, "pool discovery failed");
  }
}

/**
 * Startup behavior:
 * - If POOLS env is empty => discover pools once at startup.
 * - Always seed tradeStore for whatever poolsList currently contains.
 */
if (app.poolsList.length === 0) {
  await refreshPools("startup");
}
seedPoolsIntoTradeStore(app.poolsList);

/**
 * One-time historic backfill on startup
 * Controlled by:
 *   BACKFILL_MAX_SIGNATURES_PER_POOL
 *   BACKFILL_PAGE_SIZE
 */
await backfillTrades(app.tradeStore, app.poolsList);

/**
 * Start live polling indexer (recent trades)
 */
const indexer = startTradeIndexer(app.tradeStore, app.poolsList);

/**
 * Periodic discovery refresh
 * - Adds newly created pools automatically
 * - Does not remove anything from tradeStore
 */
const interval = setInterval(
  () => refreshPools("periodic"),
  env.DISCOVERY_REFRESH_SEC * 1000
);

/**
 * Graceful shutdown
 * - Stop discovery refresh timer
 * - Stop indexer loop
 * - Close Fastify server
 */
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  clearInterval(interval);
  indexer.stop();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Listen (Fly expects host 0.0.0.0)
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