import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { env, HTTP_BASE, poolsFromEnv } from "../config.js";
import { readBins } from "../services/pool_reader.js";
import { getTrades, listIndexedPools } from "../services/trades_indexer.js";
import { readAsset } from "../services/assets.js";
import { readPair } from "../services/pairs.js";
import { readEventsBySlotRange, readLatestBlock } from "../services/events.js";
import { verifyWsTicket, mintWsTicket } from "../services/ws_auth.js";
import { getPoolVolumesAll } from "../services/volume_aggregator.js";
import { getCandles } from "../services/candle_aggregator.js";
import { getOwnerStreamflowStakes, listStreamflowVaults } from "../services/streamflow_staking_indexer.js";
import { dbListPools, dbGetPool } from "../services/pool_db.js";
import { dbListTokens, dbGetToken } from "../services/token_registry.js";
import { getTokenPrice, getRelativePrice, getBatchPrices } from "../services/price_oracle.js";
import { calculateHolderClaimable, calculateNftClaimable } from "../services/rewards.js";
import { buildPoolCreationTransactions, buildPoolCreationWithLiquidityTransactions, buildPoolCreationBatchTransactions, type FeeConfig } from "../services/pool_creation.js";
import { readPool } from "../services/pool_reader.js";
import { upsertDexPool, supabase } from "../supabase.js";
import { connection } from "../solana.js";
import {
  CreatePoolBatchRequestZ,
  CreatePoolRequestZ,
  PoolRegisterRequestZ,
  validateRequest,
} from "../schemas/pool_creation.js";

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

function num(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

const TF_SEC: Record<string, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

export async function v1Routes(app: FastifyInstance) {
  await app.register(websocket);

  // GET /api/v1/ws-ticket -> { ticket, expiresInSec }
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

  // GET /api/v1/tokens -> List all tokens
  app.get("/tokens", async (req, reply) => {
    const q = z
      .object({
        verified: z.coerce.boolean().optional(),
      })
      .parse((req.query ?? {}) as any);

    let tokens = await dbListTokens();

    if (q.verified !== undefined) {
      tokens = tokens.filter((t) => t.verified === q.verified);
    }

    // strip hot fields so this endpoint is "metadata truth"
    const tokensMeta = tokens.map(({ priceUsd, lastPriceUpdate, ...meta }) => meta);

    // long cache (adjust as you like)
    reply.header("cache-control", "public, max-age=3600"); // 1 hour
    return { tokens: tokensMeta, ts: Date.now() };
  });

  // GET /api/v1/tokens/:mint -> Get token by mint
  app.get("/tokens/:mint", async (req, reply) => {
    const params = z.object({ mint: z.string().min(32) }).parse(req.params);
    const token = await dbGetToken(params.mint);

    if (!token) {
      return { error: "token_not_found", mint: params.mint };
    }

    const { priceUsd, lastPriceUpdate, ...meta } = token;

    reply.header("cache-control", "public, max-age=3600");
    return { token: meta, ts: Date.now() };
  });

  // GET /api/v1/prices?mints=mint1,mint2 -> Get prices for tokens
  app.get("/prices", async (req, reply) => {
    const q = z
      .object({
        mints: z.string().optional(),
      })
      .parse((req.query ?? {}) as any);

    if (!q.mints) {
      return { error: "mints_required", message: "Provide comma-separated mints" };
    }

    const mints = q.mints.split(",").map((m) => m.trim()).filter((m) => m.length >= 32);

    if (mints.length === 0) {
      return { error: "invalid_mints" };
    }

    const prices = await getBatchPrices(mints);

    reply.header("cache-control", "public, max-age=5");
    return { prices, ts: Date.now() };
  });

  // GET /api/v1/price/:mint -> Get price for single token
  app.get("/price/:mint", async (req, reply) => {
    const params = z.object({ mint: z.string().min(32) }).parse(req.params);
    const result = await getTokenPrice(params.mint);

    reply.header("cache-control", "public, max-age=5");
    return {
      mint: params.mint,
      priceUsd: result.priceUsd,
      lastUpdated: result.lastUpdated,
      ts: Date.now(),
    };
  });

  app.get("/tokens/by-mints", async (req, reply) => {
    const q = z.object({ mints: z.string() }).parse((req.query ?? {}) as any);
    const mints = q.mints.split(",").map((m) => m.trim()).filter((m) => m.length >= 32);

    if (!mints.length) return { error: "invalid_mints" };

    // quick n dirty: reuse dbGetToken in parallel for 11 tokens
    const rows = await Promise.all(mints.map((m) => dbGetToken(m)));
    const tokens = rows.filter(Boolean).map((t) => {
      const { priceUsd, lastPriceUpdate, ...meta } = t as any;
      return meta;
    });

    reply.header("cache-control", "public, max-age=3600");
    return { tokens, ts: Date.now() };
  });

  // GET /api/v1/price-quote?base=X&quote=Y -> Get relative price
  app.get("/price-quote", async (req, reply) => {
    const q = z
      .object({
        base: z.string().min(32),
        quote: z.string().min(32),
      })
      .parse((req.query ?? {}) as any);

    const result = await getRelativePrice(q.base, q.quote);

    reply.header("cache-control", "public, max-age=10");
    return {
      base: q.base,
      quote: q.quote,
      price: result.price,
      baseUsd: result.baseUsd,
      quoteUsd: result.quoteUsd,
      lastUpdated: result.lastUpdated,
      ts: Date.now(),
    };
  });

  // POST /api/v1/pool/create -> Build pool creation transactions
  app.post("/pool/create", async (req, reply) => {
    // SECURITY: Validate request body using centralized Zod schema
    const validation = validateRequest(CreatePoolRequestZ, req.body);

    if (!validation.success) {
      reply.code(400);
      return {
        error: "validation_failed",
        message: "Request validation failed",
        errors: validation.errors,
      };
    }

    const body = validation.data;

    try {

      // Validate tokens exist in registry
      const baseToken = await dbGetToken(body.baseMint);
      const quoteToken = await dbGetToken(body.quoteMint);

      if (!baseToken) {
        reply.code(400);
        return { error: "base_token_not_in_registry", mint: body.baseMint };
      }
      if (!quoteToken) {
        reply.code(400);
        return { error: "quote_token_not_in_registry", mint: body.quoteMint };
      }

      // Validate creator cut <= base fee
      if (body.feeConfig.creatorCutBps > body.feeConfig.baseFeeBps) {
        reply.code(400);
        return {
          error: "invalid_fee_config",
          message: `creatorCutBps (${body.feeConfig.creatorCutBps}) cannot exceed baseFeeBps (${body.feeConfig.baseFeeBps})`,
        };
      }

      // Build transactions (with or without liquidity)
      const hasLiquidity = body.baseAmount && body.quoteAmount && body.binsLeft && body.binsRight;

      const result = hasLiquidity
        ? await buildPoolCreationWithLiquidityTransactions({
            admin: body.admin,
            creator: body.creator,
            baseMint: body.baseMint,
            quoteMint: body.quoteMint,
            lpMintPublicKey: body.lpMintPublicKey,
            binStepBps: body.binStepBps,
            initialPrice: body.initialPrice,
            baseDecimals: baseToken.decimals,
            quoteDecimals: quoteToken.decimals,
            feeConfig: body.feeConfig,
            accountingMode: body.accountingMode,
            baseAmount: body.baseAmount!,
            quoteAmount: body.quoteAmount!,
            binsLeft: body.binsLeft!,
            binsRight: body.binsRight!,
            priorityLevel: body.settings?.priorityLevel ?? "turbo",
          }, connection)
        : await buildPoolCreationTransactions({
            admin: body.admin,
            creator: body.creator,
            baseMint: body.baseMint,
            quoteMint: body.quoteMint,
            lpMintPublicKey: body.lpMintPublicKey,
            binStepBps: body.binStepBps,
            initialPrice: body.initialPrice,
            baseDecimals: baseToken.decimals,
            quoteDecimals: quoteToken.decimals,
            feeConfig: body.feeConfig,
            accountingMode: body.accountingMode,
            priorityLevel: body.settings?.priorityLevel ?? "turbo",
          });

      reply.header("cache-control", "no-store");
      return {
        success: true,
        ...result,
        ts: Date.now(),
      };
    } catch (error) {
      // Handle validation and business logic errors
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a validation error from pool_creation.ts
      if (
        errorMessage.includes("canonical order") ||
        errorMessage.includes("binStepBps must be") ||
        errorMessage.includes("splits must sum") ||
        errorMessage.includes("initialPrice must")
      ) {
        reply.code(400);
        return { error: "validation_failed", message: errorMessage };
      }

      // Unexpected error
      console.error("Pool creation error:", error);
      reply.code(500);
      return {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to build pool creation transactions",
        details: process.env.NODE_ENV === "development" ? errorMessage : undefined
      };
    }
  });

  // POST /api/v1/pool/create-batch -> Build pool creation with BATCHED liquidity
  // OPTIMIZATION: Reduces ~150 transactions to 2-7 transactions using lazy account creation
  app.post("/pool/create-batch", async (req, reply) => {
    // SECURITY: Validate request body using centralized Zod schema
    const validation = validateRequest(CreatePoolBatchRequestZ, req.body);

    if (!validation.success) {
      reply.code(400);
      return {
        error: "validation_failed",
        message: "Request validation failed",
        errors: validation.errors,
      };
    }

    const body = validation.data;

    try {

      // Validate tokens exist in registry
      const baseToken = await dbGetToken(body.baseMint);
      const quoteToken = await dbGetToken(body.quoteMint);

      if (!baseToken) {
        reply.code(400);
        return { error: "base_token_not_in_registry", mint: body.baseMint };
      }
      if (!quoteToken) {
        reply.code(400);
        return { error: "quote_token_not_in_registry", mint: body.quoteMint };
      }

      // Validate creator cut <= base fee
      if (body.feeConfig.creatorCutBps > body.feeConfig.baseFeeBps) {
        reply.code(400);
        return {
          error: "invalid_fee_config",
          message: `creatorCutBps (${body.feeConfig.creatorCutBps}) cannot exceed baseFeeBps (${body.feeConfig.baseFeeBps})`,
        };
      }

      // Build batched transactions (always includes liquidity for this endpoint)
      const result = await buildPoolCreationBatchTransactions({
        admin: body.admin,
        creator: body.creator,
        baseMint: body.baseMint,
        quoteMint: body.quoteMint,
        lpMintPublicKey: body.lpMintPublicKey,
        binStepBps: body.binStepBps,
        initialPrice: body.initialPrice,
        baseDecimals: baseToken.decimals,
        quoteDecimals: quoteToken.decimals,
        feeConfig: body.feeConfig,
        accountingMode: body.accountingMode,
        baseAmount: body.baseAmount,
        quoteAmount: body.quoteAmount,
        binsLeft: body.binsLeft,
        binsRight: body.binsRight,
        priorityLevel: body.settings?.priorityLevel ?? "turbo",
      }, connection);

      reply.header("cache-control", "no-store");
      return {
        success: true,
        ...result,
        optimization: "batched",
        transactionCount: result.transactions.length,
        ts: Date.now(),
      };
    } catch (error) {
      // Handle validation and business logic errors
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a validation error
      if (
        errorMessage.includes("binStepBps must be") ||
        errorMessage.includes("splits must sum") ||
        errorMessage.includes("initialPrice must") ||
        errorMessage.includes("Bin range")
      ) {
        reply.code(400);
        return { error: "validation_failed", message: errorMessage };
      }

      // Unexpected error
      console.error("Batched pool creation error:", error);
      reply.code(500);
      return {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to build batched pool creation transactions",
        details: process.env.NODE_ENV === "development" ? errorMessage : undefined
      };
    }
  });

  // POST /api/v1/pool/register -> Register newly created pool in database
  app.post("/pool/register", async (req, reply) => {
    // SECURITY: Validate request body using centralized Zod schema
    const validation = validateRequest(PoolRegisterRequestZ, req.body);

    if (!validation.success) {
      reply.code(400);
      return {
        error: "validation_failed",
        message: "Request validation failed",
        errors: validation.errors,
      };
    }

    const body = validation.data;

    try {

      // Fetch pool account from chain to verify it exists and get metadata
      let poolData;
      try {
        poolData = await readPool(body.poolAddress);
      } catch (error) {
        reply.code(404);
        return {
          error: "pool_not_found",
          message: `Pool ${body.poolAddress} not found on-chain. Ensure init_pool and init_pool_vaults transactions are confirmed.`,
        };
      }

      // Write to database with complete pool data
      await upsertDexPool({
        pool: body.poolAddress,
        programId: poolData.programId,
        baseMint: poolData.baseMint,
        quoteMint: poolData.quoteMint,
        baseDecimals: poolData.baseDecimals,
        quoteDecimals: poolData.quoteDecimals,
        baseVault: poolData.baseVault,
        quoteVault: poolData.quoteVault,
        admin: poolData.admin,
        baseFeeBps: poolData.baseFeeBps,
        binStepBps: poolData.binStepBps,
        activeBin: poolData.activeBin,
        initialBin: poolData.initialBin,
        pausedBits: poolData.pausedBits,
        creatorFeeVault: poolData.creatorFeeVault,
        holdersFeeVault: poolData.holdersFeeVault,
        nftFeeVault: poolData.nftFeeVault,
      });

      reply.header("cache-control", "no-store");
      return {
        success: true,
        pool: body.poolAddress,
        signature: body.signature,
        registered: true,
        ts: Date.now(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If it's a parse error
      if (errorMessage.includes("validation")) {
        reply.code(400);
        return { error: "invalid_request", message: errorMessage };
      }

      // Database or RPC error
      console.error("Pool registration error:", error);
      reply.code(500);
      return { error: "registration_failed", message: "Failed to register pool in database" };
    }
  });

  app.get("/pools", async () => {
    const pools = getActivePools(app);

    // pull DB rows
    const rows = await dbListPools(pools);

    const out = rows.map((r: any) => ({
      id: r.pool,
      programId: r.program_id ?? "",

      baseMint: r.base_mint ?? "",
      quoteMint: r.quote_mint ?? "",

      // safe defaults
      priceQ6464: "0",
      priceNumber: r.last_price_quote_per_base == null ? null : num(r.last_price_quote_per_base),

      baseVault: r.base_vault ?? "",
      quoteVault: r.quote_vault ?? "",

      creatorFeeVault: r.creator_fee_vault ?? null,
      holdersFeeVault: r.holders_fee_vault ?? null,
      nftFeeVault: r.nft_fee_vault ?? null,
      creatorFeeUi: num(r.creator_fee_ui),
      holdersFeeUi: num(r.holders_fee_ui),
      nftFeeUi: num(r.nft_fee_ui),
      feesUpdatedAt: r.fees_updated_at ?? null,

      activeBin: r.active_bin ?? 0,
      initialBin: r.initial_bin ?? 0,

      admin: r.admin ?? "",
      pausedBits: r.paused_bits ?? 0,
      binStepBps: r.bin_step_bps ?? 0,
      baseFeeBps: r.base_fee_bps ?? 0,

      liquidityQuote: num(r.liquidity_quote),
      tvlLockedQuote: num(r.tvl_locked_quote),
    }));

    return { pools: out };
  });

  app.get("/pools/:pool", async (req) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const query = z.object({
      includeBins: z.string().optional(),
      radius: z.string().optional(),
      limit: z.string().optional(),
    }).parse(req.query);

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    const r = await dbGetPool(params.pool);
    if (!r) return { error: "pool_not_found", pool: params.pool };

    // Parse bins if requested
    let bins: any[] | undefined;
    if (query.includeBins === "1" && r.bins) {
      try {
        const allBins = typeof r.bins === 'string' ? JSON.parse(r.bins) : r.bins;

        if (Array.isArray(allBins) && allBins.length > 0) {
          const radius = Math.min(800, Math.max(10, parseInt(query.radius || "60")));
          const limit = Math.min(1500, Math.max(50, parseInt(query.limit || "180")));
          const activeBin = r.active_bin ?? 0;

          // Filter bins within radius of active bin
          bins = allBins
            .filter((b: any) => {
              const binId = typeof b.binId === 'number' ? b.binId :
                            typeof b.bin_id === 'number' ? b.bin_id : null;
              if (binId === null) return false;
              return Math.abs(binId - activeBin) <= radius;
            })
            .slice(0, limit)
            .map((b: any) => ({
              binId: b.binId ?? b.bin_id,
              price: b.price,
              baseUi: b.baseUi ?? b.base_ui ?? 0,
              quoteUi: b.quoteUi ?? b.quote_ui ?? 0,
            }));
        }
      } catch (e) {
        // Invalid bins JSON - ignore
        bins = undefined;
      }
    }

    return {
      id: r.pool,
      programId: r.program_id ?? "",

      baseMint: r.base_mint ?? "",
      quoteMint: r.quote_mint ?? "",

      priceNumber: r.last_price_quote_per_base == null
        ? null
        : num(r.last_price_quote_per_base),

      baseVault: r.base_vault ?? "",
      quoteVault: r.quote_vault ?? "",

      creatorFeeVault: r.creator_fee_vault ?? null,
      holdersFeeVault: r.holders_fee_vault ?? null,
      nftFeeVault: r.nft_fee_vault ?? null,

      feesCollected: {
        creator: num(r.creator_fee_ui),
        holders: num(r.holders_fee_ui),
        nft: num(r.nft_fee_ui),
      },

      feesUpdatedAt: r.fees_updated_at ?? null,

      activeBin: r.active_bin ?? 0,
      pausedBits: r.paused_bits ?? 0,
      binStepBps: r.bin_step_bps ?? 0,
      baseFeeBps: r.base_fee_bps ?? 0,

      // Include bins if requested
      ...(bins ? { bins } : {}),
    };
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
        eventTypes: z.string().optional(),
      })
      .parse((req.query ?? {}) as any);

    if (q.toBlock < q.fromBlock) return { events: [] };

    // Parse event types filter (comma-separated)
    const eventTypes = q.eventTypes
      ? q.eventTypes.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;

    return await readEventsBySlotRange(app.tradeStore, q.fromBlock, q.toBlock, eventTypes);
  });

  // GET /api/v1/volumes?tf=24h&pools=pool1,pool2
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

      const all = getPoolVolumesAll(app.volumeStore, pool as any);
      out[pool] = all[tf as keyof typeof all] ?? 0;
    }

    return { tf, volumes: out, ts: Date.now() };
  });

  // GET /api/v1/candles/:pool?tf=15m&limit=1500
  app.get("/candles/:pool", async (req, reply) => {
    const params = z.object({ pool: z.string().min(32) }).parse(req.params);
    const q = z
      .object({
        tf: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1500).default(1500),
      })
      .parse((req.query ?? {}) as any);

    const notAllowed = assertPoolAllowed(params.pool);
    if (notAllowed) return notAllowed;

    const tf = parseTf(q.tf, "15m");

    reply.header("cache-control", "no-store");
    return getCandles(app.candleStore, params.pool, tf as any, q.limit);
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

  // POST /api/v1/rewards/holder/claimable
  // Calculate claimable CIPHER holder rewards for a user
  app.post("/rewards/holder/claimable", async (req, reply) => {
    const schema = z.object({
      user: z.string().length(44), // Base58 Solana public key
    });

    try {
      const body = schema.parse(req.body);

      const result = await calculateHolderClaimable(body.user);

      reply.header("cache-control", "no-store");
      return {
        ...result,
        ts: Date.now(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Validation error
      if (errorMessage.includes("validation") || errorMessage.includes("invalid")) {
        reply.code(400);
        return { error: "invalid_request", message: errorMessage };
      }

      // Global state not initialized
      if (errorMessage.includes("not initialized")) {
        reply.code(503);
        return { error: "service_not_ready", message: errorMessage };
      }

      // RPC or blockchain error
      console.error("Holder claimable calculation error:", error);
      reply.code(500);
      return { error: "calculation_failed", message: errorMessage };
    }
  });

  // POST /api/v1/rewards/nft/claimable
  // Calculate claimable NFT holder rewards for a user
  // Verifies NFT ownership and collection membership
  app.post("/rewards/nft/claimable", async (req, reply) => {
    const schema = z.object({
      user: z.string().length(44), // Base58 Solana public key
    });

    try {
      const body = schema.parse(req.body);

      const result = await calculateNftClaimable(body.user);

      reply.header("cache-control", "no-store");
      return {
        ...result,
        ts: Date.now(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Validation error
      if (errorMessage.includes("validation") || errorMessage.includes("invalid")) {
        reply.code(400);
        return { error: "invalid_request", message: errorMessage };
      }

      // Global state not initialized
      if (errorMessage.includes("not initialized")) {
        reply.code(503);
        return { error: "service_not_ready", message: errorMessage };
      }

      // RPC or blockchain error
      console.error("NFT claimable calculation error:", error);
      reply.code(500);
      return { error: "calculation_failed", message: errorMessage };
    }
  });

// GET /api/v1/tokens/prices?mints=mint1,mint2
// Reads token_registry.price_usd + last_price_update from DB.
app.get("/tokens/prices", async (req, reply) => {
  const q = z
    .object({
      mints: z.string().optional(),
    })
    .parse((req.query ?? {}) as any);

  if (!q.mints) {
    reply.code(400);
    return { error: "mints_required", message: "Provide comma-separated mints" };
  }

  const mints = q.mints
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length >= 32);

  if (mints.length === 0) {
    reply.code(400);
    return { error: "invalid_mints" };
  }

  const rows = await Promise.all(mints.map((m) => dbGetToken(m)));

  const prices = rows
    .map((t, i) => {
      const mint = mints[i]!;
      if (!t) return { mint, priceUsd: null, lastUpdated: null };
      return {
        mint: t.mint,
        priceUsd: t.priceUsd ?? null,
        lastUpdated: t.lastPriceUpdate ? new Date(t.lastPriceUpdate).getTime() : null,
      };
    });

  reply.header("cache-control", "public, max-age=1"); // tiny cache, you poll anyway
  return { prices, ts: Date.now() };
});

// GET /api/v1/metrics
// Monitoring metrics endpoint for health checks and performance tracking
app.get("/metrics", async (req, reply) => {
  try {
    // Get latest indexed slot from dex_events
    const { data: latestEvent } = await supabase
      .from('dex_events')
      .select('slot')
      .order('slot', { ascending: false })
      .limit(1);

    const indexedSlot = latestEvent?.[0]?.slot ?? 0;

    // Get current chain slot
    const chainSlot = await connection.getSlot();

    // Calculate lag (slots behind)
    const slotLag = chainSlot - indexedSlot;

    // Get pool counts
    const { count: poolCount } = await supabase
      .from('dex_pools')
      .select('*', { count: 'exact', head: true });

    // Get stale pool count (not updated in last 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: stalePools } = await supabase
      .from('dex_pools')
      .select('*', { count: 'exact', head: true })
      .lt('updated_at', tenMinutesAgo);

    // WebSocket client count (if wsHub exists)
    const wsClients = req.server.wsHub?.size() ?? 0;

    reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      timestamp: Date.now(),
      metrics: {
        slot_lag: slotLag,
        indexed_slot: indexedSlot,
        chain_slot: chainSlot,
        ws_clients: wsClients,
        pools_total: poolCount ?? 0,
        pools_stale: stalePools ?? 0,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  } catch (error) {
    reply.code(500);
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});
}