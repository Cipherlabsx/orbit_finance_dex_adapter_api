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
 * Input parameters for pool creation
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
 * Result of pool creation transaction building
 *
 * SECURITY: Only returns public keys, never secret keys
 * The frontend generates the LP mint keypair locally and signs transactions
 */
export type PoolCreationResult = {
  transactions: Array<{
    type: "init_pool" | "init_pool_vaults";
    instructions: SerializedInstruction[];
  }>;
  poolAddress: string;
  lpMintPublicKey: string; // SECURITY: Only public key returned
  registryAddress: string;
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
const ALLOWED_BIN_STEPS = [1, 5, 10, 25, 50, 100];

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

  const initPoolData = coder.instruction.encode("initPool", {
    baseMint: baseMintPk,
    quoteMint: quoteMintPk,
    binStepBps,
    initialPriceQ6464: initialPriceQ64_64,
    feeConfig: {
      baseFeeBps: feeConfig.baseFeeBps,
      creatorCutBps: feeConfig.creatorCutBps,
      splitHoldersMicrobps: feeConfig.splitHoldersMicrobps,
      splitNftMicrobps: feeConfig.splitNftMicrobps,
      splitCreatorExtraMicrobps: feeConfig.splitCreatorExtraMicrobps,
    },
    accountingMode,
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

  const initVaultsData = coder.instruction.encode("initPoolVaults", {});

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
  const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
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
