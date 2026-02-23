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
import { createVolumeStore, ingestFromTradeStore, startVolumeAggregator } from "./services/volume_aggregator.js";
import { createCandleStore, ingestCandlesFromTradeStore, startCandleAggregator } from "./services/candle_aggregator.js";
import { createStreamflowStakeStore, startStreamflowStakingAggregator } from "./services/streamflow_staking_indexer.js";
import { createFeesStore, initFeesFromDb, startFeesAggregator } from "./services/fees_aggregator.js";
import { initPriceCache, cleanPriceCache } from "./services/price_oracle.js";
import { dbListTokens } from "./services/token_registry.js";
import { startNftStakingIndexer, markExpiredStakes } from "./services/nft_staking_indexer.js";
import { filterDexTombstonedPools, primeDexPoolTombstoneCache } from "./supabase.js";

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

function parsePositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

const PROGRAM_WS_WATCHDOG_CHECK_MS = parsePositiveIntEnv(
  "PROGRAM_WS_WATCHDOG_CHECK_MS",
  60_000,
  5_000,
  300_000
);
const PROGRAM_WS_WATCHDOG_STALL_MS = parsePositiveIntEnv(
  "PROGRAM_WS_WATCHDOG_STALL_MS",
  600_000,
  30_000,
  3_600_000
);
const PROGRAM_WS_WATCHDOG_MIN_RESTART_MS = parsePositiveIntEnv(
  "PROGRAM_WS_WATCHDOG_MIN_RESTART_MS",
  180_000,
  10_000,
  3_600_000
);

/**
 * Security headers (Helmet)
 */
await app.register(helmet, { global: true });

/**
 * CORS
 * - If you provided allowlist, use it
 * - Else allow all (common for adapter endpoints consumed by partners)
 * - Allow GET and POST (for pool creation)
 */
await app.register(cors, {
  origin: corsOrigins.length ? corsOrigins : true,
  methods: ["GET", "POST"],
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
app.decorate("volumeStore", createVolumeStore());
app.decorate("candleStore", createCandleStore());
app.decorate("stakeStore", createStreamflowStakeStore());

// ✅ fees store available to routes if needed later
app.decorate("feesStore", createFeesStore());

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
 * CRITICAL INVARIANT:
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
    const filteredDiscovered = await filterDexTombstonedPools(discovered);

    // Update pools list in-place
    app.poolsList.length = 0;
    app.poolsList.push(...filteredDiscovered);

    // Seed trade store for immediate visibility
    seedPoolsIntoTradeStore(app.poolsList);

    app.log.info(
      {
        reason,
        count: filteredDiscovered.length,
        filteredOut: Math.max(0, discovered.length - filteredDiscovered.length),
        programId: PROGRAM_ID.toBase58(),
      },
      "pools discovered"
    );
  } catch (e) {
    app.log.warn({ err: e, reason }, "pool discovery failed");
  }
}

/**
 * Streamflow strategy:
 * - Start streamflow indexer
 */
const streamflowAgg = startStreamflowStakingAggregator({
  connection,
  stakeStore: (app as any).stakeStore,
});

/**
 * Startup behavior (non-blocking discovery only)
 */
if (app.poolsList.length === 0) {
  await refreshPools("startup");
}
if (app.poolsList.length > 0) {
  const filteredStaticPools = await filterDexTombstonedPools(app.poolsList);
  if (filteredStaticPools.length !== app.poolsList.length) {
    app.log.warn(
      { before: app.poolsList.length, after: filteredStaticPools.length },
      "filtered tombstoned pools from startup pool list"
    );
    app.poolsList.length = 0;
    app.poolsList.push(...filteredStaticPools);
  }
}
seedPoolsIntoTradeStore(app.poolsList);

/**
 * Periodic discovery refresh
 */
const interval = setInterval(
  () => refreshPools("periodic"),
  env.DISCOVERY_REFRESH_SEC * 1000
);

/**
 * Periodic price cache refresh (every 10 seconds)
 */
const priceInterval = setInterval(async () => {
  try {
    cleanPriceCache(); // Clean stale entries BEFORE fetching
    const tokens = await dbListTokens();
    const mints = tokens.map((t) => t.mint);
    await initPriceCache(mints);
  } catch (err) {
    app.log.warn({ err }, "price cache refresh failed");
  }
}, 10000);

/**
 * Declare variables for background services (will be initialized after server starts)
 */
let indexer: ReturnType<typeof startTradeIndexer>;
let volumeAgg: ReturnType<typeof startVolumeAggregator>;
let candleAgg: ReturnType<typeof startCandleAggregator>;
let feesAgg: ReturnType<typeof startFeesAggregator>;
let programStream: ReturnType<typeof startProgramLogStream>;
let nftStakingSubscription: number | null = null;
let expiredStakesInterval: NodeJS.Timeout | null = null;
let programWsWatchdogInterval: NodeJS.Timeout | null = null;
let programWsRestarting = false;
let programWsLastRestartAt = 0;
let isShuttingDown = false;

// Track last event time for health monitoring
let lastEventTime = 0;

// Decorate app with service references for health checks
app.decorate("services", {
  get indexer() { return indexer; },
  get volumeAgg() { return volumeAgg; },
  get candleAgg() { return candleAgg; },
  get feesAgg() { return feesAgg; },
  get programStream() { return programStream; },
  get lastEventTime() { return lastEventTime; },
  updateLastEventTime() { lastEventTime = Date.now(); },
});

/**
 * Graceful shutdown
 */
const shutdown = async (signal: string) => {
  isShuttingDown = true;
  app.log.info({ signal }, "shutting down");
  clearInterval(interval);
  clearInterval(priceInterval);
  if (expiredStakesInterval) clearInterval(expiredStakesInterval);
  if (programWsWatchdogInterval) clearInterval(programWsWatchdogInterval);

  if (indexer) indexer.stop();
  if (volumeAgg) volumeAgg.stop();
  if (candleAgg) candleAgg.stop();
  if (feesAgg) feesAgg.stop();

  await streamflowAgg.stop().catch(() => {});
  if (programStream) await programStream.stop().catch(() => {});

  // Stop NFT staking indexer
  if (nftStakingSubscription !== null) {
    try {
      await connection.removeOnLogsListener(nftStakingSubscription);
    } catch (err) {
      app.log.warn({ err }, "failed to stop NFT staking indexer");
    }
  }

  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * START SERVER FIRST (critical for fly health checks)
 */
const port = Number(process.env.PORT ?? env.PORT ?? 8080);

await app.listen({
  port,
  host: "0.0.0.0",
});

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

/**
 * BACKGROUND INITIALIZATION (runs after server is listening)
 * These can take time and won't block the server from starting
 */
setImmediate(async () => {
  try {
    app.log.info("starting background initialization");

    await primeDexPoolTombstoneCache().catch((err) => {
      app.log.warn({ err }, "failed to prime dex pool tombstone cache (continuing fail-open)");
    });

    // Init fees cache from DB
    await initFeesFromDb(app.feesStore, app.poolsList);
    app.log.info("fees cache initialized");

    // One-time historic backfill
    await backfillTrades(app.tradeStore, app.poolsList);
    app.log.info("trade backfill complete");

    // Seed volume + candles from tradeStore
    await ingestFromTradeStore(app.volumeStore, app.tradeStore, app.poolsList);
    await ingestCandlesFromTradeStore(app.candleStore, app.tradeStore, app.poolsList);
    app.log.info("volume and candles seeded");

    // Start background services
    indexer = startTradeIndexer(app.tradeStore, app.poolsList);
    volumeAgg = startVolumeAggregator({
      tradeStore: app.tradeStore,
      volumeStore: app.volumeStore,
      pools: app.poolsList,
    });
    candleAgg = startCandleAggregator({
      tradeStore: app.tradeStore,
      candleStore: app.candleStore,
      pools: app.poolsList,
    });
    feesAgg = startFeesAggregator({
      tradeStore: app.tradeStore,
      feesStore: app.feesStore,
      pools: app.poolsList,
      tickMs: 250,
      debounceMs: 500,
      minIntervalMs: 1000,
    });
    const startProgramWs = () =>
      startProgramLogStream({
        connection,
        programId: PROGRAM_ID,
        store: app.tradeStore,
        wsHub: app.wsHub,
        onEvent: () => (app as any).services.updateLastEventTime(),
      });

    const restartProgramWs = async (reason: string) => {
      if (isShuttingDown || programWsRestarting) return;
      const now = Date.now();
      if (now - programWsLastRestartAt < PROGRAM_WS_WATCHDOG_MIN_RESTART_MS) return;

      programWsRestarting = true;
      programWsLastRestartAt = now;
      app.log.warn(
        {
          reason,
          lastEventAgeMs: lastEventTime > 0 ? now - lastEventTime : null,
          checkMs: PROGRAM_WS_WATCHDOG_CHECK_MS,
          stallMs: PROGRAM_WS_WATCHDOG_STALL_MS,
        },
        "restarting program websocket log stream"
      );

      try {
        if (programStream) {
          await programStream.stop().catch((err) => {
            app.log.warn({ err }, "failed to stop program websocket stream during restart");
          });
        }
        programStream = startProgramWs();
      } finally {
        programWsRestarting = false;
      }
    };

    programStream = startProgramWs();
    programWsWatchdogInterval = setInterval(() => {
      if (isShuttingDown || !programStream || programWsRestarting) return;
      if (lastEventTime <= 0) return;
      const staleMs = Date.now() - lastEventTime;
      if (staleMs <= PROGRAM_WS_WATCHDOG_STALL_MS) return;
      void restartProgramWs(`stalled_no_events_${staleMs}ms`);
    }, PROGRAM_WS_WATCHDOG_CHECK_MS);

    // Start NFT staking indexer
    nftStakingSubscription = await startNftStakingIndexer(connection);

    // Mark expired stakes every 5 minutes
    expiredStakesInterval = setInterval(async () => {
      try {
        await markExpiredStakes();
      } catch (err) {
        app.log.warn({ err }, "failed to mark expired stakes");
      }
    }, 5 * 60 * 1000);

    app.log.info("all background services started");
  } catch (err) {
    app.log.error({ err }, "background initialization failed");
  }
});
