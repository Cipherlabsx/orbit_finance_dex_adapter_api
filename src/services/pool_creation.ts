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
    type: "init_pool" | "init_pool_vaults" | "create_bin_arrays" | "init_position" | "init_position_bins" | "add_liquidity";
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
  const [protocolFeeVaultPda] = deriveVaultPda(poolPda, "protocol_fee");

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
      { pubkey: protocolFeeVaultPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initVaultsData,
  });

  // Add compute budget instructions
  const priorityFeeMicroLamports = getPriorityFeeMicroLamports(priorityLevel);
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  // Create descriptive memos for wallet display
  const initPoolMemoIx = createMemoInstruction(
    `Creating DLMM Pool | ${baseMintPk.toBase58().slice(0, 6)}.../${quoteMintPk.toBase58().slice(0, 6)}... | Bin Step: ${binStepBps}bps | Price: ${initialPrice}`
  );
  const initVaultsMemoIx = createMemoInstruction(
    `Initializing Pool Vaults | Setting up token storage for liquidity`
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
      {
        type: "init_pool_vaults",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          serializeInstruction(initVaultsMemoIx),
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
  params: PoolCreationWithLiquidityParams,
  connection: Connection
): Promise<PoolCreationResult> {
  console.log(`[POOL_CREATION] ==================== START ====================`);
  console.log(`[POOL_CREATION] Building pool creation with liquidity`);
  console.log(`[POOL_CREATION] Connection provided: ${!!connection}`);

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
    const arrayIndex = Math.floor(binIndex / 64); // Each bin array holds 64 bins (BIN_ARRAY_SIZE)
    binArraysNeeded.add(arrayIndex * 64); // Lower bin index of the array
  }

  // Check which bin arrays already exist on-chain
  const binArrayIndices = Array.from(binArraysNeeded).sort((a, b) => a - b);
  const binArrayPdas = binArrayIndices.map(lowerBinIdx => deriveBinArrayPda(poolPda, lowerBinIdx)[0]);
  const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayPdas, "confirmed");

  // Filter to only bin arrays that DON'T exist yet
  const binArrayIndicesToCreate = binArrayIndices.filter((_, idx) => !binArrayInfos[idx]);
  console.log(`[BIN_ARRAYS] Need ${binArrayIndices.length} bin arrays, ${binArrayIndicesToCreate.length} missing, ${binArrayIndices.length - binArrayIndicesToCreate.length} already exist`);

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
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: positionPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initPositionData,
    })
  );

  const initPositionMemoIx = createMemoInstruction(
    `Creating Liquidity Position | Owner: ${adminPk.toBase58().slice(0, 8)}...`
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
  console.log(`[INIT_POSITION_BIN] Need ${uniqueBinIndices.length} position_bin accounts for bins: ${uniqueBinIndices.join(", ")}`);

  const POSITION_BIN_SEED = Buffer.from("position_bin");

  // Check which position bins already exist on-chain
  const positionBinPdas = uniqueBinIndices.map(binIndex => {
    const binIndexBuffer = Buffer.alloc(8);
    binIndexBuffer.writeBigUInt64LE(BigInt(binIndex));
    return PublicKey.findProgramAddressSync(
      [POSITION_BIN_SEED, positionPda.toBuffer(), binIndexBuffer],
      PROGRAM_ID
    )[0];
  });
  const positionBinInfos = await connection.getMultipleAccountsInfo(positionBinPdas, "confirmed");

  // Filter to only position bins that DON'T exist yet
  const binIndicesToCreate = uniqueBinIndices.filter((_, idx) => !positionBinInfos[idx]);
  console.log(`[POSITION_BINS] ${binIndicesToCreate.length} missing, ${uniqueBinIndices.length - binIndicesToCreate.length} already exist`);

  // CRITICAL FIX: Detect if ANY position bins already exist (indicates this is a resume/add more liquidity scenario)
  const hasExistingBins = positionBinInfos.some(info => info !== null);
  const existingBinCount = positionBinInfos.filter(info => info !== null).length;
  console.log(`[ACCOUNTING_FIX] Position has existing bins: ${hasExistingBins}, count in sampled range: ${existingBinCount}/${uniqueBinIndices.length}`);

  // ROBUST FIX: If existing liquidity detected, scan WIDER RANGE to find ALL existing BinArrays
  // This ensures we don't miss liquidity that's far from current deposits
  let allExistingBinIndices: number[] = [];

  if (hasExistingBins) {
    console.log(`[ACCOUNTING_FIX] Scanning wider range to find all existing position bins...`);

    // Calculate scan range: ±10 BinArrays (±640 bins) from new deposits
    // This covers most realistic scenarios while staying performant
    const newBinIndices = depositsRaw.map(d => d.bin_index);
    const minNewBin = Math.min(...newBinIndices);
    const maxNewBin = Math.max(...newBinIndices);
    const SCAN_RANGE_BINS = 640; // 10 BinArrays × 64 bins

    const scanMinBin = minNewBin - SCAN_RANGE_BINS;
    const scanMaxBin = maxNewBin + SCAN_RANGE_BINS;

    // Generate all possible bin indices in scan range (sample every 8 bins for performance)
    const binsToCheck: number[] = [];
    for (let bin = scanMinBin; bin <= scanMaxBin; bin += 8) {
      binsToCheck.push(bin);
    }

    console.log(`[ACCOUNTING_FIX] Checking ${binsToCheck.length} bins in range [${scanMinBin}, ${scanMaxBin}]`);

    // Derive PDAs for all bins in scan range
    const scanPdas = binsToCheck.map(binIndex => {
      const binIndexBuffer = Buffer.alloc(8);
      binIndexBuffer.writeBigUInt64LE(BigInt(binIndex));
      return PublicKey.findProgramAddressSync(
        [POSITION_BIN_SEED, positionPda.toBuffer(), binIndexBuffer],
        PROGRAM_ID
      )[0];
    });

    // Fetch in batches of 100 to avoid RPC limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < scanPdas.length; i += BATCH_SIZE) {
      const batch = scanPdas.slice(i, Math.min(i + BATCH_SIZE, scanPdas.length));
      const batchResults = await connection.getMultipleAccountsInfo(batch, "confirmed");

      // Record which bins exist
      batchResults.forEach((info, idx) => {
        if (info !== null) {
          const binIndex = binsToCheck[i + idx];
          if (!newBinIndices.includes(binIndex)) {
            allExistingBinIndices.push(binIndex);
          }
        }
      });
    }

    console.log(`[ACCOUNTING_FIX] Found ${allExistingBinIndices.length} existing bins outside new deposit range`);
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
      binIndexBuffer.writeBigUInt64LE(BigInt(binIndex));
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

  if (existingBinArrays.size > 0) {
    console.log(`[POOL_CREATION] Found ${existingBinArrays.size} existing BinArrays:`);
    for (const [lower, bins] of existingBinArrays.entries()) {
      console.log(`  BinArray ${lower}: ${bins.length} bins (${bins[0]}-${bins[bins.length - 1]})`);
    }
  }

  // Identify which BinArrays are covered by new deposits
  const newBinArrays = new Set<number>();
  for (const deposit of depositsRaw) {
    const lowerBinIndex = Math.floor(deposit.bin_index / 64) * 64;
    newBinArrays.add(lowerBinIndex);
  }

  console.log(`[POOL_CREATION] New deposits cover ${newBinArrays.size} BinArrays: [${Array.from(newBinArrays).join(", ")}]`);

  // Add minimum reference deposits (1 lamport) for existing BinArrays NOT in new deposits
  // This forces those BinArrays into the reconciliation check without significant economic impact
  const referenceDeposits: Array<{ bin_index: number; base_in: bigint; quote_in: bigint }> = [];

  for (const [lowerBinIndex, bins] of existingBinArrays.entries()) {
    if (!newBinArrays.has(lowerBinIndex)) {
      // Validate bins array is not empty
      if (bins.length === 0) {
        console.warn(`[POOL_CREATION] BinArray ${lowerBinIndex} has no bins, skipping reference deposit`);
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

  // IMPORTANT: Split deposits into batches to avoid transaction size limit
  // Solana tx limit: 1232 bytes serialized
  // Calculation: ~300 bytes overhead + 100 bytes compute budget + (34 bytes × deposits)
  // With compute budget: 400 + (34 × deposits) must be < 1232
  // Max safe: (1232 - 400) / 34 = ~24, but using 8 for extra safety margin
  // Reduced from 15 to 8 to account for ATA creation instructions being prepended
  const BATCH_SIZE = 8;
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
        // CRITICAL: Log and skip invalid deposits instead of crashing
        console.error(
          `[POOL_CREATION] CRITICAL: Failed to create BN for deposit`,
          { bin_index: d.bin_index, base_in: d.base_in, quote_in: d.quote_in, error }
        );
        throw new Error(
          `Invalid deposit data at bin ${d.bin_index}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Skip empty batches (all deposits were invalid)
    if (deposits.length === 0) {
      console.warn(`[POOL_CREATION] Batch ${i / BATCH_SIZE + 1} has no valid deposits, skipping`);
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
      binIndexBuffer.writeBigUInt64LE(BigInt(deposit.bin_index));
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

  return {
    ...baseResult,
    transactions: [
      ...baseResult.transactions,
      ...createBinArrayTransactions,
      {
        type: "init_position",
        instructions: [
          serializeInstruction(computeUnitLimitIx),
          serializeInstruction(computeUnitPriceIx),
          serializeInstruction(initPositionMemoIx),
          initPositionIx,
        ],
      },
      ...initPositionBinTransactions,
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
