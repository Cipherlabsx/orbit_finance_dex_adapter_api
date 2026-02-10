/**
 * Pool Creation Service
 *
 * Builds unsigned transactions for creating new liquidity pools.
 * Follows Orbit Finance DLMM program IDL for init_pool (merged with vault creation).
 *
 * OPTIMIZATION: init_pool and init_pool_vaults merged into single instruction (saves 1 tx).
 *
 * Security:
 * - Allows any mint ordering (no canonical requirement)
 * - Validates fee configuration (splits must sum to 100,000 microbps)
 * - Validates bin step against allowed values
 * - Only returns unsigned transactions (frontend signs)
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";
const { BorshCoder } = anchorPkg;
import BN from "bn.js";
import { ORBIT_IDL } from "../idl/coder.js";
import { PROGRAM_ID } from "../solana.js";

/**
 * SPL Memo program ID for adding human-readable descriptions to transactions
 */
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Priority fee levels for transaction execution
 */
export type PriorityLevel = "fast" | "turbo" | "ultra";

/**
 * Fee configuration for pool
 * Must match IDL FeeConfig struct
 */
export type FeeConfig = {
  baseFeeBps: number;           // Base fee in basis points (0-10000)
  creatorCutBps: number;        // Creator's cut of fees in bps (0-baseFeeBps)
  splitHoldersMicrobps: number; // Split for LP holders in microbps
  splitNftMicrobps: number;     // Split for NFT holders in microbps
  splitCreatorExtraMicrobps: number; // Additional creator split in microbps
};

/**
 * Input parameters for pool creation (without liquidity)
 */
export type PoolCreationParams = {
  admin: string;                 // Pool admin (pays for creation, can be rotated later)
  creator: string;               // Pool creator (receives creator fee split)
  baseMint: string;              // Base token mint
  quoteMint: string;             // Quote token mint
  lpMintPublicKey: string;       // SECURITY: Client-generated LP mint public key (frontend generates and signs)
  binStepBps: number;            // Bin step in basis points (22 standard values: 1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 50, 75, 80, 100, 125, 150, 160, 200, 250, 300, 400)
  initialPrice: number;          // Initial price as decimal (e.g., 6.35 for CIPHER/USDC)
  baseDecimals: number;          // Base token decimals
  quoteDecimals: number;         // Quote token decimals
  feeConfig: FeeConfig;          // Fee configuration
  accountingMode: number;        // 1 = BinArray
  priorityLevel?: PriorityLevel; // Priority fee level (default: turbo)
};

/**
 * Input parameters for pool creation WITH initial liquidity
 */
export type PoolCreationWithLiquidityParams = PoolCreationParams & {
  baseAmount: string;            // Base token amount to deposit (in UI units)
  quoteAmount: string;           // Quote token amount to deposit (in UI units)
  binsLeft: number;              // Number of bins to the left of active bin
  binsRight: number;             // Number of bins to the right of active bin
};

/**
 * Result of pool creation transaction building
 *
 * SECURITY: Only returns public keys, never secret keys
 * The frontend generates the LP mint keypair locally and signs transactions
 */
export type PoolCreationResult = {
  transactions: Array<{
    type: "init_pool" | "create_bin_arrays" | "init_position" | "init_position_bins" | "add_liquidity" | "verify_accounting";
    instructions: SerializedInstruction[];
  }>;
  poolAddress: string;
  lpMintPublicKey: string; // SECURITY: Only public key returned
  registryAddress: string;
  positionAddress?: string; // Only present if liquidity is added
};

/**
 * Serialized instruction format for JSON transport
 */
export type SerializedInstruction = {
  programId: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string; // Base64-encoded instruction data
};

/**
 * Allowed bin step values (in basis points)
 */
const ALLOWED_BIN_STEPS = [1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 50, 75, 80, 100, 125, 150, 160, 200, 250, 300, 400];

/**
 * Convert signed bin index (i32) to canonical u64 encoding FOR INSTRUCTION DATA ONLY.
 *
 * WARNING: This function is for encoding bin_index in instruction data where
 * the Rust program stores it as u64. DO NOT use this for PDA derivation!
 *
 * - PDA derivation: Uses i32 (4 bytes) → use derivePositionBinPda() function
 * - Instruction data: Uses u64 (8 bytes) → use this function
 *
 * Matches Rust's canonical encoding: (bin_index as i64) as u64
 * This performs 64-bit sign extension for negative values, NOT 32-bit two's complement.
 * Example: -1224 → 0xFFFFFFFFFFFFFB38 (18446744073709550392)
 *
 * @param binIndexSigned - Signed bin index (i32 range: -2147483648 to 2147483647)
 * @returns Canonical u64 encoding (64-bit sign extension) for instruction data
 */
function binIndexToU64(binIndexSigned: number): bigint {
  // Rust canonical encoding: (i32 as i64) as u64
  // For negative numbers, this performs 64-bit sign extension
  return BigInt(binIndexSigned) & 0xFFFFFFFFFFFFFFFFn;
}


/**
 * Validates fee configuration
 */
function validateFeeConfig(config: FeeConfig): void {
  // Base fee must be 0-10000 bps (0-100%)
  if (config.baseFeeBps < 0 || config.baseFeeBps > 10000) {
    throw new Error(`baseFeeBps must be 0-10000, got ${config.baseFeeBps}`);
  }

  // Creator cut must be <= base fee
  if (config.creatorCutBps < 0 || config.creatorCutBps > config.baseFeeBps) {
    throw new Error(
      `creatorCutBps must be 0-${config.baseFeeBps} (baseFeeBps), got ${config.creatorCutBps}`
    );
  }

  // Splits must sum to exactly 100,000 microbps (100%)
  const totalSplit =
    config.splitHoldersMicrobps +
    config.splitNftMicrobps +
    config.splitCreatorExtraMicrobps;

  if (totalSplit !== 100000) {
    throw new Error(
      `Fee splits must sum to 100,000 microbps. ` +
      `Got: holders=${config.splitHoldersMicrobps} + nft=${config.splitNftMicrobps} + ` +
      `creatorExtra=${config.splitCreatorExtraMicrobps} = ${totalSplit}`
    );
  }

  // Individual splits must be non-negative
  if (config.splitHoldersMicrobps < 0 || config.splitNftMicrobps < 0 || config.splitCreatorExtraMicrobps < 0) {
    throw new Error("Fee split values cannot be negative");
  }
}

/**
 * Validates bin step is an allowed value
 */
function validateBinStep(binStepBps: number): void {
  if (!ALLOWED_BIN_STEPS.includes(binStepBps)) {
    throw new Error(
      `binStepBps must be one of ${ALLOWED_BIN_STEPS.join(", ")}. Got ${binStepBps}`
    );
  }
}

/**
 * Converts decimal price to Q64.64 fixed-point format
 *
 * Formula: Q64.64 = (quoteAtoms << 64) / baseAtoms
 * Where atoms = price * 10^decimals
 */
function calculatePriceQ64_64(
  price: number,
  baseDecimals: number,
  quoteDecimals: number
): bigint {
  // SECURITY FIX: Validate price is finite to prevent RangeError crash
  // BigInt(Infinity) throws RangeError which crashes the server
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`initialPrice must be a positive finite number, got ${price}`);
  }

  // SECURITY FIX: Validate decimals are in safe range (0-18)
  // Prevents 10^309 = Infinity which would cause calculation failure
  if (baseDecimals < 0 || baseDecimals > 18 || quoteDecimals < 0 || quoteDecimals > 18) {
    throw new Error(`Decimals must be 0-18, got base=${baseDecimals}, quote=${quoteDecimals}`);
  }

  // Convert price to atoms (smallest units)
  const scaledPrice = price * 10 ** quoteDecimals;

  // SECURITY FIX: Verify scaled price is still finite before BigInt conversion
  if (!Number.isFinite(scaledPrice)) {
    throw new Error(`Price ${price} too large for ${quoteDecimals} decimals (result: ${scaledPrice})`);
  }

  const quoteAtoms = BigInt(Math.floor(scaledPrice));
  const baseAtoms = BigInt(10 ** baseDecimals);

  // Q64.64 = (quoteAtoms << 64) / baseAtoms
  return (quoteAtoms << 64n) / baseAtoms;
}

/**
 * Derives pool PDA
 * Seeds: ["pool", baseMint, quoteMint]
 */
/**
 * Derive pool PDA (Program Derived Address)
 *
 * CRITICAL: Pool address includes BOTH bin_step_bps AND base_fee_bps to allow multiple pools
 * per token pair with different configurations:
 * - bin_step_bps: Price granularity (1-400 bps) - tighter spreads vs wider ranges
 * - base_fee_bps: Swap fee tier (e.g., 5 = 0.05%, 30 = 0.30%, 100 = 1.00%)
 *
 * This enables multi-tier pools: same token pair can have multiple fee tiers
 * (e.g., USDC/SOL with 0.05% fees for high volume, 0.30% fees for retail).
 *
 * @param baseMint - Base token mint address
 * @param quoteMint - Quote token mint address
 * @param binStepBps - Bin step in basis points (determines price granularity)
 * @param baseFeeBps - Base swap fee in basis points (determines fee tier)
 * @returns Tuple of [pool PDA, bump seed]
 */
function derivePoolPda(baseMint: PublicKey, quoteMint: PublicKey, binStepBps: number, baseFeeBps: number): [PublicKey, number] {
  // SECURITY FIX: Validate inputs fit in u16 (0-65535) before writing to buffer
  // writeUInt16LE silently truncates if value > 65535, causing wrong PDA derivation
  if (binStepBps < 0 || binStepBps > 65535 || !Number.isInteger(binStepBps)) {
    throw new Error(`binStepBps must be an integer in range 0-65535, got ${binStepBps}`);
  }
  if (baseFeeBps < 0 || baseFeeBps > 65535 || !Number.isInteger(baseFeeBps)) {
    throw new Error(`baseFeeBps must be an integer in range 0-65535, got ${baseFeeBps}`);
  }

  const binStepBuffer = Buffer.alloc(2);
  binStepBuffer.writeUInt16LE(binStepBps);

  const baseFeeBuffer = Buffer.alloc(2);
  baseFeeBuffer.writeUInt16LE(baseFeeBps);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
      binStepBuffer,
      baseFeeBuffer,
    ],
    PROGRAM_ID
  );
}

/**
 * Derives registry PDA (prevents duplicate pools)
 * Seeds: ["registry", baseMint, quoteMint, binStepBps, baseFeeBps]
 * CRITICAL: Each pool (unique base + quote + bin step + base fee) has its own registry
 * Allows multiple pools per token pair with different fee tiers
 */
function deriveRegistryPda(baseMint: PublicKey, quoteMint: PublicKey, binStepBps: number, baseFeeBps: number): [PublicKey, number] {
  // SECURITY FIX: Validate inputs fit in u16 (0-65535) before writing to buffer
  if (binStepBps < 0 || binStepBps > 65535 || !Number.isInteger(binStepBps)) {
    throw new Error(`binStepBps must be an integer in range 0-65535, got ${binStepBps}`);
  }
  if (baseFeeBps < 0 || baseFeeBps > 65535 || !Number.isInteger(baseFeeBps)) {
    throw new Error(`baseFeeBps must be an integer in range 0-65535, got ${baseFeeBps}`);
  }

  const binStepBuf = Buffer.alloc(2);
  binStepBuf.writeUInt16LE(binStepBps, 0);

  const baseFeeBuf = Buffer.alloc(2);
  baseFeeBuf.writeUInt16LE(baseFeeBps, 0);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("registry"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
      binStepBuf,
      baseFeeBuf,
    ],
    PROGRAM_ID
  );
}

/**
 * Derives vault PDA
 * Seeds: ["vault", pool, vaultType]
 */
function deriveVaultPda(pool: PublicKey, vaultType: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      pool.toBuffer(),
      Buffer.from(vaultType),
    ],
    PROGRAM_ID
  );
}

/**
 * Derives bin array PDA
 * Seeds: ["bin_array", pool, lower_bin_index (i32, little-endian)]
 */
function deriveBinArrayPda(pool: PublicKey, lowerBinIndex: number): [PublicKey, number] {
  const indexBuffer = Buffer.alloc(4);
  indexBuffer.writeInt32LE(lowerBinIndex, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("bin_array"),
      pool.toBuffer(),
      indexBuffer,
    ],
    PROGRAM_ID
  );
}

/**
 * Derives position PDA
 * Seeds: ["position", pool, owner, nonce (u64, little-endian)]
 */
function derivePositionPda(pool: PublicKey, owner: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      pool.toBuffer(),
      owner.toBuffer(),
      nonceBuffer,
    ],
    PROGRAM_ID
  );
}

/**
 * Returns priority fee micro-lamports based on level
 */
function getPriorityFeeMicroLamports(level: PriorityLevel): number {
  switch (level) {
    case "fast": return 1_000;
    case "ultra": return 5_000;
    case "turbo": return 2_000;
    default: return 2_000;
  }
}

/**
 * Creates a memo instruction for transaction metadata
 * Helps wallets display transaction purpose to users
 */
function createMemoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf-8"),
  });
}

/**
 * Serializes instruction for JSON transport
 */
function serializeInstruction(ix: TransactionInstruction): SerializedInstruction {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map(k => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

/**
 * Builds pool creation transaction (OPTIMIZED: merged init_pool + init_pool_vaults)
 *
 * Returns 1 transaction:
 * 1. init_pool: Creates pool state, LP mint, registry, and all 6 token vaults (merged)
 *
 * OPTIMIZATION: Reduced from 2 transactions to 1 by merging vault creation into init_pool.
 * Saves ~1 transaction fee (~0.000005 SOL) and reduces user signing burden.
 *
 * SECURITY:
 * - Validates all inputs before building transactions
 * - Returns unsigned transactions (frontend must sign)
 * - LP mint keypair generated CLIENT-SIDE (frontend only sends public key)
 * - Frontend must sign with both admin + lpMint keypairs
 * - Secret keys NEVER transmitted over network
 */
export async function buildPoolCreationTransactions(
  params: PoolCreationParams
): Promise<PoolCreationResult> {
  const {
    admin,
    creator,
    baseMint,
    quoteMint,
    lpMintPublicKey,
    binStepBps,
    initialPrice,
    baseDecimals,
    quoteDecimals,
    feeConfig,
    accountingMode,
    priorityLevel = "turbo",
  } = params;

  // Parse and validate public keys
  const adminPk = new PublicKey(admin);
  const creatorPk = new PublicKey(creator);
  const baseMintPk = new PublicKey(baseMint);
  const quoteMintPk = new PublicKey(quoteMint);

  // Validate inputs (canonical ordering removed - pools can be in any direction)
  validateBinStep(binStepBps);
  validateFeeConfig(feeConfig);

  // SECURITY FIX: Only BinArray mode (1) is supported, enforce strictly
  // Mode 0 may be for legacy/testing purposes and should not be used in production
  if (accountingMode !== 1) {
    throw new Error(`accountingMode must be 1 (BinArray), got ${accountingMode}`);
  }

  // Calculate Q64.64 price
  const initialPriceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);

  // Derive PDAs
  // CRITICAL: Pool PDA includes BOTH bin_step_bps AND base_fee_bps to enable multiple pools
  // per token pair with different fee tiers
  const [poolPda] = derivePoolPda(baseMintPk, quoteMintPk, binStepBps, feeConfig.baseFeeBps);
  // CRITICAL: Registry PDA also includes BOTH bin_step_bps AND base_fee_bps (one registry per pool)
  const [registryPda] = deriveRegistryPda(baseMintPk, quoteMintPk, binStepBps, feeConfig.baseFeeBps);

  // SECURITY: Use client-provided LP mint public key (keypair generated on client)
  const lpMintPk = new PublicKey(lpMintPublicKey);

  // Build init_pool instruction
  const coder = new BorshCoder(ORBIT_IDL);

  const initPoolData = coder.instruction.encode("init_pool", {
    base_mint: baseMintPk,
    quote_mint: quoteMintPk,
    bin_step_bps: binStepBps,
    initial_price_q64_64: new BN(initialPriceQ64_64.toString()),
    fee_config: {
      base_fee_bps: feeConfig.baseFeeBps,
      creator_cut_bps: feeConfig.creatorCutBps,
      split_holders_microbps: feeConfig.splitHoldersMicrobps,
      split_nft_microbps: feeConfig.splitNftMicrobps,
      split_creator_extra_microbps: feeConfig.splitCreatorExtraMicrobps,
    },
    accounting_mode: accountingMode,
  });

  // Derive all vault PDAs (now created in same transaction as pool)
  const [baseVaultPda] = deriveVaultPda(poolPda, "base");
  const [quoteVaultPda] = deriveVaultPda(poolPda, "quote");
  const [creatorFeeVaultPda] = deriveVaultPda(poolPda, "creator_fee");
  const [holdersFeeVaultPda] = deriveVaultPda(poolPda, "holders_fee");
  const [nftFeeVaultPda] = deriveVaultPda(poolPda, "nft_fee");
  const [protocolFeeVaultPda] = deriveVaultPda(poolPda, "protocol_fee");

  // Build merged init_pool instruction (creates pool + vaults in one transaction)
  const initPoolIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminPk, isSigner: true, isWritable: true },
      { pubkey: creatorPk, isSigner: false, isWritable: false },
      { pubkey: baseMintPk, isSigner: false, isWritable: false },
      { pubkey: quoteMintPk, isSigner: false, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: lpMintPk, isSigner: true, isWritable: true },
      { pubkey: baseVaultPda, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda, isSigner: false, isWritable: true },
      { pubkey: creatorFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: holdersFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: nftFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: protocolFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: registryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initPoolData,
  });

  // Add compute budget instructions (increased limit for merged instruction)
  const priorityFeeMicroLamports = getPriorityFeeMicroLamports(priorityLevel);
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  // Create descriptive memo for wallet display (merged transaction)
  const initPoolMemoIx = createMemoInstruction(
    `Creating DLMM Pool + Vaults | ${baseMintPk.toBase58().slice(0, 6)}.../${quoteMintPk.toBase58().slice(0, 6)}... | Bin Step: ${binStepBps}bps | Price: ${initialPrice}`
  );

  return {
    transactions: [
      {
        type: "init_pool",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          serializeInstruction(initPoolMemoIx),
          serializeInstruction(initPoolIx),
        ],
      },
    ],
    poolAddress: poolPda.toBase58(),
    lpMintPublicKey: lpMintPk.toBase58(), // SECURITY: Only public key, never secret
    registryAddress: registryPda.toBase58(),
  };
}

/**
 * Builds pool creation WITH initial liquidity transactions
 *
 * Returns transaction groups (OPTIMIZED Phase 1+2: reduced from 5-17 to 1-13 transactions):
 * 1. init_pool: Creates pool state, LP mint, registry, and vaults (Phase 1: merged)
 * 2. create_bin_arrays: Creates bin arrays for liquidity (Phase 2: only missing ones)
 * 3. init_position: Creates position account (Phase 2: skipped if exists)
 * 4. add_liquidity: Deposits tokens into bins (batched)
 *
 * init_pool + init_pool_vaults merged (saves 1 transaction).
 * Smart account checking (saves 1-4 txs by skipping existing accounts).
 * - Checks if Position exists, skips creation if found
 * - Checks which BinArrays exist, only creates missing ones
 * - Enables resuming failed pool creations without redundant transactions
 */
export async function buildPoolCreationWithLiquidityTransactions(
  params: PoolCreationWithLiquidityParams,
  connection: Connection
): Promise<PoolCreationResult> {
  console.log("=".repeat(80));
  console.log("[POOL_CREATION] *** FUNCTION CALLED ***");
  console.log(`[POOL_CREATION] Admin: ${params.admin}`);
  console.log(`[POOL_CREATION] Base: ${params.baseMint}`);
  console.log(`[POOL_CREATION] Quote: ${params.quoteMint}`);
  console.log(`[POOL_CREATION] Bin step: ${params.binStepBps} bps`);
  console.log("=".repeat(80));

  const {
    admin,
    baseMint,
    quoteMint,
    binStepBps,
    initialPrice,
    baseDecimals,
    quoteDecimals,
    baseAmount,
    quoteAmount,
    binsLeft,
    binsRight,
    priorityLevel = "turbo",
  } = params;

  // First, build the base pool creation transactions
  const baseResult = await buildPoolCreationTransactions(params);

  const adminPk = new PublicKey(admin);
  const baseMintPk = new PublicKey(baseMint);
  const quoteMintPk = new PublicKey(quoteMint);
  const poolPda = new PublicKey(baseResult.poolAddress);

  const coder = new BorshCoder(ORBIT_IDL);
  const priorityFeeMicroLamports = getPriorityFeeMicroLamports(priorityLevel);
  // Increased from 1M to 1.4M to handle batched instructions (BinArrays, deposits)
  // Wallet simulation needs headroom - 1M was causing simulation failures
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  // Calculate active bin from initial price
  // DLMM specification constants
  const BIN_ARRAY_SIZE = 64; // Each BinArray holds exactly 64 bins

  const priceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);
  const activeBin = priceToActiveBin(priceQ64_64, binStepBps);

  // Calculate bin range based on strategy
  // NOTE: This creates (binsLeft + 1 + binsRight) total bins, including active bin
  // SECURITY FIX: Validate inputs BEFORE arithmetic to prevent integer overflow
  // If activeBin is near i32::MAX, then activeBin + binsRight could overflow
  if (binsLeft < 0 || binsRight < 0) {
    throw new Error(`Bin counts cannot be negative: binsLeft=${binsLeft}, binsRight=${binsRight}`);
  }

  // SECURITY FIX: Check arithmetic won't overflow i32 bounds BEFORE performing it
  // Use subtraction/addition in the check itself to detect overflow
  const MIN_I32 = -2147483648;
  const MAX_I32 = 2147483647;

  if (activeBin - binsLeft < MIN_I32) {
    throw new Error(
      `Lower bin index would underflow i32: activeBin=${activeBin}, binsLeft=${binsLeft}. ` +
      `Result would be < ${MIN_I32}. Reduce binsLeft.`
    );
  }
  if (activeBin + binsRight > MAX_I32) {
    throw new Error(
      `Upper bin index would overflow i32: activeBin=${activeBin}, binsRight=${binsRight}. ` +
      `Result would be > ${MAX_I32}. Reduce binsRight.`
    );
  }

  const lowerBinIndex = activeBin - binsLeft;
  const upperBinIndex = activeBin + binsRight;

  // Additional validation: verify final range is within i32 bounds (redundant but safe)
  if (lowerBinIndex < MIN_I32 || upperBinIndex > MAX_I32) {
    throw new Error(
      `Bin range [${lowerBinIndex}, ${upperBinIndex}] exceeds i32 bounds (-2147483648 to 2147483647). ` +
      `activeBin=${activeBin}, binsLeft=${binsLeft}, binsRight=${binsRight}. ` +
      `Reduce binsLeft or binsRight to fit within valid range.`
    );
  }

  // Validate bin range is reasonable (not too large)
  const totalBinsRequested = upperBinIndex - lowerBinIndex + 1;
  const MAX_BINS_PER_POOL = 1000; // Reasonable limit to prevent gas issues
  if (totalBinsRequested > MAX_BINS_PER_POOL) {
    throw new Error(
      `Bin range too large: ${totalBinsRequested} bins requested. ` +
      `Maximum allowed: ${MAX_BINS_PER_POOL}. ` +
      `Reduce binsLeft (${binsLeft}) or binsRight (${binsRight}).`
    );
  }

  console.log(`[POOL_CREATION] Bin range: ${lowerBinIndex} to ${upperBinIndex} (${totalBinsRequested} bins)`);
  console.log(`[POOL_CREATION] Active bin: ${activeBin} (price: ${initialPrice})`);

  // Determine which bin arrays we need to create
  const binArraysNeeded = new Set<number>();
  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    // CRITICAL: Use Math.trunc to match Rust integer division (truncates toward zero)
    const arrayIndex = Math.trunc(binIndex / BIN_ARRAY_SIZE);
    binArraysNeeded.add(arrayIndex * BIN_ARRAY_SIZE); // Store lower bin index of the array
  }

  // Check which bin arrays already exist on-chain (skip creating existing ones)
  const binArrayIndices = Array.from(binArraysNeeded).sort((a, b) => a - b);
  const binArrayPdas = binArrayIndices.map(lowerBinIdx => deriveBinArrayPda(poolPda, lowerBinIdx)[0]);

  console.log(`[POOL_CREATION] Checking ${binArrayPdas.length} BinArray PDAs on-chain...`);
  for (let i = 0; i < binArrayPdas.length; i++) {
    console.log(`  BinArray ${i + 1}: ${binArrayPdas[i]!.toBase58()} (lower_bin_index: ${binArrayIndices[i]})`);
  }

  const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayPdas, "confirmed");

  console.log(`[POOL_CREATION] RPC response for BinArrays:`);
  for (let i = 0; i < binArrayInfos.length; i++) {
    const exists = binArrayInfos[i] !== null;
    console.log(`  BinArray ${i + 1}: ${exists ? 'EXISTS' : 'DOES NOT EXIST'} (${binArrayPdas[i]!.toBase58().slice(0, 8)}...)`);
  }

  // Filter to only bin arrays that DON'T exist yet (saves 1-3 transactions)
  const binArrayIndicesToCreate = binArrayIndices.filter((_, idx) => !binArrayInfos[idx]);

  console.log(`[POOL_CREATION] BinArray check:`);
  console.log(`  - Total needed: ${binArrayIndices.length}`);
  console.log(`  - Already exist: ${binArrayIndices.length - binArrayIndicesToCreate.length}`);
  console.log(`  - To create: ${binArrayIndicesToCreate.length}`);
  if (binArrayIndicesToCreate.length === 0 && binArrayIndices.length > 0) {
    console.warn(`[POOL_CREATION] ⚠️  WARNING: All BinArrays reported as existing! This might be incorrect.`);
  }

  // Build create_bin_array instructions and batch them
  // Each create_bin_array instruction is ~150 bytes
  // Safe batch size: ~5-6 instructions per transaction to stay under 1232 bytes
  const BIN_ARRAY_BATCH_SIZE = 5;
  const createBinArrayTransactions: Array<{ type: "create_bin_arrays"; instructions: SerializedInstruction[] }> = [];

  for (let i = 0; i < binArrayIndicesToCreate.length; i += BIN_ARRAY_BATCH_SIZE) {
    const batchIndices = binArrayIndicesToCreate.slice(i, i + BIN_ARRAY_BATCH_SIZE);
    const batchInstructions: SerializedInstruction[] = [];

    for (const lowerBinIdx of batchIndices) {
      const [binArrayPda] = deriveBinArrayPda(poolPda, lowerBinIdx);

      const data = coder.instruction.encode("create_bin_array", {
        lower_bin_index: lowerBinIdx,
      });

      const createBinArrayIx = serializeInstruction(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: adminPk, isSigner: true, isWritable: true },
            { pubkey: binArrayPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        })
      );

      batchInstructions.push(createBinArrayIx);
    }

    // Add memo for this batch
    const binArrayMemoIx = createMemoInstruction(
      `Creating Bin Arrays ${i / BIN_ARRAY_BATCH_SIZE + 1}/${Math.ceil(binArrayIndicesToCreate.length / BIN_ARRAY_BATCH_SIZE)} | Bins: [${batchIndices.join(", ")}]`
    );

    // Add batch transaction
    createBinArrayTransactions.push({
      type: "create_bin_arrays",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        serializeInstruction(binArrayMemoIx),
        ...batchInstructions,
      ],
    });
  }

  // Check if Position already exists (OPTIMIZATION: skip creation if it exists)
  const positionNonce = BigInt(0); // First position for this user in this pool
  const [positionPda] = derivePositionPda(poolPda, adminPk, positionNonce);

  const positionInfo = await connection.getAccountInfo(positionPda, "confirmed");
  const positionExists = positionInfo !== null;

  // Build init_position instruction only if it doesn't exist
  let initPositionIx: SerializedInstruction | null = null;
  let initPositionMemoIx: SerializedInstruction | null = null;

  if (!positionExists) {
    const initPositionData = coder.instruction.encode("init_position", {
      nonce: new BN(positionNonce.toString()),
    });

    initPositionIx = serializeInstruction(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: poolPda, isSigner: false, isWritable: true },
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: positionPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initPositionData,
      })
    );

    initPositionMemoIx = serializeInstruction(
      createMemoInstruction(
        `Creating Liquidity Position | Owner: ${adminPk.toBase58().slice(0, 8)}...`
      )
    );
  }

  // Build add_liquidity_v2 instruction(s)
  const [baseVaultPda] = deriveVaultPda(poolPda, "base");
  const [quoteVaultPda] = deriveVaultPda(poolPda, "quote");

  // Convert amounts to raw (atoms)
  // SECURITY FIX: Validate amounts are finite before BigInt conversion to prevent RangeError crash
  // parseFloat("1e308") * 10^6 = Infinity → BigInt(Infinity) throws RangeError
  const baseFloat = parseFloat(baseAmount);
  const quoteFloat = parseFloat(quoteAmount);

  if (!Number.isFinite(baseFloat) || baseFloat < 0) {
    throw new Error(`baseAmount must be a positive finite number, got ${baseAmount}`);
  }
  if (!Number.isFinite(quoteFloat) || quoteFloat < 0) {
    throw new Error(`quoteAmount must be a positive finite number, got ${quoteAmount}`);
  }

  const scaledBase = baseFloat * 10 ** baseDecimals;
  const scaledQuote = quoteFloat * 10 ** quoteDecimals;

  if (!Number.isFinite(scaledBase)) {
    throw new Error(`baseAmount ${baseAmount} too large for ${baseDecimals} decimals`);
  }
  if (!Number.isFinite(scaledQuote)) {
    throw new Error(`quoteAmount ${quoteAmount} too large for ${quoteDecimals} decimals`);
  }

  // SECURITY FIX: Validate amounts don't exceed u64::MAX to prevent on-chain overflow
  const MAX_U64 = BigInt("18446744073709551615");
  const baseAmountRaw = BigInt(Math.floor(scaledBase));
  const quoteAmountRaw = BigInt(Math.floor(scaledQuote));

  if (baseAmountRaw > MAX_U64) {
    throw new Error(`baseAmount exceeds u64 maximum: ${baseAmountRaw}`);
  }
  if (quoteAmountRaw > MAX_U64) {
    throw new Error(`quoteAmount exceeds u64 maximum: ${quoteAmountRaw}`);
  }

  // Build deposits array - distribute evenly across bins
  // IDL expects: { bin_index: u64, base_in: u64, quote_in: u64, min_shares_out: u64 }
  const depositsRaw: Array<{ bin_index: number; base_in: bigint; quote_in: bigint }> = [];
  const totalBins = upperBinIndex - lowerBinIndex + 1;

  // CRITICAL FIX: Count bins that actually use each token
  // SECURITY FIX: Active bin is EXCLUDED from deposits (program forbids ActiveBinDepositForbidden)
  // In DLMM: bins < activeBin get QUOTE (for BaseToQuote swaps), bins > activeBin get BASE (for QuoteToBase swaps)
  const binsWithQuote = activeBin - lowerBinIndex;   // Bins below active (exclusive) - get QUOTE
  const binsWithBase = upperBinIndex - activeBin;  // Bins above active (exclusive) - get BASE

  // Validate amounts are sufficient for distribution
  if (baseAmountRaw > 0n && baseAmountRaw < BigInt(binsWithBase)) {
    throw new Error(
      `Base amount (${baseAmountRaw} atoms) too small for ${binsWithBase} bins. ` +
      `Minimum required: ${binsWithBase} atoms (1 per bin).`
    );
  }
  if (quoteAmountRaw > 0n && quoteAmountRaw < BigInt(binsWithQuote)) {
    throw new Error(
      `Quote amount (${quoteAmountRaw} atoms) too small for ${binsWithQuote} bins. ` +
      `Minimum required: ${binsWithQuote} atoms (1 per bin).`
    );
  }

  // Calculate per-bin shares and remainders (to avoid truncation loss)
  const baseShare = binsWithBase > 0 ? baseAmountRaw / BigInt(binsWithBase) : 0n;
  const quoteShare = binsWithQuote > 0 ? quoteAmountRaw / BigInt(binsWithQuote) : 0n;
  const baseRemainder = binsWithBase > 0 ? baseAmountRaw % BigInt(binsWithBase) : 0n;
  const quoteRemainder = binsWithQuote > 0 ? quoteAmountRaw % BigInt(binsWithQuote) : 0n;

  console.log(`[POOL_CREATION] Liquidity distribution:`);
  console.log(`  Total bins: ${totalBins} (${lowerBinIndex} to ${upperBinIndex})`);
  console.log(`  Active bin: ${activeBin} (EXCLUDED from deposits)`);
  console.log(`  Bins with base: ${binsWithBase} (< active)`);
  console.log(`  Bins with quote: ${binsWithQuote} (> active)`);
  console.log(`  Base: ${baseAmountRaw} atoms = ${baseShare}/bin + ${baseRemainder} remainder`);
  console.log(`  Quote: ${quoteAmountRaw} atoms = ${quoteShare}/bin + ${quoteRemainder} remainder`);

  // Distribute liquidity with remainder distribution to avoid truncation loss
  let baseCounter = 0;  // Counter for bins receiving base tokens
  let quoteCounter = 0; // Counter for bins receiving quote tokens

  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    // CRITICAL FIX: Skip active bin entirely
    // Rust program forbids deposits into active bin (ActiveBinDepositForbidden)
    // Active bin should only have MM liquidity, not LP liquidity
    if (binIndex === activeBin) {
      console.log(`[POOL_CREATION] Skipping active bin ${activeBin} (deposits forbidden by program)`);
      continue;
    }

    let binBaseAmount = 0n;
    let binQuoteAmount = 0n;

    // Distribute QUOTE tokens to bins < activeBin (for BaseToQuote swaps - selling base for quote)
    if (binIndex < activeBin && quoteShare > 0n) {
      binQuoteAmount = quoteShare;
      // Distribute remainder: first N bins get +1 atom each (N = remainder)
      if (quoteCounter < Number(quoteRemainder)) {
        binQuoteAmount += 1n;
      }
      quoteCounter++;
    }

    // Distribute BASE tokens to bins > activeBin (for QuoteToBase swaps - buying base with quote)
    if (binIndex > activeBin && baseShare > 0n) {
      binBaseAmount = baseShare;
      // Distribute remainder: first N bins get +1 atom each (N = remainder)
      if (baseCounter < Number(baseRemainder)) {
        binBaseAmount += 1n;
      }
      baseCounter++;
    }

    // Only create deposit if at least one amount is non-zero
    if (binBaseAmount > 0n || binQuoteAmount > 0n) {
      depositsRaw.push({
        bin_index: binIndex,
        base_in: binBaseAmount,
        quote_in: binQuoteAmount
      });
    }
  }

  // Verify: total distributed should equal input amounts (no truncation loss)
  const totalBaseDistributed = depositsRaw.reduce((sum, d) => sum + d.base_in, 0n);
  const totalQuoteDistributed = depositsRaw.reduce((sum, d) => sum + d.quote_in, 0n);

  if (totalBaseDistributed !== baseAmountRaw) {
    throw new Error(
      `CRITICAL: Base amount mismatch! Input: ${baseAmountRaw}, Distributed: ${totalBaseDistributed}, ` +
      `Lost: ${baseAmountRaw - totalBaseDistributed}`
    );
  }
  if (totalQuoteDistributed !== quoteAmountRaw) {
    throw new Error(
      `CRITICAL: Quote amount mismatch! Input: ${quoteAmountRaw}, Distributed: ${totalQuoteDistributed}, ` +
      `Lost: ${quoteAmountRaw - totalQuoteDistributed}`
    );
  }

  console.log(`[POOL_CREATION] ✓ Distribution verified: ${depositsRaw.length} deposits created`);
  console.log(`  Total base distributed: ${totalBaseDistributed} atoms (100%)`);
  console.log(`  Total quote distributed: ${totalQuoteDistributed} atoms (100%)`);


  // Derive owner's token accounts (ATAs)
  // NOTE: Frontend is responsible for ensuring ATAs exist before calling add_liquidity
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  const [ownerBaseAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), baseMintPk.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [ownerQuoteAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), quoteMintPk.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // CRITICAL FIX: Check if position exists (not just current batch bins)
  // If position exists, previous add_liquidity txs succeeded and we need to fetch ALL existing bins
  // to include them in reconciliation via reference deposits
  const hasExistingBins = positionExists;

  // ROBUST FIX: If position exists, use getProgramAccounts to find ALL existing position bins
  // This ensures we don't miss ANY liquidity regardless of distance from current deposits
  let allExistingBinIndices: number[] = [];
  let binIndicesToCreate: number[] = []; // Will be populated after reference deposits are calculated

  if (hasExistingBins) {
    try {
      // Use getProgramAccounts with memcmp filter to find all position bins for this position
      // PositionBin account structure: discriminator(8) + position(32) + bin_index(4) + ...
      // SECURITY FIX: Use dataSlice to reduce response size and prevent DOS
      const existingPositionBins = await connection.getProgramAccounts(
        PROGRAM_ID,
        {
          commitment: "confirmed",
          dataSlice: { offset: 72, length: 8 }, // Only fetch bin_index field (u64 at offset 72)
          filters: [
            { dataSize: 136 }, // PositionBin: 8 (disc) + 32 (pos) + 32 (pool) + 8 (idx) + 16 (shares) + 16 (fee_base) + 16 (fee_quote) + 8 (ts) = 136
            { memcmp: { offset: 8, bytes: positionPda.toBase58() } }, // Position field at offset 8
          ],
        }
      );

      // SECURITY FIX: Limit number of position bins to prevent DOS attacks
      // Attacker could create position with 10,000+ bins and trigger massive RPC response
      const MAX_POSITION_BINS = 1000;
      if (existingPositionBins.length > MAX_POSITION_BINS) {
        throw new Error(
          `Position has too many bins (${existingPositionBins.length}). ` +
          `Maximum allowed: ${MAX_POSITION_BINS}. ` +
          `This pool may be in an invalid state. Contact support.`
        );
      }

      // Decode bin_index from each position bin account
      const newBinIndices = depositsRaw.map(d => d.bin_index);

      for (const { account } of existingPositionBins) {
        // PositionBin structure: discriminator(8) + position(32) + pool(32) + bin_index(8) + ...
        // CRITICAL: bin_index is stored as u64 (8 bytes), not i32 (4 bytes)
        // SECURITY FIX: dataSlice returns only bin_index field, so read from offset 0
        const binIndexU64 = account.data.readBigUInt64LE(0); // bin_index at offset 0 (due to dataSlice)

        // Convert from u64 canonical encoding to signed i32
        // Rust stores: (bin_index_i32 as i64) as u64
        // For negative values, this performs 64-bit sign extension
        // To reverse: extract lower 32 bits and interpret as signed i32
        const lower32 = Number(binIndexU64 & 0xFFFFFFFFn);
        const binIndexI32 = lower32 >= 0x80000000 ? lower32 - 0x100000000 : lower32;

        // Only include bins NOT in the new deposits (to avoid duplicates)
        if (!newBinIndices.includes(binIndexI32)) {
          allExistingBinIndices.push(binIndexI32);
        }
      }

      console.log(`[POOL_CREATION] Found ${allExistingBinIndices.length} existing bins NOT in current deposits: [${allExistingBinIndices.join(", ")}]`);
    } catch (error) {
      console.error(`[POOL_CREATION] Error fetching existing bins:`, error);
      // Continue anyway - worst case is we get accounting error and user retries
    }
  }

  // AUTO-REPAIR: Detect orphaned BinArray liquidity (BinArrays with tokens but no PositionBins)
  // This happens when init_position_bins fails but add_liquidity succeeds in a previous attempt
  if (positionExists && allExistingBinIndices.length === 0) {
    console.log("[POOL_CREATION] Position exists but has NO PositionBins. Scanning BinArrays for orphaned liquidity...");

    try {
      // SECURITY FIX: Fetch only required data to reduce response size
      const binArrayAccounts = await connection.getProgramAccounts(
        PROGRAM_ID,
        {
          commitment: "confirmed",
          // Fetch lower_bin_index (4 bytes at offset 5160) + bins array (64 bins * 80 bytes at offset 40)
          // Total: 40 (skip) + 5120 (bins) + 4 (lower_bin_index) = 5164 bytes
          filters: [
            { dataSize: 5176 }, // BinArray account size
            { memcmp: { offset: 8, bytes: poolPda.toBase58() } }, // pool field at offset 8
          ],
        }
      );

      // SECURITY FIX: Limit number of BinArrays to prevent DOS attacks
      const MAX_BIN_ARRAYS = 20; // Max ~1280 bins (64 bins per array)
      if (binArrayAccounts.length > MAX_BIN_ARRAYS) {
        throw new Error(
          `Pool has too many BinArrays (${binArrayAccounts.length}). ` +
          `Maximum allowed: ${MAX_BIN_ARRAYS}. ` +
          `This pool may be in an invalid state.`
        );
      }

      console.log(`[POOL_CREATION] Found ${binArrayAccounts.length} BinArray accounts`);

      const orphanedBins: number[] = [];

      for (const { pubkey, account } of binArrayAccounts) {
        const lowerBinIndex = account.data.readInt32LE(5160); // lower_bin_index at offset 5160

        // Check all 64 bins in this BinArray
        for (let i = 0; i < 64; i++) {
          const offset = 40 + i * 80; // bins start at offset 40, each CompactBin is 80 bytes

          // CompactBin: reserve_base(16) + reserve_quote(16) + total_shares(16) + ...
          // Read lower 8 bytes of u128 reserve_base and reserve_quote
          const reserveBase = account.data.readBigUInt64LE(offset);
          const reserveQuote = account.data.readBigUInt64LE(offset + 16);

          if (reserveBase > 0n || reserveQuote > 0n) {
            const binIndex = lowerBinIndex + i;
            orphanedBins.push(binIndex);
            console.log(`[POOL_CREATION] 🚨 Orphaned liquidity detected: Bin ${binIndex} (BinArray ${pubkey.toBase58().slice(0, 8)}...) has ${reserveBase} base, ${reserveQuote} quote`);
          }
        }
      }

      if (orphanedBins.length > 0) {
        console.warn(`[POOL_CREATION] ⚠️  CRITICAL: Found ${orphanedBins.length} bins with orphaned liquidity!`);
        console.warn(`[POOL_CREATION] This pool is in a BROKEN STATE (BinArrays have liquidity but no PositionBins)`);
        console.warn(`[POOL_CREATION] Adding orphaned bins to existing bins list for auto-repair...`);

        // Add orphaned bins to allExistingBinIndices so they get included in reference deposits
        // But filter out bins that are in the current deposits (to avoid duplicates)
        const newBinIndices = depositsRaw.map(d => d.bin_index);
        for (const binIndex of orphanedBins) {
          if (!newBinIndices.includes(binIndex)) {
            allExistingBinIndices.push(binIndex);
          }
        }

        console.log(`[POOL_CREATION] Updated existing bins list: ${allExistingBinIndices.length} bins total`);

        // CRITICAL: Also add orphaned bins to binIndicesToCreate so PositionBins get created
        // This auto-repairs the broken state by creating missing PositionBins
        console.log(`[POOL_CREATION] 🔧 AUTO-REPAIR: Adding ${orphanedBins.length} orphaned bins to PositionBin creation queue...`);

        for (const binIndex of orphanedBins) {
          // Only add if not already in the list
          if (!binIndicesToCreate.includes(binIndex)) {
            binIndicesToCreate.push(binIndex);
          }
        }

        // Sort for consistent ordering
        binIndicesToCreate.sort((a, b) => a - b);

        console.log(`[POOL_CREATION] 🔧 AUTO-REPAIR: Will create ${binIndicesToCreate.length} total PositionBins (${orphanedBins.length} for orphaned liquidity)`);
      } else {
        console.log("[POOL_CREATION] No orphaned liquidity found. Pool is clean.");
      }
    } catch (error) {
      console.error(`[POOL_CREATION] Error scanning BinArrays for orphaned liquidity:`, error);
      // Continue anyway - if this fails, we'll get accounting error and user can run repair script
    }
  }

  // CRITICAL FIX: Calculate reference deposits BEFORE position bin creation
  // This ensures ALL bins used in add_liquidity (including cross-tx references) have position bins created

  // Group existing bins by their BinArray
  const existingBinArrays = new Map<number, number[]>(); // lowerBinIndex -> binIndices[]

  for (const binIndex of allExistingBinIndices) {
    const lowerBinIndex = Math.floor(binIndex / 64) * 64;

    if (!existingBinArrays.has(lowerBinIndex)) {
      existingBinArrays.set(lowerBinIndex, []);
    }
    existingBinArrays.get(lowerBinIndex)!.push(binIndex);
  }

  // Identify which BinArrays are covered by new deposits
  const newBinArrays = new Set<number>();
  for (const deposit of depositsRaw) {
    const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64;
    newBinArrays.add(lowerBinIndex);
  }

  console.log(`[POOL_CREATION] New deposits cover ${newBinArrays.size} BinArrays: [${Array.from(newBinArrays).sort((a, b) => a - b).join(", ")}]`);

  // Add minimum reference deposits (1 lamport) for existing BinArrays NOT in new deposits
  // This forces those BinArrays into the reconciliation check without significant economic impact
  const referenceDeposits: Array<{ bin_index: number; base_in: bigint; quote_in: bigint }> = [];

  for (const [lowerBinIndex, bins] of existingBinArrays.entries()) {
    if (!newBinArrays.has(lowerBinIndex)) {
      // Validate bins array is not empty
      if (bins.length === 0) {
        continue;
      }

      // Pick first bin as representative (Rust program deduplicates BinArrays in HashMap)
      const representativeBin = bins[0];

      referenceDeposits.push({
        bin_index: representativeBin,
        base_in: 1n, // 1 lamport minimum (satisfies > 0 requirement)
        quote_in: 0n,
      });

      console.log(`[POOL_CREATION] Adding 1-lamport reference deposit for BinArray ${lowerBinIndex} (bin ${representativeBin})`);
    }
  }

  // Combine reference deposits + new deposits for position bin creation
  const allDepositsForPositionBinCreation = [...referenceDeposits, ...depositsRaw];
  console.log(`[POOL_CREATION] Total deposits for position bin creation: ${allDepositsForPositionBinCreation.length} (${referenceDeposits.length} reference + ${depositsRaw.length} new)`);

  // Collect unique bin indices and create init_position_bin instructions
  // CRITICAL: Position bins must be initialized before add_liquidity_v2 can use them
  const uniqueBinIndices = Array.from(new Set(allDepositsForPositionBinCreation.map(d => d.bin_index))).sort((a, b) => a - b);

  // Check which position bins already exist on-chain
  const positionBinPdas = uniqueBinIndices.map(binIndex => derivePositionBinPda(positionPda, binIndex)[0]);
  const positionBinInfos = await connection.getMultipleAccountsInfo(positionBinPdas, "confirmed");

  console.log(`[POOL_CREATION] Checking ${uniqueBinIndices.length} position bins for existence`);
  console.log(`[POOL_CREATION] Bins to check: ${uniqueBinIndices.join(", ")}`);

  // Log which bins exist vs don't exist
  uniqueBinIndices.forEach((binIndex, idx) => {
    const exists = positionBinInfos[idx] !== null;
    const pda = positionBinPdas[idx].toBase58();
    console.log(`[POOL_CREATION]   Bin ${binIndex}: ${exists ? "EXISTS" : "MISSING"} (PDA: ${pda.slice(0, 8)}...)`);
  });

  // Filter to only position bins that DON'T exist yet
  binIndicesToCreate = uniqueBinIndices.filter((_, idx) => !positionBinInfos[idx]);
  console.log(`[POOL_CREATION] Position bins to create: ${binIndicesToCreate.length} (${binIndicesToCreate.join(", ")})`);
  console.log(`[POOL_CREATION] Position bins already exist: ${uniqueBinIndices.length - binIndicesToCreate.length}`);

  // Verify all bins in allDepositsForPositionBinCreation will have position bins
  const missingBins = allDepositsForPositionBinCreation
    .map(d => d.bin_index)
    .filter(idx => !uniqueBinIndices.includes(idx));

  if (missingBins.length > 0) {
    console.error(`[POOL_CREATION] BUG: Some bins in deposits won't have position bins created: [${missingBins.join(", ")}]`);
    throw new Error(`Position bin creation bug: ${missingBins.length} bins missing`);
  }

  console.log(`[POOL_CREATION] ✅ All ${allDepositsForPositionBinCreation.length} deposit bins will have position bins created`);

  // Batch init_position_bin instructions to avoid transaction size limit
  // Each init_position_bin instruction is ~150 bytes
  // Safe batch size: ~5-6 instructions per transaction to stay under 1232 bytes
  const INIT_BIN_BATCH_SIZE = 5;
  const initPositionBinTransactions: Array<{ type: "init_position_bins"; instructions: SerializedInstruction[] }> = [];

  for (let i = 0; i < binIndicesToCreate.length; i += INIT_BIN_BATCH_SIZE) {
    const batchBinIndices = binIndicesToCreate.slice(i, i + INIT_BIN_BATCH_SIZE);
    const batchInstructions: SerializedInstruction[] = [];

    for (const binIndex of batchBinIndices) {
      // PDA derivation uses i32 (4 bytes) to match Rust program's PDA seeds
      const [positionBinPda] = derivePositionBinPda(positionPda, binIndex);

      // Instruction data uses u64 storage format
      const binIndexU64 = binIndexToU64(binIndex);
      const initPositionBinData = coder.instruction.encode("init_position_bin", {
        bin_index: new BN(binIndexU64.toString()),
      });

      const initPositionBinIx = serializeInstruction(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: adminPk, isSigner: true, isWritable: true },
            { pubkey: positionPda, isSigner: false, isWritable: true },
            { pubkey: positionBinPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: initPositionBinData,
        })
      );

      batchInstructions.push(initPositionBinIx);
    }

    // Add memo for this batch
    const positionBinMemoIx = createMemoInstruction(
      `Initializing Position Bins ${i / INIT_BIN_BATCH_SIZE + 1}/${Math.ceil(binIndicesToCreate.length / INIT_BIN_BATCH_SIZE)} | Bins: [${batchBinIndices.join(", ")}]`
    );

    // Add batch transaction
    initPositionBinTransactions.push({
      type: "init_position_bins",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        serializeInstruction(positionBinMemoIx),
        ...batchInstructions,
      ],
    });
  }

  // Use the pre-calculated allDepositsForPositionBinCreation (already includes reference deposits)
  const allDeposits = allDepositsForPositionBinCreation;

  // IMPORTANT: Split deposits into batches to avoid transaction size limit
  // Solana tx limit: 1232 bytes serialized
  // Calculation: ~300 bytes overhead + 100 bytes compute budget + (34 bytes × deposits)
  // With compute budget: 400 + (34 × deposits) must be < 1232
  // Max safe: (1232 - 400) / 34 = ~24, but using 4 for extra safety margin
  const BATCH_SIZE = 4;
  const addLiquidityTransactions: Array<{ type: "add_liquidity"; instructions: SerializedInstruction[] }> = [];

  // CRITICAL FIX: Identify ALL BinArrays that will be populated across ALL transactions
  // This is needed because transactions are built in a batch, and later transactions need to know
  // about BinArrays that will be populated by earlier transactions in the batch
  const allBinArraysInBatch = new Set<number>();
  for (const deposit of allDeposits) {
    const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64;
    allBinArraysInBatch.add(lowerBinIndex);
  }
  console.log(`[POOL_CREATION] All BinArrays in batch: [${Array.from(allBinArraysInBatch).sort((a, b) => a - b).join(", ")}]`);

  for (let i = 0; i < allDeposits.length; i += BATCH_SIZE) {
    const batchDeposits = allDeposits.slice(i, Math.min(i + BATCH_SIZE, allDeposits.length));

    // CRITICAL FIX: For THIS transaction, identify which BinArrays are in ITS deposits
    const thisTxBinArrays = new Set<number>();
    for (const deposit of batchDeposits) {
      const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64;
      thisTxBinArrays.add(lowerBinIndex);
    }

    // CRITICAL FIX: Add reference deposits (1 lamport) for ALL OTHER BinArrays in the batch
    // This ensures vault reconciliation can see liquidity from other transactions in the batch
    // SECURITY FIX: Limit reference deposits to prevent transaction size overflow (1232 byte limit)
    // Max safe: (1232 - 400 overhead) / (34 bytes per deposit) = ~24, but we use conservative limit
    const MAX_REFERENCE_DEPOSITS = 10;
    const crossTxReferenceDeposits: typeof batchDeposits = [];
    let refCount = 0;

    for (const binArrayLower of allBinArraysInBatch) {
      if (!thisTxBinArrays.has(binArrayLower) && refCount < MAX_REFERENCE_DEPOSITS) {
        // Find any bin in this BinArray from allDeposits
        const representativeBin = allDeposits.find(
          d => Math.floor(d.bin_index / 64) * 64 === binArrayLower
        );
        if (representativeBin) {
          crossTxReferenceDeposits.push({
            bin_index: representativeBin.bin_index,
            base_in: 1n,  // 1 lamport minimum
            quote_in: 0n,
          });
          refCount++;
          console.log(`[POOL_CREATION] TX ${Math.floor(i / BATCH_SIZE) + 1}: Adding cross-tx reference deposit for BinArray ${binArrayLower} (bin ${representativeBin.bin_index})`);
        }
      }
    }

    if (refCount === MAX_REFERENCE_DEPOSITS && allBinArraysInBatch.size - thisTxBinArrays.size > MAX_REFERENCE_DEPOSITS) {
      console.warn(`[POOL_CREATION] WARNING: Truncated reference deposits to ${MAX_REFERENCE_DEPOSITS} (had ${allBinArraysInBatch.size - thisTxBinArrays.size} BinArrays)`);
    }

    // Combine cross-tx reference deposits + this transaction's deposits
    const finalBatchDeposits = [...crossTxReferenceDeposits, ...batchDeposits];

    // Convert to BN for Borsh encoding
    // STRICT: Validate each deposit before BN construction to prevent crashes
    const deposits: Array<{ bin_index: BN; base_in: BN; quote_in: BN; min_shares_out: BN }> = [];

    for (const d of finalBatchDeposits) {
      try {
        // STRICT: Pre-validate bin_index before BN construction
        if (typeof d.bin_index !== 'number' || !Number.isFinite(d.bin_index)) {
          throw new Error(`Invalid bin_index type: ${typeof d.bin_index} (value: ${d.bin_index})`);
        }

        if (d.bin_index < -2147483648 || d.bin_index > 2147483647) {
          throw new Error(`bin_index ${d.bin_index} out of i32 range (-2147483648 to 2147483647)`);
        }

        // STRICT: Pre-validate amounts before BN construction
        if (typeof d.base_in !== 'bigint' || typeof d.quote_in !== 'bigint') {
          throw new Error(`Invalid amount types: base_in=${typeof d.base_in}, quote_in=${typeof d.quote_in}`);
        }

        if (d.base_in < 0n || d.quote_in < 0n) {
          throw new Error(`Negative amounts not allowed: base_in=${d.base_in}, quote_in=${d.quote_in}`);
        }

        // Construct BNs with error handling
        // CRITICAL: Convert negative bin indices to u64
        deposits.push({
          bin_index: new BN(binIndexToU64(d.bin_index).toString()),
          base_in: new BN(d.base_in.toString()),
          quote_in: new BN(d.quote_in.toString()),
          min_shares_out: new BN(0),
        });
      } catch (error) {
        // CRITICAL: Skip invalid deposits instead of crashing
        throw new Error(
          `Invalid deposit data at bin ${d.bin_index}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Skip empty batches (all deposits were invalid)
    if (deposits.length === 0) {
      continue;
    }

    const addLiquidityData = coder.instruction.encode("add_liquidity_v2", {
      deposits,
    });

    // Build remaining accounts in the pattern: [bin_array_0, position_bin_0, bin_array_1, position_bin_1, ...]
    // The program expects deposits.len() * 2 accounts
    const remainingAccounts = [];

    for (const deposit of finalBatchDeposits) {
      // Derive bin_array PDA
      const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64; // 64 bins per array (BIN_ARRAY_SIZE)
      const [binArrayPda] = deriveBinArrayPda(poolPda, lowerBinIndex);

      // Derive position_bin PDA using i32 (4 bytes) to match Rust program
      const [positionBinPda] = derivePositionBinPda(positionPda, deposit.bin_index);

      // Add in the required pattern: bin_array, position_bin
      remainingAccounts.push(
        { pubkey: binArrayPda, isSigner: false, isWritable: true },
        { pubkey: positionBinPda, isSigner: false, isWritable: true }
      );
    }

    const addLiquidityIx = serializeInstruction(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: poolPda, isSigner: false, isWritable: true },
          { pubkey: adminPk, isSigner: true, isWritable: false },
          { pubkey: ownerBaseAta, isSigner: false, isWritable: true },
          { pubkey: ownerQuoteAta, isSigner: false, isWritable: true },
          { pubkey: baseVaultPda, isSigner: false, isWritable: true },
          { pubkey: quoteVaultPda, isSigner: false, isWritable: true },
          { pubkey: positionPda, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          // Remaining accounts: [bin_array_0, position_bin_0, bin_array_1, position_bin_1, ...]
          ...remainingAccounts,
        ],
        data: addLiquidityData,
      })
    );

    // Calculate total tokens in this batch for memo display
    const batchBaseTotal = batchDeposits.reduce((sum, d) => sum + d.base_in, 0n);
    const batchQuoteTotal = batchDeposits.reduce((sum, d) => sum + d.quote_in, 0n);

    // Format amounts for display (divide by decimals)
    const baseDisplay = (Number(batchBaseTotal) / 10 ** baseDecimals).toFixed(4);
    const quoteDisplay = (Number(batchQuoteTotal) / 10 ** quoteDecimals).toFixed(4);

    // Create descriptive memo showing what's happening
    const batchNumber = i / BATCH_SIZE + 1;
    const totalBatches = Math.ceil(allDeposits.length / BATCH_SIZE);
    const addLiquidityMemoIx = createMemoInstruction(
      `Adding Liquidity ${batchNumber}/${totalBatches} | Base: ${baseDisplay} | Quote: ${quoteDisplay} | ${batchDeposits.length} bins`
    );

    // Build transaction with compute budget and add_liquidity instruction
    addLiquidityTransactions.push({
      type: "add_liquidity",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        serializeInstruction(addLiquidityMemoIx),
        addLiquidityIx,
      ],
    });
  }

  // Build transactions array (OPTIMIZATION: conditionally include init_position)
  const allTransactions: typeof baseResult.transactions = [
    ...baseResult.transactions,
    ...createBinArrayTransactions,
  ];

  // Only add init_position if it doesn't exist (OPTIMIZATION: saves 1 tx)
  if (initPositionIx && initPositionMemoIx) {
    allTransactions.push({
      type: "init_position",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        initPositionMemoIx,
        initPositionIx,
      ],
    });
  }

  allTransactions.push(...initPositionBinTransactions);
  allTransactions.push(...addLiquidityTransactions);

  // Log final transaction summary
  const txTypeCounts: Record<string, number> = {};
  for (const tx of allTransactions) {
    txTypeCounts[tx.type] = (txTypeCounts[tx.type] || 0) + 1;
  }
  console.log(`[POOL_CREATION] Final transaction summary:`);
  console.log(`  Total transactions: ${allTransactions.length}`);
  for (const [type, count] of Object.entries(txTypeCounts)) {
    console.log(`  - ${type}: ${count}`);
  }

  return {
    ...baseResult,
    transactions: allTransactions,
    positionAddress: positionPda.toBase58(),
  };
}

/**
 * Convert Q64.64 price to active bin index
 *
 * CRITICAL: Uses high-precision arithmetic to avoid bin selection errors
 * Formula: activeBin = floor(log(price) / log(1 + binStep/10000))
 *
 * @param priceQ64_64 - Price in Q64.64 fixed-point format (price * 2^64)
 * @param binStepBps - Bin step in basis points (e.g., 1 = 0.01%, 100 = 1%)
 * @returns Active bin index (signed i32)
 */
function priceToActiveBin(priceQ64_64: bigint, binStepBps: number): number {
  // Validate inputs
  if (priceQ64_64 <= 0n) {
    throw new Error(`Invalid price: ${priceQ64_64} (must be > 0)`);
  }
  if (binStepBps <= 0 || binStepBps > 10000) {
    throw new Error(`Invalid binStepBps: ${binStepBps} (must be 1-10000)`);
  }

  // Convert Q64.64 to float carefully
  // For prices > 2^53, we need to scale down first to avoid overflow
  const Q64 = 1n << 64n;

  // Check if priceQ64_64 will overflow Number (> 2^53)
  const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
  let priceFloat: number;

  if (priceQ64_64 > MAX_SAFE_BIGINT) {
    // Scale down: divide both numerator and denominator by same factor
    // priceFloat = (priceQ64_64 / 2^32) / (2^64 / 2^32) = priceQ64_64 / 2^32 / 2^32
    const scale = 1n << 32n;
    priceFloat = Number(priceQ64_64 / scale) / Number(Q64 / scale);
  } else {
    // Safe to convert directly
    priceFloat = Number(priceQ64_64) / Number(Q64);
  }

  // Validate converted price
  if (!Number.isFinite(priceFloat) || priceFloat <= 0) {
    throw new Error(`Price conversion resulted in invalid float: ${priceFloat}`);
  }

  // Calculate bin index with logarithm
  const binStep = binStepBps / 10000;
  const logBinStep = Math.log(1 + binStep);

  // bin = floor(log(price) / log(1 + binStep))
  const binFloat = Math.log(priceFloat) / logBinStep;

  // Validate result is finite
  if (!Number.isFinite(binFloat)) {
    throw new Error(
      `Bin calculation resulted in ${binFloat} for price ${priceFloat} and binStep ${binStep}`
    );
  }

  const activeBin = Math.floor(binFloat);

  // Validate bin is within i32 range (-2^31 to 2^31-1)
  if (activeBin < -2147483648 || activeBin > 2147483647) {
    throw new Error(
      `Calculated bin ${activeBin} exceeds i32 range. ` +
      `Price ${priceFloat} with binStep ${binStepBps}bps produces invalid bin.`
    );
  }

  // Verify calculation by checking adjacent bins (catch floating-point errors)
  // The active bin should satisfy: (1+binStep)^bin <= price < (1+binStep)^(bin+1)
  const binPrice = Math.pow(1 + binStep, activeBin);
  const nextBinPrice = Math.pow(1 + binStep, activeBin + 1);

  // Adjust if floating-point error caused off-by-one
  if (binPrice > priceFloat && activeBin > -2147483648) {
    // Current bin too high, use previous bin
    return activeBin - 1;
  } else if (nextBinPrice <= priceFloat && activeBin < 2147483647) {
    // Current bin too low, use next bin
    return activeBin + 1;
  }

  return activeBin;
}

/**
 * Builds pool creation with BATCHED liquidity addition (optimized lazy account creation)
 *
 * OPTIMIZATION: Reduces ~150 transactions to 2-7 transactions using lazy account creation.
 *
 * Returns 2 transactions (or 2-7 if >32 bins):
 * 1. init_pool: Creates pool state, LP mint, registry, and all 6 token vaults
 * 2. add_liquidity_batch: Lazily creates BinArrays, Position, PositionBins, and adds liquidity atomically
 *
 * # Key Differences from buildPoolCreationWithLiquidityTransactions:
 * - NO separate create_bin_arrays transactions (lazy creation during add_liquidity_batch)
 * - NO separate init_position transaction (init_if_needed pattern)
 * - NO separate init_position_bins transactions (lazy creation during add_liquidity_batch)
 * - Single add_liquidity_batch instruction handles ALL account creation + liquidity deposit
 *
 * # Benefits:
 * - 98% fewer transactions (150 → 2-7)
 * - Atomic operation (all-or-nothing)
 * - Much better UX (less signing)
 * - Lower gas costs
 * - Competitive transaction efficiency
 *
 * # Limits:
 * - Max 32 bins per add_liquidity_batch transaction (transaction size limit)
 * - For >32 bins, automatically splits into multiple batches (2-7 transactions total)
 *
 * @param params - Pool creation parameters with liquidity distribution
 * @param connection - Solana RPC connection
 * @returns Pool creation result with init_pool + add_liquidity_batch transactions
 */
export async function buildPoolCreationBatchTransactions(
  params: PoolCreationWithLiquidityParams,
  connection: Connection
): Promise<PoolCreationResult> {
  console.log("=".repeat(80));
  console.log("[POOL_CREATION_BATCH] *** BATCHED LIQUIDITY FLOW ***");
  console.log(`[POOL_CREATION_BATCH] Admin: ${params.admin}`);
  console.log(`[POOL_CREATION_BATCH] Base: ${params.baseMint}`);
  console.log(`[POOL_CREATION_BATCH] Quote: ${params.quoteMint}`);
  console.log(`[POOL_CREATION_BATCH] Bin step: ${params.binStepBps} bps`);
  console.log("=".repeat(80));

  const {
    admin,
    baseMint,
    quoteMint,
    binStepBps,
    initialPrice,
    baseDecimals,
    quoteDecimals,
    baseAmount,
    quoteAmount,
    binsLeft,
    binsRight,
    priorityLevel = "turbo",
  } = params;

  // 1. Build init_pool transaction (same as regular flow)
  const baseResult = await buildPoolCreationTransactions(params);

  const adminPk = new PublicKey(admin);
  const baseMintPk = new PublicKey(baseMint);
  const quoteMintPk = new PublicKey(quoteMint);
  const poolPda = new PublicKey(baseResult.poolAddress);

  const coder = new BorshCoder(ORBIT_IDL);
  const priorityFeeMicroLamports = getPriorityFeeMicroLamports(priorityLevel);
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  // Calculate bin range
  const priceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);
  const activeBin = priceToActiveBin(priceQ64_64, binStepBps);

  // SECURITY FIX: Validate inputs BEFORE arithmetic to prevent integer overflow
  if (binsLeft < 0 || binsRight < 0) {
    throw new Error(`Bin counts cannot be negative: binsLeft=${binsLeft}, binsRight=${binsRight}`);
  }

  // SECURITY FIX: Check arithmetic won't overflow i32 bounds BEFORE performing it
  const MIN_I32 = -2147483648;
  const MAX_I32 = 2147483647;

  if (activeBin - binsLeft < MIN_I32) {
    throw new Error(
      `Lower bin index would underflow i32: activeBin=${activeBin}, binsLeft=${binsLeft}. ` +
      `Result would be < ${MIN_I32}. Reduce binsLeft.`
    );
  }
  if (activeBin + binsRight > MAX_I32) {
    throw new Error(
      `Upper bin index would overflow i32: activeBin=${activeBin}, binsRight=${binsRight}. ` +
      `Result would be > ${MAX_I32}. Reduce binsRight.`
    );
  }

  const lowerBinIndex = activeBin - binsLeft;
  const upperBinIndex = activeBin + binsRight;

  // Validate bin range is within i32 bounds (redundant but safe)
  if (lowerBinIndex < MIN_I32 || upperBinIndex > MAX_I32) {
    throw new Error(
      `Bin range [${lowerBinIndex}, ${upperBinIndex}] exceeds i32 bounds. ` +
      `Reduce binsLeft (${binsLeft}) or binsRight (${binsRight}).`
    );
  }

  const totalBins = upperBinIndex - lowerBinIndex + 1;
  const MAX_BINS_PER_POOL = 1000;
  if (totalBins > MAX_BINS_PER_POOL) {
    throw new Error(
      `Bin range too large: ${totalBins} bins. Maximum: ${MAX_BINS_PER_POOL}. ` +
      `Reduce binsLeft or binsRight.`
    );
  }

  console.log(`[POOL_CREATION_BATCH] Bin range: ${lowerBinIndex} to ${upperBinIndex} (${totalBins} bins)`);
  console.log(`[POOL_CREATION_BATCH] Active bin: ${activeBin}`);

  // Convert amounts to raw (atoms)
  // SECURITY FIX: Validate amounts are finite before BigInt conversion to prevent RangeError crash
  // parseFloat("1e308") * 10^6 = Infinity → BigInt(Infinity) throws RangeError
  const baseFloat = parseFloat(baseAmount);
  const quoteFloat = parseFloat(quoteAmount);

  if (!Number.isFinite(baseFloat) || baseFloat < 0) {
    throw new Error(`baseAmount must be a positive finite number, got ${baseAmount}`);
  }
  if (!Number.isFinite(quoteFloat) || quoteFloat < 0) {
    throw new Error(`quoteAmount must be a positive finite number, got ${quoteAmount}`);
  }

  const scaledBase = baseFloat * 10 ** baseDecimals;
  const scaledQuote = quoteFloat * 10 ** quoteDecimals;

  if (!Number.isFinite(scaledBase)) {
    throw new Error(`baseAmount ${baseAmount} too large for ${baseDecimals} decimals`);
  }
  if (!Number.isFinite(scaledQuote)) {
    throw new Error(`quoteAmount ${quoteAmount} too large for ${quoteDecimals} decimals`);
  }

  // SECURITY FIX: Validate amounts don't exceed u64::MAX to prevent on-chain overflow
  const MAX_U64 = BigInt("18446744073709551615");
  const baseAmountRaw = BigInt(Math.floor(scaledBase));
  const quoteAmountRaw = BigInt(Math.floor(scaledQuote));

  if (baseAmountRaw > MAX_U64) {
    throw new Error(`baseAmount exceeds u64 maximum: ${baseAmountRaw}`);
  }
  if (quoteAmountRaw > MAX_U64) {
    throw new Error(`quoteAmount exceeds u64 maximum: ${quoteAmountRaw}`);
  }

  // Build deposits array - distribute evenly across bins
  const depositsRaw: Array<{ bin_index: number; base_in: bigint; quote_in: bigint; min_shares_out: bigint }> = [];

  // SECURITY FIX: Active bin is EXCLUDED from deposits (program forbids ActiveBinDepositForbidden)
  // In DLMM: bins < activeBin get QUOTE (for BaseToQuote swaps), bins > activeBin get BASE (for QuoteToBase swaps)
  const binsWithQuote = activeBin - lowerBinIndex;   // Bins below active (exclusive) - get QUOTE
  const binsWithBase = upperBinIndex - activeBin;  // Bins above active (exclusive) - get BASE

  // Calculate per-bin shares and remainders
  const baseShare = binsWithBase > 0 ? baseAmountRaw / BigInt(binsWithBase) : 0n;
  const quoteShare = binsWithQuote > 0 ? quoteAmountRaw / BigInt(binsWithQuote) : 0n;
  const baseRemainder = binsWithBase > 0 ? baseAmountRaw % BigInt(binsWithBase) : 0n;
  const quoteRemainder = binsWithQuote > 0 ? quoteAmountRaw % BigInt(binsWithQuote) : 0n;

  console.log(`[POOL_CREATION_BATCH] Liquidity distribution:`);
  console.log(`  Total bins: ${totalBins}`);
  console.log(`  Active bin: ${activeBin} (EXCLUDED from deposits)`);
  console.log(`  Bins with quote: ${binsWithQuote} (< active)`);
  console.log(`  Bins with base: ${binsWithBase} (> active)`);
  console.log(`  Base: ${baseAmountRaw} atoms = ${baseShare}/bin + ${baseRemainder} remainder`);
  console.log(`  Quote: ${quoteAmountRaw} atoms = ${quoteShare}/bin + ${quoteRemainder} remainder`);

  // Distribute liquidity
  let baseCounter = 0;
  let quoteCounter = 0;

  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    // CRITICAL FIX: Skip active bin entirely
    // Rust program forbids deposits into active bin (ActiveBinDepositForbidden)
    // Active bin should only have MM liquidity, not LP liquidity
    if (binIndex === activeBin) {
      console.log(`[POOL_CREATION_BATCH] Skipping active bin ${activeBin} (deposits forbidden by program)`);
      continue;
    }

    let binBaseAmount = 0n;
    let binQuoteAmount = 0n;

    // Distribute QUOTE to bins < activeBin (for BaseToQuote swaps - selling base for quote)
    if (binIndex < activeBin && quoteShare > 0n) {
      binQuoteAmount = quoteShare;
      if (quoteCounter < Number(quoteRemainder)) {
        binQuoteAmount += 1n;
      }
      quoteCounter++;
    }

    // Distribute BASE to bins > activeBin (for QuoteToBase swaps - buying base with quote)
    if (binIndex > activeBin && baseShare > 0n) {
      binBaseAmount = baseShare;
      if (baseCounter < Number(baseRemainder)) {
        binBaseAmount += 1n;
      }
      baseCounter++;
    }

    if (binBaseAmount > 0n || binQuoteAmount > 0n) {
      depositsRaw.push({
        bin_index: binIndex,
        base_in: binBaseAmount,
        quote_in: binQuoteAmount,
        min_shares_out: 0n, // No slippage protection for pool creation (bootstrap)
      });
    }
  }

  // Verify distribution
  const totalBaseDistributed = depositsRaw.reduce((sum, d) => sum + d.base_in, 0n);
  const totalQuoteDistributed = depositsRaw.reduce((sum, d) => sum + d.quote_in, 0n);

  if (totalBaseDistributed !== baseAmountRaw || totalQuoteDistributed !== quoteAmountRaw) {
    throw new Error(
      `Distribution mismatch! Base: ${totalBaseDistributed}/${baseAmountRaw}, Quote: ${totalQuoteDistributed}/${quoteAmountRaw}`
    );
  }

  console.log(`[POOL_CREATION_BATCH] ✓ Distribution verified: ${depositsRaw.length} deposits`);

  // Derive accounts
  const positionNonce = BigInt(0);
  const [positionPda] = derivePositionPda(poolPda, adminPk, positionNonce);
  const [baseVaultPda] = deriveVaultPda(poolPda, "base");
  const [quoteVaultPda] = deriveVaultPda(poolPda, "quote");

  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  const [ownerBaseAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), baseMintPk.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [ownerQuoteAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), quoteMintPk.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Build add_liquidity_batch transactions
  // CRITICAL: Solana transaction size limit is 1232 bytes
  // Actual size calculation per transaction:
  // - Base instruction accounts: 10 accounts × 34 bytes = 340 bytes
  // - Compute budget + Memo: ~150 bytes
  // - Instruction data: N deposits × 32 bytes
  // - Remaining accounts: N bins × 2 accounts × 34 bytes = N × 68 bytes
  // - Total per bin: 32 + 68 = 100 bytes
  // - Safe budget: 1232 - 490 (base) = 742 bytes
  // - Max bins: 742 / 100 = 7.4 → 7 bins (conservative)
  //
  // Using 8 bins for balance between transaction count and safety:
  // 8 bins = 490 + (8 × 100) = 1290 bytes (needs verification but close to limit)
  // Reducing to 7 bins to ensure safety margin: 490 + (7 × 100) = 1190 bytes ✓
  const MAX_BINS_PER_BATCH = 7;
  const batchedDeposits: Array<typeof depositsRaw> = [];

  for (let i = 0; i < depositsRaw.length; i += MAX_BINS_PER_BATCH) {
    batchedDeposits.push(depositsRaw.slice(i, i + MAX_BINS_PER_BATCH));
  }

  console.log(`[POOL_CREATION_BATCH] Splitting into ${batchedDeposits.length} batches (${MAX_BINS_PER_BATCH} bins max per batch)`);

  const addLiquidityBatchTransactions: Array<{ type: "add_liquidity"; instructions: SerializedInstruction[] }> = [];

  for (let batchIdx = 0; batchIdx < batchedDeposits.length; batchIdx++) {
    const batchDeposits = batchedDeposits[batchIdx]!;

    // Build remaining accounts: [binArray0, positionBin0, binArray1, positionBin1, ...]
    const remainingAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [];

    for (const deposit of batchDeposits) {
      const binIndexI32 = deposit.bin_index;
      // SECURITY FIX: Use Math.floor (rounds towards -∞) for correct bin array boundaries
      // Rust uses BinArray::lower_bin_index_from() which implements floor division
      // For negative bins: -1328 → floor(-1328/64) = -21 → -21*64 = -1344 (correct)
      // Math.trunc would give: -1328 → trunc(-1328/64) = -20 → -20*64 = -1280 (WRONG!)
      const lowerBinIdx = Math.floor(binIndexI32 / 64) * 64;

      const [binArrayPda] = deriveBinArrayPda(poolPda, lowerBinIdx);
      // SECURITY FIX: Pass i32 directly for PDA derivation (not u64)
      const [positionBinPda] = derivePositionBinPda(positionPda, binIndexI32);

      remainingAccounts.push({ pubkey: binArrayPda, isSigner: false, isWritable: true });
      remainingAccounts.push({ pubkey: positionBinPda, isSigner: false, isWritable: true });
    }

    // Encode deposits for IDL
    const depositsEncoded = batchDeposits.map(d => ({
      bin_index: new BN(binIndexToU64(d.bin_index).toString()),
      base_in: new BN(d.base_in.toString()),
      quote_in: new BN(d.quote_in.toString()),
      min_shares_out: new BN(d.min_shares_out.toString()),
    }));

    // Build add_liquidity_batch instruction
    const data = coder.instruction.encode("add_liquidity_batch", {
      nonce: new BN(positionNonce.toString()),
      deposits: depositsEncoded,
    });

    const addLiquidityBatchIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: positionPda, isSigner: false, isWritable: true },
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: ownerBaseAta, isSigner: false, isWritable: true },
        { pubkey: ownerQuoteAta, isSigner: false, isWritable: true },
        { pubkey: baseVaultPda, isSigner: false, isWritable: true },
        { pubkey: quoteVaultPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ],
      data,
    });

    const memoIx = createMemoInstruction(
      `Adding Liquidity (Batched) ${batchIdx + 1}/${batchedDeposits.length} | Bins: ${batchDeposits.length}`
    );

    addLiquidityBatchTransactions.push({
      type: "add_liquidity",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        serializeInstruction(memoIx),
        serializeInstruction(addLiquidityBatchIx),
      ],
    });
  }

  console.log(`[POOL_CREATION_BATCH] ✓ Built ${1 + addLiquidityBatchTransactions.length} transactions total`);
  console.log(`  1. init_pool (creates pool + 6 vaults)`);
  console.log(`  2-${1 + addLiquidityBatchTransactions.length}. add_liquidity_batch (lazy creates everything + deposits liquidity)`);

  // Build verify_pool_accounting transaction
  console.log(`[POOL_CREATION_BATCH] Building verification transaction...`);

  // Collect ALL unique BinArrays that were created/used
  const uniqueBinArrays = new Set<string>();
  for (const deposit of depositsRaw) {
    const binIndexI32 = deposit.bin_index;
    const arrayLower = Math.floor(binIndexI32 / 64) * 64;
    const binArrayBytes = Buffer.alloc(4);
    binArrayBytes.writeInt32LE(arrayLower, 0);
    const [binArrayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bin_array"), poolPda.toBuffer(), binArrayBytes],
      PROGRAM_ID
    );
    uniqueBinArrays.add(binArrayPda.toBase58());
  }

  const binArrayAccounts = Array.from(uniqueBinArrays).map(addr => ({
    pubkey: new PublicKey(addr),
    isSigner: false,
    isWritable: false,
  }));

  console.log(`[POOL_CREATION_BATCH] Verification will check ${binArrayAccounts.length} unique BinArray(s)`);

  // Build verify_pool_accounting instruction
  const verifyData = coder.instruction.encode("verify_pool_accounting", {});

  const verifyPoolAccountingIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: poolPda, isSigner: false, isWritable: false },         // Read-only verification
      { pubkey: baseVaultPda, isSigner: false, isWritable: false },    // Read-only verification
      { pubkey: quoteVaultPda, isSigner: false, isWritable: false },   // Read-only verification
      { pubkey: adminPk, isSigner: true, isWritable: false },
      ...binArrayAccounts,
    ],
    data: verifyData,
  });

  const verifyMemoIx = createMemoInstruction("Verifying Pool Accounting");

  const verifyTransaction = {
    type: "verify_accounting" as const,
    instructions: [
      serializeInstruction(computeUnitLimitIx),
      serializeInstruction(computeUnitPriceIx),
      serializeInstruction(verifyMemoIx),
      serializeInstruction(verifyPoolAccountingIx),
    ],
  };

  console.log(`[POOL_CREATION_BATCH] ✓ Built ${2 + addLiquidityBatchTransactions.length} transactions total`);
  console.log(`  1. init_pool (creates pool + 6 vaults)`);
  console.log(`  2-${1 + addLiquidityBatchTransactions.length}. add_liquidity_batch (lazy creates everything + deposits liquidity)`);
  console.log(`  ${2 + addLiquidityBatchTransactions.length}. verify_pool_accounting (validates vault reconciliation)`);

  return {
    transactions: [
      ...baseResult.transactions,
      ...addLiquidityBatchTransactions,
      verifyTransaction,
    ],
    poolAddress: baseResult.poolAddress,
    lpMintPublicKey: baseResult.lpMintPublicKey,
    registryAddress: baseResult.registryAddress,
    positionAddress: positionPda.toBase58(),
  };
}

/**
 * Derives position bin PDA
 *
 * CRITICAL: Rust program uses i32 (4 bytes) for bin_index seed in PDA derivation.
 *
 * Seeds: ["position_bin", position, bin_index (i32 4 bytes, little-endian)]
 *
 * Reference: /backend_dlmm/programs/orbit_finance/src/instructions/add_liquidity_batch.rs:448
 * The Rust code uses: bin_index.to_le_bytes() where bin_index is i32, producing 4 bytes.
 *
 * Note: While PositionBin state stores bin_index as u64, the PDA derivation itself
 * uses i32 encoding. These are separate concerns.
 */
function derivePositionBinPda(position: PublicKey, binIndexI32: number): [PublicKey, number] {
  // Use i32 (4 bytes) to match Rust program's PDA derivation
  // Rust: let bin_index_le = bin_index.to_le_bytes(); (where bin_index is i32)
  const binIndexBuffer = Buffer.alloc(4); // 4 bytes for i32
  binIndexBuffer.writeInt32LE(binIndexI32, 0);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_bin"),
      position.toBuffer(),
      binIndexBuffer, // 4-byte seed matches Rust PDA derivation
    ],
    PROGRAM_ID
  );
}

const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");
