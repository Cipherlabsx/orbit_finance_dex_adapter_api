/**
 * Pool Creation Service
 *
 * Builds unsigned transactions for creating new liquidity pools.
 * Follows Orbit Finance DLMM program IDL for init_pool and init_pool_vaults.
 *
 * Security:
 * - Validates canonical mint ordering (base < quote)
 * - Validates fee configuration (splits must sum to 100,000 microbps)
 * - Validates bin step against allowed values
 * - Only returns unsigned transactions (frontend signs)
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BorshCoder } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ORBIT_IDL } from "../idl/coder.js";
import { PROGRAM_ID } from "../solana.js";

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
  binStepBps: number;            // Bin step in basis points (1, 5, 10, 25, 50, 100)
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
    type: "init_pool" | "init_pool_vaults" | "create_bin_arrays" | "init_position" | "add_liquidity";
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
const ALLOWED_BIN_STEPS = [1, 5, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500];

/**
 * Validates that mints are in canonical order (base < quote lexicographically)
 */
function validateCanonicalOrder(base: PublicKey, quote: PublicKey): void {
  const baseBytes = base.toBytes();
  const quoteBytes = quote.toBytes();

  for (let i = 0; i < 32; i++) {
    if (baseBytes[i]! < quoteBytes[i]!) return; // base < quote, OK
    if (baseBytes[i]! > quoteBytes[i]!) {
      throw new Error(
        `Mints must be in canonical order (base < quote). ` +
        `Swap baseMint and quoteMint. Base: ${base.toBase58()}, Quote: ${quote.toBase58()}`
      );
    }
  }

  // All bytes equal - this is invalid (same mint used twice)
  throw new Error("baseMint and quoteMint cannot be the same");
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
function derivePoolPda(baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    PROGRAM_ID
  );
}

/**
 * Derives registry PDA (prevents duplicate pools)
 * Seeds: ["registry", baseMint, quoteMint]
 */
function deriveRegistryPda(baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("registry"),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
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
 * Builds pool creation transactions
 *
 * Returns 2 transactions:
 * 1. init_pool: Creates pool state, LP mint, and registry
 * 2. init_pool_vaults: Creates token vaults for pool
 *
 * SECURITY:
 * - Validates all inputs before building transactions
 * - Returns unsigned transactions (frontend must sign)
 * - LP mint keypair generated CLIENT-SIDE (frontend only sends public key)
 * - Frontend must sign tx1 with both admin + lpMint keypairs
 * - Frontend must sign tx2 with admin keypair only
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

  // Validate inputs
  validateCanonicalOrder(baseMintPk, quoteMintPk);
  validateBinStep(binStepBps);
  validateFeeConfig(feeConfig);

  if (accountingMode < 0 || accountingMode > 1) {
    throw new Error(`accountingMode must be 0 or 1, got ${accountingMode}`);
  }

  // Calculate Q64.64 price
  const initialPriceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);

  // Derive PDAs
  const [poolPda] = derivePoolPda(baseMintPk, quoteMintPk);
  const [registryPda] = deriveRegistryPda(baseMintPk, quoteMintPk);

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

  const initPoolIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminPk, isSigner: true, isWritable: true },
      { pubkey: creatorPk, isSigner: false, isWritable: false },
      { pubkey: baseMintPk, isSigner: false, isWritable: false },
      { pubkey: quoteMintPk, isSigner: false, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: lpMintPk, isSigner: true, isWritable: true },
      { pubkey: registryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initPoolData,
  });

  // Build init_pool_vaults instruction
  const [baseVaultPda] = deriveVaultPda(poolPda, "base");
  const [quoteVaultPda] = deriveVaultPda(poolPda, "quote");
  const [creatorFeeVaultPda] = deriveVaultPda(poolPda, "creator_fee");
  const [holdersFeeVaultPda] = deriveVaultPda(poolPda, "holders_fee");
  const [nftFeeVaultPda] = deriveVaultPda(poolPda, "nft_fee");

  const initVaultsData = coder.instruction.encode("init_pool_vaults", {});

  const initVaultsIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminPk, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: baseMintPk, isSigner: false, isWritable: false },
      { pubkey: quoteMintPk, isSigner: false, isWritable: false },
      { pubkey: baseVaultPda, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda, isSigner: false, isWritable: true },
      { pubkey: creatorFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: holdersFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: nftFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: initVaultsData,
  });

  // Add compute budget instructions
  const priorityFeeMicroLamports = getPriorityFeeMicroLamports(priorityLevel);
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  return {
    transactions: [
      {
        type: "init_pool",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          serializeInstruction(initPoolIx),
        ],
      },
      {
        type: "init_pool_vaults",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          serializeInstruction(initVaultsIx),
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
 * Returns 4 transaction groups:
 * 1. init_pool: Creates pool state, LP mint, and registry
 * 2. init_pool_vaults: Creates token vaults for pool
 * 3. create_bin_arrays: Creates bin arrays for liquidity distribution
 * 4. init_position: Creates position account
 * 5. add_liquidity: Deposits tokens into bins
 */
export async function buildPoolCreationWithLiquidityTransactions(
  params: PoolCreationWithLiquidityParams
): Promise<PoolCreationResult> {
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
  const priceQ64_64 = calculatePriceQ64_64(initialPrice, baseDecimals, quoteDecimals);
  const activeBin = priceToActiveBin(priceQ64_64, binStepBps);

  // Calculate bin range based on strategy
  const lowerBinIndex = activeBin - binsLeft;
  const upperBinIndex = activeBin + binsRight;

  // Determine which bin arrays we need to create
  const binArraysNeeded = new Set<number>();
  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    const arrayIndex = Math.floor(binIndex / 128); // Each bin array holds 128 bins
    binArraysNeeded.add(arrayIndex * 128); // Lower bin index of the array
  }

  // Build create_bin_array instructions
  const createBinArrayInstructions = Array.from(binArraysNeeded).map((lowerBinIdx) => {
    const [binArrayPda] = deriveBinArrayPda(poolPda, lowerBinIdx);

    const data = coder.instruction.encode("create_bin_array", {
      lower_bin_index: lowerBinIdx,
    });

    return serializeInstruction(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: poolPda, isSigner: false, isWritable: false },
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: binArrayPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      })
    );
  });

  // Build init_position instruction
  const positionNonce = BigInt(0); // First position for this user in this pool
  const [positionPda] = derivePositionPda(poolPda, adminPk, positionNonce);

  const initPositionData = coder.instruction.encode("init_position", {
    nonce: new BN(positionNonce.toString()),
  });

  const initPositionIx = serializeInstruction(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: poolPda, isSigner: false, isWritable: false },
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: positionPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initPositionData,
    })
  );

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

  // Simple uniform distribution strategy
  for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
    const baseShare = baseAmountRaw / BigInt(totalBins);
    const quoteShare = quoteAmountRaw / BigInt(totalBins);

    // Distribute liquidity based on bin position relative to active bin
    // - Bins below active: only base tokens
    // - Bins above active: only quote tokens
    // - Active bin: both tokens
    if (binIndex < activeBin) {
      // Below active: only base
      if (baseShare > 0n) {
        depositsRaw.push({ bin_index: binIndex, base_in: baseShare, quote_in: 0n });
      }
    } else if (binIndex > activeBin) {
      // Above active: only quote
      if (quoteShare > 0n) {
        depositsRaw.push({ bin_index: binIndex, base_in: 0n, quote_in: quoteShare });
      }
    } else {
      // Active bin: both tokens
      if (baseShare > 0n || quoteShare > 0n) {
        depositsRaw.push({
          bin_index: binIndex,
          base_in: baseShare > 0n ? baseShare : 0n,
          quote_in: quoteShare > 0n ? quoteShare : 0n
        });
      }
    }
  }

  // Derive owner's token accounts (ATAs)
  const [ownerBaseAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), baseMintPk.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") // Associated Token Program
  );

  const [ownerQuoteAta] = PublicKey.findProgramAddressSync(
    [adminPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), quoteMintPk.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );

  // IMPORTANT: Split deposits into batches to avoid transaction size limit
  // Solana tx limit: 1232 bytes serialized
  // Calculation: ~300 bytes overhead + (34 bytes × deposits)
  // Max theoretical: ~27 deposits, using 25 for safety margin
  const BATCH_SIZE = 25;
  const addLiquidityTransactions: Array<{ type: "add_liquidity"; instructions: SerializedInstruction[] }> = [];

  for (let i = 0; i < depositsRaw.length; i += BATCH_SIZE) {
    const batchDeposits = depositsRaw.slice(i, i + BATCH_SIZE);

    // Convert to BN for Borsh encoding
    const deposits = batchDeposits.map(d => ({
      bin_index: new BN(d.bin_index),
      base_in: new BN(d.base_in.toString()),
      quote_in: new BN(d.quote_in.toString()),
      min_shares_out: new BN(0), // No slippage protection for initial liquidity
    }));

    const addLiquidityData = coder.instruction.encode("add_liquidity_v2", {
      deposits,
    });

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
        ],
        data: addLiquidityData,
      })
    );

    addLiquidityTransactions.push({
      type: "add_liquidity",
      instructions: [
        serializeInstruction(computeUnitLimitIx),
        serializeInstruction(computeUnitPriceIx),
        addLiquidityIx,
      ],
    });
  }

  return {
    ...baseResult,
    transactions: [
      ...baseResult.transactions,
      {
        type: "create_bin_arrays",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          ...createBinArrayInstructions,
        ],
      },
      {
        type: "init_position",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          initPositionIx,
        ],
      },
      ...addLiquidityTransactions,
    ],
    positionAddress: positionPda.toBase58(),
  };
}

/**
 * Convert Q64.64 price to active bin index
 */
function priceToActiveBin(priceQ64_64: bigint, binStepBps: number): number {
  // Active bin = floor(log(price) / log(1 + binStep/10000))
  // Simplified approximation for now
  const priceFloat = Number(priceQ64_64) / Number(1n << 64n);
  const binStep = binStepBps / 10000;
  return Math.floor(Math.log(priceFloat) / Math.log(1 + binStep));
}
