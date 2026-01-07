import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import pino from "pino";
import pretty from "pino-pretty";

import { env, corsOrigins, poolsFromEnv } from "./config.js";
import { PROGRAM_ID } from "./solana.js";
import { v1Routes } from "./routes/v1.js";
import { createTradeStore, startTradeIndexer } from "./services/trades_indexer.js";
import { discoverPools } from "./services/fetch_pools.js";
import { reqId } from "./utils/http.js";

// logger
const logger =
  process.env.NODE_ENV === "production"
    ? pino({ level: env.LOG_LEVEL })
    : pino(pretty({ colorize: true, translateTime: "SYS:standard" }));

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

await app.register(helmet, { global: true });

await app.register(cors, {
  origin: corsOrigins.length ? corsOrigins : true,
  methods: ["GET"],
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  allowList: [],
});

app.decorate("dexKey", env.DEX_KEY);
app.decorate("programId", PROGRAM_ID.toBase58());
app.decorate("tradeStore", createTradeStore());
app.decorate("poolsList", [...poolsFromEnv]);

await app.register(v1Routes, { prefix: "/api/v1" });

/**
 * Pools list strategy:
 * If POOLS is provided, start with that.
 * If empty AND DISCOVER_POOLS=true, scan program accounts to find pools.
 * Refresh periodically (so new pools start indexing without redeploy).
 */
async function refreshPools(reason: string) {
  if (!env.DISCOVER_POOLS) return;

  try {
    const discovered = await discoverPools();
    // Replace list in-place so other modules referencing app.poolsList see updates
    app.poolsList.length = 0;
    app.poolsList.push(...discovered);

    app.log.info(
      { reason, count: discovered.length, programId: PROGRAM_ID.toBase58() },
      "pools discovered"
    );
  } catch (e) {
    app.log.warn({ err: e, reason }, "pool discovery failed");
  }
}

if (app.poolsList.length === 0) {
  await refreshPools("startup");
}

const indexer = startTradeIndexer(app.tradeStore, app.poolsList);

// periodic discovery refresh
const interval = setInterval(
  () => refreshPools("periodic"),
  env.DISCOVERY_REFRESH_SEC * 1000
);

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