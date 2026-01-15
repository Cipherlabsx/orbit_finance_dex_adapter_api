import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export const env = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.string().default("info"),

    CORS_ORIGINS: z.string().optional(),

    SOLANA_RPC_URL: z.string().url(),
    ORBIT_PROGRAM_ID: z.string().min(32),

    // optional
    POOLS: z.string().optional(),

    DISCOVER_POOLS: z.coerce.boolean().default(true),
    DISCOVERY_REFRESH_SEC: z.coerce.number().int().min(10).max(3600).default(300),
    DISCOVERY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(2000),

    CACHE_TTL_MS: z.coerce.number().int().min(100).max(60_000).default(2500),
    SIGNATURE_LOOKBACK: z.coerce.number().int().min(10).max(5_000).default(200),
    TRADES_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(4000),

    DEX_KEY: z.string().min(2).default("orbit_finance"),

    // Historic backfill
    BACKFILL_MAX_SIGNATURES_PER_POOL: z.coerce.number().int().min(0).max(250_000).default(0),
    BACKFILL_PAGE_SIZE: z.coerce.number().int().min(10).max(1000).default(500),

    // Used server-side ONLY to parse req.url correctly
    HTTP_BASE_DEV: z.string().url().default("http://localhost:8080"),
    HTTP_BASE_PROD: z.string().url().optional(),

    // Used by clients (not server, but validated here)
    WS_BASE_DEV: z.string().optional(),
    WS_BASE_PROD: z.string().optional(),

    // Private WS auth token (server secret)
    WS_TOKEN: z.string().min(32),
    // ticket auth settings
    WS_TTL_SEC: z.coerce.number().int().min(5).max(300).default(30),
    WS_SKEW_SEC: z.coerce.number().int().min(0).max(60).default(5),

    // Streamflow staking
    STREAMFLOW_BACKFILL_ON_BOOT: z.coerce.boolean().default(false),
    STREAMFLOW_MAX_SIGS_PER_VAULT: z.coerce.number().int().min(0).max(250_000).default(5000),

    STREAMFLOW_TICK_MS: z.coerce.number().int().min(100).max(60_000).default(500),
    STREAMFLOW_FLUSH_MS: z.coerce.number().int().min(250).max(300_000).default(2000),
    STREAMFLOW_WRITE_DB: z.coerce.boolean().default(true),

    // progress logging
    STREAMFLOW_LOG_EVERY_SCANNED: z.coerce.number().int().min(1).max(10_000).default(500),
    STREAMFLOW_LOG_EVERY_USED: z.coerce.number().int().min(1).max(10_000).default(25),
    STREAMFLOW_TX_BATCH: z.coerce.number().int().min(1).max(100).default(10),
  })
  .parse(process.env);

/**
 * Derived helpers
 */
export const corsOrigins = env.CORS_ORIGINS ? csv(env.CORS_ORIGINS) : [];

/**
 * Pools explicitly provided via env (comma-separated).
 * If empty, discovery will populate at runtime.
 */
export const poolsFromEnv: string[] = env.POOLS ? csv(env.POOLS) : [];

/**
 * HTTP base used to safely parse req.url in WS handlers
 */
export const HTTP_BASE =
  process.env.NODE_ENV === "production"
    ? env.HTTP_BASE_PROD ?? env.HTTP_BASE_DEV
    : env.HTTP_BASE_DEV;

/**
 * WS base (exposed for clients)
 */
export const WS_BASE =
  process.env.NODE_ENV === "production"
    ? env.WS_BASE_PROD ?? env.WS_BASE_DEV
    : env.WS_BASE_DEV;