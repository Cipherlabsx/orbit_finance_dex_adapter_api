/**
 * Zod Validation Schemas for Pool Creation API
 *
 * SECURITY: Server-side validation for all pool creation endpoints
 * - Cannot be bypassed by malicious clients
 * - Protects Rust program from invalid inputs
 * - Provides clear error messages
 *
 * All endpoints MUST validate using these schemas before processing
 */

import { z } from "zod";

const MAX_BASE_FEE_BPS = 1000; // Must match on-chain cap (10%)
const ALLOWED_BIN_STEPS = [
  1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 50, 75, 80, 100, 125, 150, 160, 200, 250, 300, 400,
] as const;

/**
 * Solana public key validation
 * Base58 encoded, 32-44 characters (most commonly 44)
 */
export const SolanaPubkeyZ = z
  .string()
  .trim()
  .min(32, "Solana address too short")
  .max(44, "Solana address too long")
  .refine(
    (str) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(str),
    { message: "Invalid base58 Solana address" }
  );

/**
 * Positive decimal string (for token amounts)
 * Format: "123" or "123.456"
 */
export const PositiveDecimalStringZ = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Must be a valid decimal number")
  .refine(
    (str) => {
      const num = parseFloat(str);
      return !isNaN(num) && num > 0 && isFinite(num);
    },
    { message: "Must be a positive finite number" }
  );

/**
 * Non-negative decimal string (for single-sided amounts where one side can be "0")
 * Format: "0", "123", "123.456"
 */
export const NonNegativeDecimalStringZ = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Must be a valid decimal number")
  .refine(
    (str) => {
      const num = parseFloat(str);
      return !isNaN(num) && num >= 0 && isFinite(num);
    },
    { message: "Must be a non-negative finite number" }
  );

/**
 * Fee configuration schema
 * Enforces:
 * - baseFeeBps: 0-1000 bps (0-10%)
 * - creatorCutBps: 0-baseFeeBps
 * - Splits sum to exactly 100,000 microbps (100%)
 */
export const FeeConfigZ = z
  .object({
    baseFeeBps: z.number().int().min(0).max(MAX_BASE_FEE_BPS),
    creatorCutBps: z.number().int().min(0).max(MAX_BASE_FEE_BPS),
    splitHoldersMicrobps: z.number().int().min(0).max(100000),
    splitNftMicrobps: z.number().int().min(0).max(100000),
    splitCreatorExtraMicrobps: z.number().int().min(0).max(100000),
  })
  .refine((data) => data.creatorCutBps <= data.baseFeeBps, {
    message: "Creator cut cannot exceed base fee",
    path: ["creatorCutBps"],
  })
  .refine(
    (data) =>
      data.splitHoldersMicrobps +
        data.splitNftMicrobps +
        data.splitCreatorExtraMicrobps ===
      100000,
    {
      message: "Fee splits must sum to exactly 100,000 microbps (100%)",
      path: ["splitHoldersMicrobps"],
    }
  );

/**
 * Optional settings for pool creation
 */
export const PoolCreationSettingsZ = z
  .object({
    priorityLevel: z.enum(["fast", "turbo", "ultra"]).optional(),
  })
  .optional();

/**
 * POST /api/v1/pool/create request schema (sequential flow)
 *
 * Validates ALL pool creation parameters:
 * - Addresses (admin, creator, mints)
 * - Price and bin step
 * - Fee configuration
 * - Liquidity amounts (optional, but if provided must be valid)
 */
export const CreatePoolRequestZ = z
  .object({
    // Required addresses
    admin: SolanaPubkeyZ,
    creator: SolanaPubkeyZ,
    baseMint: SolanaPubkeyZ,
    quoteMint: SolanaPubkeyZ,
    lpMintPublicKey: SolanaPubkeyZ,

    // Pool configuration
    binStepBps: z
      .number()
      .int()
      .min(1, "Bin step must be at least 1 bps")
      .max(400, "Bin step cannot exceed 400 bps"),
    initialPrice: z
      .number()
      .positive("Initial price must be positive")
      .finite("Initial price must be finite"),
    feeConfig: FeeConfigZ,
    accountingMode: z.literal(1, {
      errorMap: () => ({ message: "Only accounting mode 1 is supported" }),
    }),

    // Liquidity parameters (optional - pool can be created without liquidity)
    baseAmount: NonNegativeDecimalStringZ.optional(),
    quoteAmount: NonNegativeDecimalStringZ.optional(),
    binsLeft: z
      .number()
      .int()
      .min(0, "Bins left cannot be negative")
      .max(200, "Bins left cannot exceed 200")
      .optional(),
    binsRight: z
      .number()
      .int()
      .min(0, "Bins right cannot be negative")
      .max(200, "Bins right cannot exceed 200")
      .optional(),

    // Token decimals (optional, will use default if not provided)
    baseDecimals: z.number().int().min(0).max(18).optional(),
    quoteDecimals: z.number().int().min(0).max(18).optional(),

    // Optional settings
    settings: PoolCreationSettingsZ,
  })
  .refine(
    (data) => (ALLOWED_BIN_STEPS as readonly number[]).includes(data.binStepBps),
    {
      message: `binStepBps must be one of: ${ALLOWED_BIN_STEPS.join(", ")}`,
      path: ["binStepBps"],
    }
  )
  .refine((data) => data.baseMint !== data.quoteMint, {
    message: "Base and quote tokens must be different",
    path: ["quoteMint"],
  })
  .refine(
    (data) => {
      // If liquidity is provided, ALL liquidity params must be provided
      const hasAnyLiquidity =
        data.baseAmount !== undefined ||
        data.quoteAmount !== undefined ||
        data.binsLeft !== undefined ||
        data.binsRight !== undefined;
      const hasAllLiquidity =
        data.baseAmount !== undefined &&
        data.quoteAmount !== undefined &&
        data.binsLeft !== undefined &&
        data.binsRight !== undefined;

      if (hasAnyLiquidity && !hasAllLiquidity) {
        return false;
      }
      return true;
    },
    {
      message:
        "If adding liquidity, must provide baseAmount, quoteAmount, binsLeft, and binsRight",
      path: ["baseAmount"],
    }
  )
  .refine(
    (data) => {
      // If liquidity fields are present, require non-zero liquidity on at least one side.
      const hasAllLiquidity =
        data.baseAmount !== undefined &&
        data.quoteAmount !== undefined &&
        data.binsLeft !== undefined &&
        data.binsRight !== undefined;
      if (!hasAllLiquidity) return true;

      const base = parseFloat(data.baseAmount!);
      const quote = parseFloat(data.quoteAmount!);
      return (Number.isFinite(base) && base > 0) || (Number.isFinite(quote) && quote > 0);
    },
    {
      message: "At least one of baseAmount or quoteAmount must be greater than zero",
      path: ["baseAmount"],
    }
  );

export type CreatePoolRequest = z.infer<typeof CreatePoolRequestZ>;

/**
 * Distribution strategy for liquidity allocation
 * Controls how liquidity is distributed across bins
 */
export const DistributionStrategyZ = z.enum([
  "uniform",       // Equal weight across all bins
  "concentrated",  // Bell curve centered around active bin
  "skew_bid",      // More liquidity on bid (lower price) side
  "skew_ask",      // More liquidity on ask (higher price) side
  "bid-ask",       // U-shaped curve (high edges, low center)
  "curve",         // Wide bell curve
  "custom"         // User-defined curve
]);

export type DistributionStrategy = z.infer<typeof DistributionStrategyZ>;

/**
 * Distribution configuration
 * Optional - defaults to uniform distribution for backward compatibility
 */
export const DistributionConfigZ = z.object({
  strategy: DistributionStrategyZ.optional().default("uniform"),
  decay: z.number().min(0).max(1).optional().default(0.4), // For concentrated/skew strategies
});

export type DistributionConfig = z.infer<typeof DistributionConfigZ>;

/**
 * POST /api/v1/pool/create-batch request schema (BATCHED FLOW - NEW)
 *
 * Same as CreatePoolRequestZ but enforces liquidity parameters
 * Batched flow REQUIRES liquidity to be added during pool creation
 */
const CreatePoolBatchBaseZ = z.object({
  // Required addresses
  admin: SolanaPubkeyZ,
  creator: SolanaPubkeyZ,
  baseMint: SolanaPubkeyZ,
  quoteMint: SolanaPubkeyZ,
  lpMintPublicKey: SolanaPubkeyZ,

  // Pool configuration
  binStepBps: z.number().int().min(1).max(400),
  initialPrice: z.number().positive().finite(),
  feeConfig: FeeConfigZ,
  accountingMode: z.literal(1),

  // Liquidity parameters (REQUIRED for batched flow)
  baseAmount: NonNegativeDecimalStringZ,
  quoteAmount: NonNegativeDecimalStringZ,
  binsLeft: z.number().int().min(0).max(200),
  binsRight: z.number().int().min(0).max(200),

  // Distribution strategy (OPTIONAL - defaults to uniform)
  distribution: DistributionConfigZ.optional(),

  // Token decimals
  baseDecimals: z.number().int().min(0).max(18),
  quoteDecimals: z.number().int().min(0).max(18),

  // Optional settings
  settings: PoolCreationSettingsZ,
});

export const CreatePoolBatchRequestZ = CreatePoolBatchBaseZ
  .refine(
    (data) => (ALLOWED_BIN_STEPS as readonly number[]).includes(data.binStepBps),
    {
      message: `binStepBps must be one of: ${ALLOWED_BIN_STEPS.join(", ")}`,
      path: ["binStepBps"],
    }
  )
  .refine((data) => data.baseMint !== data.quoteMint, {
    message: "Base and quote tokens must be different",
    path: ["quoteMint"],
  })
  .refine((data) => {
    const base = parseFloat(data.baseAmount);
    const quote = parseFloat(data.quoteAmount);
    return (Number.isFinite(base) && base > 0) || (Number.isFinite(quote) && quote > 0);
  }, {
    message: "At least one of baseAmount or quoteAmount must be greater than zero",
    path: ["baseAmount"],
  });

export type CreatePoolBatchRequest = z.infer<typeof CreatePoolBatchRequestZ>;

/**
 * POST /api/v1/pool/register request schema
 */
export const PoolRegisterRequestZ = z.object({
  poolAddress: SolanaPubkeyZ,
  signature: z
    .string()
    .trim()
    .min(64, "Signature too short")
    .max(128, "Signature too long"),
});

export type PoolRegisterRequest = z.infer<typeof PoolRegisterRequestZ>;

/**
 * Validation helper: Parse and validate request body
 * Returns validation result with user-friendly error messages
 */
export function validateRequest<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; errors: string[] } {
  try {
    const validated = schema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map((err) => {
        const path = err.path.join(".");
        return path ? `${path}: ${err.message}` : err.message;
      });
      return { success: false, errors };
    }
    return { success: false, errors: ["Validation failed"] };
  }
}
