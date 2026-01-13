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
    // 0 disables backfill
    BACKFILL_MAX_SIGNATURES_PER_POOL: z.coerce.number().int().min(0).max(250_000).default(0),
    // page size for `getSignaturesForAddress` pagination
    BACKFILL_PAGE_SIZE: z.coerce.number().int().min(10).max(1000).default(500),
  })
  .parse(process.env);

export const corsOrigins = env.CORS_ORIGINS ? csv(env.CORS_ORIGINS) : [];

/**
 * Pools explicitly provided via env (comma-separated).
 * If empty, discovery will populate at runtime.
 */
export const poolsFromEnv: string[] = env.POOLS ? csv(env.POOLS) : [];