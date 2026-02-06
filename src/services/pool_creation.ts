/**
 * Pool Creation Service
 *
 * Builds unsigned transactions for creating new liquidity pools.
 * Follows Orbit Finance DLMM program IDL for init_pool (merged with vault creation).
 *
 * OPTIMIZATION: init_pool and init_pool_vaults merged into single instruction (saves 1 tx).
 *
 * Security:
 * - Allows any mint ordering (no canonical requirement - like Meteora)
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
  binStepBps: number;            // Bin step in basis points (22 Meteora-standard values: 1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 50, 75, 80, 100, 125, 150, 160, 200, 250, 300, 400)
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
    type: "init_pool" | "create_bin_arrays" | "init_position" | "init_position_bins" | "add_liquidity";
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
 * Convert signed bin index (i32) to canonical u64 encoding for PDA derivation
 * Handles negative bin indices using two's complement
 *
 * @param binIndexSigned - Signed bin index (i32 range: -2147483648 to 2147483647)
 * @returns Canonical u64 encoding
 */
function binIndexToU64(binIndexSigned: number): bigint {
  if (binIndexSigned >= 0) {
    return BigInt(binIndexSigned);
  } else {
    // Two's complement for negative values (i32 -> u64)
    return BigInt(0x100000000) + BigInt(binIndexSigned);
  }
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
  if (price <= 0) {
    throw new Error(`initialPrice must be positive, got ${price}`);
  }

  // Convert price to atoms (smallest units)
  const quoteAtoms = BigInt(Math.floor(price * 10 ** quoteDecimals));
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
 * CRITICAL: Pool address includes bin_step_bps to allow multiple pools per token pair.
 * Each bin step represents a different liquidity distribution strategy:
 * - Lower bin steps (1-10 bps) = tighter price ranges, better for stable pairs
 * - Higher bin steps (50-400 bps) = wider price ranges, better for volatile pairs
 *
 * This enables the core DLMM design: traders choose pool granularity based on their needs.
 *
 * @param baseMint - Base token mint address
 * @param quoteMint - Quote token mint address
 * @param binStepBps - Bin step in basis points (determines price granularity)
 * @returns Tuple of [pool PDA, bump seed]
 */
function derivePoolPda(baseMint: PublicKey, quoteMint: PublicKey, binStepBps: number): [PublicKey, number] {
  const binStepBuffer = Buffer.alloc(2);
  binStepBuffer.writeUInt16LE(binStepBps);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
      binStepBuffer,
    ],
    PROGRAM_ID
  );
}

/**
 * Derives registry PDA (prevents duplicate pools)
 * Seeds: ["registry", baseMint, quoteMint, binStepBps]
 * CRITICAL: Each pool (unique base + quote + bin step) has its own registry
 */
function deriveRegistryPda(baseMint: PublicKey, quoteMint: PublicKey, binStepBps: number): [PublicKey, number] {
  const binStepBuf = Buffer.alloc(2);
  binStepBuf.writeUInt16LE(binStepBps, 0);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("registry"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
      binStepBuf,
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

  if (accountingMode < 0 || accountingMode > 1) {
    throw new Error(`accountingMode must be 0 or 1, got ${accountingMode}`);
  }

  // Calculate Q64.64 price
  const initialPriceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);

  // Derive PDAs
  // CRITICAL: Pool PDA includes bin_step_bps to enable multiple pools per token pair
  const [poolPda] = derivePoolPda(baseMintPk, quoteMintPk, binStepBps);
  // CRITICAL: Registry PDA also includes bin_step_bps (one registry per pool)
  const [registryPda] = deriveRegistryPda(baseMintPk, quoteMintPk, binStepBps);

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
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  // Calculate active bin from initial price
  // DLMM specification constants
  const BIN_ARRAY_SIZE = 64; // Each BinArray holds exactly 64 bins

  const priceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);
  const activeBin = priceToActiveBin(priceQ64_64, binStepBps);

  // Calculate bin range based on strategy
  // NOTE: This creates (binsLeft + 1 + binsRight) total bins, including active bin
  const lowerBinIndex = activeBin - binsLeft;
  const upperBinIndex = activeBin + binsRight;

  // Validate bin range is within i32 bounds
  if (lowerBinIndex < -2147483648 || upperBinIndex > 2147483647) {
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
    const arrayIndex = Math.floor(binIndex / BIN_ARRAY_SIZE);
    binArraysNeeded.add(arrayIndex * BIN_ARRAY_SIZE); // Store lower bin index of the array
  }

  // Check which bin arrays already exist on-chain (skip creating existing ones)
  const binArrayIndices = Array.from(binArraysNeeded).sort((a, b) => a - b);
  const binArrayPdas = binArrayIndices.map(lowerBinIdx => deriveBinArrayPda(poolPda, lowerBinIdx)[0]);
  const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayPdas, "confirmed");

  // Filter to only bin arrays that DON'T exist yet (saves 1-3 transactions)
  const binArrayIndicesToCreate = binArrayIndices.filter((_, idx) => !binArrayInfos[idx]);

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
  const baseAmountRaw = BigInt(Math.floor(parseFloat(baseAmount) * 10 ** baseDecimals));
  const quoteAmountRaw = BigInt(Math.floor(parseFloat(quoteAmount) * 10 ** quoteDecimals));

  // Build deposits array - distribute evenly across bins
  // IDL expects: { bin_index: u64, base_in: u64, quote_in: u64, min_shares_out: u64 }
  const depositsRaw: Array<{ bin_index: number; base_in: bigint; quote_in: bigint }> = [];
  const totalBins = upperBinIndex - lowerBinIndex + 1;

  // CRITICAL FIX: Count bins that actually use each token
  // In DLMM: bins <= activeBin get base, bins >= activeBin get quote, activeBin gets both
  const binsWithBase = activeBin - lowerBinIndex + 1;   // Bins at or below active (inclusive)
  const binsWithQuote = upperBinIndex - activeBin + 1;  // Bins at or above active (inclusive)

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
  console.log(`  Active bin: ${activeBin}`);
  console.log(`  Bins with base: ${binsWithBase} (≤ active)`);
  console.log(`  Bins with quote: ${binsWithQuote} (≥ active)`);
  console.log(`  Base: ${baseAmountRaw} atoms = ${baseShare}/bin + ${baseRemainder} remainder`);
  console.log(`  Quote: ${quoteAmountRaw} atoms = ${quoteShare}/bin + ${quoteRemainder} remainder`);

  // Distribute liquidity with remainder distribution to avoid truncation loss
  let baseCounter = 0;  // Counter for bins receiving base tokens
  let quoteCounter = 0; // Counter for bins receiving quote tokens

  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    let binBaseAmount = 0n;
    let binQuoteAmount = 0n;

    // Distribute base tokens to bins <= activeBin
    if (binIndex <= activeBin && baseShare > 0n) {
      binBaseAmount = baseShare;
      // Distribute remainder: first N bins get +1 atom each (N = remainder)
      if (baseCounter < Number(baseRemainder)) {
        binBaseAmount += 1n;
      }
      baseCounter++;
    }

    // Distribute quote tokens to bins >= activeBin
    if (binIndex >= activeBin && quoteShare > 0n) {
      binQuoteAmount = quoteShare;
      // Distribute remainder: first N bins get +1 atom each (N = remainder)
      if (quoteCounter < Number(quoteRemainder)) {
        binQuoteAmount += 1n;
      }
      quoteCounter++;
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

  // Collect unique bin indices and create init_position_bin instructions
  // CRITICAL: Position bins must be initialized before add_liquidity_v2 can use them
  const uniqueBinIndices = Array.from(new Set(depositsRaw.map(d => d.bin_index))).sort((a, b) => a - b);

  const POSITION_BIN_SEED = Buffer.from("position_bin");

  // Check which position bins already exist on-chain
  const positionBinPdas = uniqueBinIndices.map(binIndex => {
    const binIndexBuffer = Buffer.alloc(8);
    binIndexBuffer.writeBigUInt64LE(binIndexToU64(binIndex));
    return PublicKey.findProgramAddressSync(
      [POSITION_BIN_SEED, positionPda.toBuffer(), binIndexBuffer],
      PROGRAM_ID
    )[0];
  });
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
  let binIndicesToCreate = uniqueBinIndices.filter((_, idx) => !positionBinInfos[idx]);
  console.log(`[POOL_CREATION] Position bins to create: ${binIndicesToCreate.length} (${binIndicesToCreate.join(", ")})`);
  console.log(`[POOL_CREATION] Position bins already exist: ${uniqueBinIndices.length - binIndicesToCreate.length}`);

  // CRITICAL FIX: Check if position exists (not just current batch bins)
  // If position exists, previous add_liquidity txs succeeded and we need to fetch ALL existing bins
  // to include them in reconciliation via reference deposits
  const hasExistingBins = positionExists;

  // ROBUST FIX: If position exists, use getProgramAccounts to find ALL existing position bins
  // This ensures we don't miss ANY liquidity regardless of distance from current deposits
  let allExistingBinIndices: number[] = [];

  if (hasExistingBins) {
    try {
      // Use getProgramAccounts with memcmp filter to find all position bins for this position
      // PositionBin account structure: discriminator(8) + position(32) + bin_index(4) + ...
      const existingPositionBins = await connection.getProgramAccounts(
        PROGRAM_ID,
        {
          commitment: "confirmed",
          filters: [
            { dataSize: 144 }, // PositionBin account size (corrected from 88)
            { memcmp: { offset: 8, bytes: positionPda.toBase58() } }, // Position field at offset 8
          ],
        }
      );

      // Decode bin_index from each position bin account
      const newBinIndices = depositsRaw.map(d => d.bin_index);

      for (const { account } of existingPositionBins) {
        // PositionBin structure: discriminator(8) + position(32) + bin_index(8) + ...
        // CRITICAL: bin_index is stored as u64 (8 bytes), not i32 (4 bytes)
        const binIndexU64 = account.data.readBigUInt64LE(72); // bin_index at offset 72 (8 + 32 + 32)

        // Convert from unsigned u64 to signed i32 (bin_index is logically i32)
        const binIndexI32 = binIndexU64 < 0x80000000n
          ? Number(binIndexU64)
          : Number(binIndexU64) - 0x100000000;

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
      const binArrayAccounts = await connection.getProgramAccounts(
        PROGRAM_ID,
        {
          commitment: "confirmed",
          filters: [
            { dataSize: 5176 }, // BinArray account size
            { memcmp: { offset: 8, bytes: poolPda.toBase58() } }, // pool field at offset 8
          ],
        }
      );

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

  // Batch init_position_bin instructions to avoid transaction size limit
  // Each init_position_bin instruction is ~150 bytes
  // Safe batch size: ~5-6 instructions per transaction to stay under 1232 bytes
  const INIT_BIN_BATCH_SIZE = 5;
  const initPositionBinTransactions: Array<{ type: "init_position_bins"; instructions: SerializedInstruction[] }> = [];

  for (let i = 0; i < binIndicesToCreate.length; i += INIT_BIN_BATCH_SIZE) {
    const batchBinIndices = binIndicesToCreate.slice(i, i + INIT_BIN_BATCH_SIZE);
    const batchInstructions: SerializedInstruction[] = [];

    for (const binIndex of batchBinIndices) {
      // Derive position_bin PDA
      const binIndexBuffer = Buffer.alloc(8);
      binIndexBuffer.writeBigUInt64LE(binIndexToU64(binIndex));
      const [positionBinPda] = PublicKey.findProgramAddressSync(
        [POSITION_BIN_SEED, positionPda.toBuffer(), binIndexBuffer],
        PROGRAM_ID
      );

      // Encode init_position_bin instruction
      const initPositionBinData = coder.instruction.encode("init_position_bin", {
        bin_index: new BN(binIndex),
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

  // Combine reference deposits + new deposits
  const allDeposits = [...referenceDeposits, ...depositsRaw];

  console.log(`[POOL_CREATION] Total deposits: ${allDeposits.length} (${referenceDeposits.length} reference + ${depositsRaw.length} new)`);
  console.log(`[POOL_CREATION] New deposits cover ${newBinArrays.size} BinArrays: [${Array.from(newBinArrays).sort((a, b) => a - b).join(", ")}]`);

  // IMPORTANT: Split deposits into batches to avoid transaction size limit
  // Solana tx limit: 1232 bytes serialized
  // Calculation: ~300 bytes overhead + 100 bytes compute budget + (34 bytes × deposits)
  // With compute budget: 400 + (34 × deposits) must be < 1232
  // Max safe: (1232 - 400) / 34 = ~24, but using 4 for extra safety margin
  const BATCH_SIZE = 4;
  const addLiquidityTransactions: Array<{ type: "add_liquidity"; instructions: SerializedInstruction[] }> = [];

  for (let i = 0; i < allDeposits.length; i += BATCH_SIZE) {
    const batchDeposits = allDeposits.slice(i, Math.min(i + BATCH_SIZE, allDeposits.length));

    // Convert to BN for Borsh encoding
    // STRICT: Validate each deposit before BN construction to prevent crashes
    const deposits: Array<{ bin_index: BN; base_in: BN; quote_in: BN; min_shares_out: BN }> = [];

    for (const d of batchDeposits) {
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
        deposits.push({
          bin_index: new BN(d.bin_index),
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
    const POSITION_BIN_SEED = Buffer.from("position_bin");
    const remainingAccounts = [];

    for (const deposit of batchDeposits) {
      // Derive bin_array PDA
      const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64; // 64 bins per array (BIN_ARRAY_SIZE)
      const [binArrayPda] = deriveBinArrayPda(poolPda, lowerBinIndex);

      // Derive position_bin PDA
      // Seeds: ["position_bin", position_key, bin_index (u64 LE)]
      const binIndexBuffer = Buffer.alloc(8);
      binIndexBuffer.writeBigUInt64LE(binIndexToU64(deposit.bin_index));
      const [positionBinPda] = PublicKey.findProgramAddressSync(
        [POSITION_BIN_SEED, positionPda.toBuffer(), binIndexBuffer],
        PROGRAM_ID
      );

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
