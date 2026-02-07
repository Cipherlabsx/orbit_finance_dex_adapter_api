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
 * Fee configuration schema
 * Enforces:
 * - baseFeeBps: 0-10000 bps (0-100%)
 * - creatorCutBps: 0-baseFeeBps
 * - Splits sum to exactly 100,000 microbps (100%)
 */
export const FeeConfigZ = z
  .object({
    baseFeeBps: z.number().int().min(0).max(10000),
    creatorCutBps: z.number().int().min(0).max(10000),
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
      .max(10000, "Bin step cannot exceed 10,000 bps"),
    initialPrice: z
      .number()
      .positive("Initial price must be positive")
      .finite("Initial price must be finite"),
    feeConfig: FeeConfigZ,
    accountingMode: z.literal(1, {
      errorMap: () => ({ message: "Only accounting mode 1 is supported" }),
    }),

    // Liquidity parameters (optional - pool can be created without liquidity)
    baseAmount: PositiveDecimalStringZ.optional(),
    quoteAmount: PositiveDecimalStringZ.optional(),
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
  .refine((data) => data.baseMint !== data.quoteMint, {
    message: "Base and quote tokens must be different",
    path: ["quoteMint"],
  })
  .refine(
    (data) => {
      // If liquidity is provided, ALL liquidity params must be provided
      const hasAnyLiquidity =
        data.baseAmount || data.quoteAmount || data.binsLeft || data.binsRight;
      const hasAllLiquidity =
        data.baseAmount && data.quoteAmount && data.binsLeft !== undefined && data.binsRight !== undefined;

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
  );

export type CreatePoolRequest = z.infer<typeof CreatePoolRequestZ>;

/**
 * POST /api/v1/pool/create-batch request schema (BATCHED FLOW - NEW)
 *
 * Same as CreatePoolRequestZ but enforces liquidity parameters
 * Batched flow REQUIRES liquidity to be added during pool creation
 */
export const CreatePoolBatchRequestZ = z
  .object({
    // Required addresses
    admin: SolanaPubkeyZ,
    creator: SolanaPubkeyZ,
    baseMint: SolanaPubkeyZ,
    quoteMint: SolanaPubkeyZ,
    lpMintPublicKey: SolanaPubkeyZ,

    // Pool configuration
    binStepBps: z.number().int().min(1).max(10000),
    initialPrice: z.number().positive().finite(),
    feeConfig: FeeConfigZ,
    accountingMode: z.literal(1),

    // Liquidity parameters (REQUIRED for batched flow)
    baseAmount: PositiveDecimalStringZ,
    quoteAmount: PositiveDecimalStringZ,
    binsLeft: z.number().int().min(0).max(200),
    binsRight: z.number().int().min(0).max(200),

    // Token decimals
    baseDecimals: z.number().int().min(0).max(18),
    quoteDecimals: z.number().int().min(0).max(18),

    // Optional settings
    settings: PoolCreationSettingsZ,
  })
  .refine((data) => data.baseMint !== data.quoteMint, {
    message: "Base and quote tokens must be different",
    path: ["quoteMint"],
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
