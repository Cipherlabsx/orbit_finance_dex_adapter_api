/**
 * lp_fees.ts
 *
 * Computes accrued (unclaimed) LP trading fees per position for a given owner,
 * using the same Q128 fee-growth delta math as the on-chain claim_lp_fees instruction.
 *
 * Math (mirrors calculate_position_fees in fee_growth.rs):
 *   fee = (bin.fee_growth_q128 - position_bin.fee_growth_q128) * shares / Q128
 */

import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { connection, PROGRAM_ID } from "../solana.js";
import type { OrbitFinance } from "../idl/orbit_finance.js";
import { ORBIT_IDL } from "../idl/coder.js";

const Q128 = 2n ** 128n;

// Seeds (must match seeds.rs)
const POSITION_SEED     = Buffer.from("position");
const BIN_SEED          = Buffer.from("bin");
const POSITION_BIN_SEED = Buffer.from("position_bin");

function readOnlyWallet(identity: PublicKey): Wallet {
  return {
    publicKey: identity,
    signTransaction: async () => { throw new Error("read-only"); },
    signAllTransactions: async () => { throw new Error("read-only"); },
  } as unknown as Wallet;
}

function getProgramReadOnly(identity: PublicKey): Program<OrbitFinance> {
  const provider = new AnchorProvider(connection, readOnlyWallet(identity), {
    commitment: "confirmed",
  });
  return new Program<OrbitFinance>(ORBIT_IDL as any, provider);
}

function toBigInt(v: unknown, fallback = 0n): bigint {
  if (v == null) return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : fallback;
  if (typeof v === "string") { try { return BigInt(v); } catch { return fallback; } }
  if (typeof (v as any).toString === "function") { try { return BigInt((v as any).toString()); } catch { return fallback; } }
  return fallback;
}

export type BinFees = {
  binIndex: string;
  liquidityBinAddress: string;
  positionBinAddress: string;
  feeBaseAtoms: string;
  feeQuoteAtoms: string;
};

export type PositionFees = {
  pool: string;
  position: string;
  nonce: string;
  bins: BinFees[];
  totalFeeBaseAtoms: string;
  totalFeeQuoteAtoms: string;
};

/**
 * Derives the LiquidityBin PDA for a given pool + bin index.
 * Seeds: [BIN_SEED, pool, bin_index_le_u64]
 */
function deriveLiquidityBin(poolPk: PublicKey, binIndex: bigint): PublicKey {
  const idxBuf = Buffer.alloc(8);
  idxBuf.writeBigUInt64LE(binIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [BIN_SEED, poolPk.toBuffer(), idxBuf],
    PROGRAM_ID
  );
  return pda;
}

/**
 * Derives the PositionBin PDA.
 * Seeds: [POSITION_BIN_SEED, position, bin_index_le_u64]
 */
function derivePositionBin(positionPk: PublicKey, binIndex: bigint): PublicKey {
  const idxBuf = Buffer.alloc(8);
  idxBuf.writeBigUInt64LE(binIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [POSITION_BIN_SEED, positionPk.toBuffer(), idxBuf],
    PROGRAM_ID
  );
  return pda;
}

/**
 * Returns accrued LP fees for all positions owned by the given wallet.
 */
export async function calculatePositionFees(ownerPublicKey: string): Promise<PositionFees[]> {
  const ownerPk = new PublicKey(ownerPublicKey);
  const program = getProgramReadOnly(ownerPk);

  // Fetch all Position accounts owned by this wallet.
  // Position.owner is at offset: discriminator(8) + pool(32) = 40
  const POSITION_OWNER_OFFSET = 8 + 32; // 40
  const positionAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 8 + 32 + 32 + 8 + 8 + 8 + 1 + 7 }, // Position struct size
      {
        memcmp: {
          offset: POSITION_OWNER_OFFSET,
          bytes: ownerPk.toBase58(),
        },
      },
    ],
    commitment: "confirmed",
  });

  if (positionAccounts.length === 0) return [];

  const results: PositionFees[] = [];

  for (const { pubkey: positionPk, account: _positionAcct } of positionAccounts) {
    let positionData: any;
    try {
      positionData = await program.account.position.fetch(positionPk);
    } catch {
      continue; // skip if decode fails (stale filter)
    }

    const poolPk: PublicKey = positionData.pool;
    const nonce: bigint = toBigInt(positionData.nonce);

    // Fetch all PositionBin accounts for this position.
    // PositionBin.position is at offset: discriminator(8) = 8
    const POSITION_BIN_POSITION_OFFSET = 8;
    const positionBinAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: 8 + 32 + 32 + 8 + 16 + 16 + 16 + 8 + 1 + 7 }, // PositionBin struct size
        {
          memcmp: {
            offset: POSITION_BIN_POSITION_OFFSET,
            bytes: positionPk.toBase58(),
          },
        },
      ],
      commitment: "confirmed",
    });

    const bins: BinFees[] = [];
    let totalFeeBase = 0n;
    let totalFeeQuote = 0n;

    // Batch-fetch all LiquidityBin accounts in one getMultipleAccounts call
    const positionBinDataList: Array<{ pk: PublicKey; data: any }> = [];
    for (const { pubkey: pbPk } of positionBinAccounts) {
      try {
        const pbData = await program.account.positionBin.fetch(pbPk);
        positionBinDataList.push({ pk: pbPk, data: pbData });
      } catch {
        continue;
      }
    }

    if (positionBinDataList.length === 0) {
      continue;
    }

    // Derive and fetch LiquidityBin accounts
    const liquidityBinPks = positionBinDataList.map((pb) =>
      deriveLiquidityBin(poolPk, toBigInt(pb.data.binIndex))
    );

    const liquidityBinInfos = await connection.getMultipleAccountsInfo(liquidityBinPks, "confirmed");

    for (let i = 0; i < positionBinDataList.length; i++) {
      const pb = positionBinDataList[i];
      const lbInfo = liquidityBinInfos[i];
      if (!lbInfo) continue;

      let lbData: any;
      try {
        lbData = program.coder.accounts.decode("liquidityBin", lbInfo.data);
      } catch {
        continue;
      }

      const binIndex = toBigInt(pb.data.binIndex);
      const shares = toBigInt(pb.data.shares);
      if (shares === 0n) continue;

      // fee = (bin.fee_growth_q128 - pb.fee_growth_q128) * shares / Q128
      const binGrowthBase  = toBigInt(lbData.feeGrowthBaseQ128);
      const binGrowthQuote = toBigInt(lbData.feeGrowthQuoteQ128);
      const pbGrowthBase   = toBigInt(pb.data.feeGrowthBaseQ128);
      const pbGrowthQuote  = toBigInt(pb.data.feeGrowthQuoteQ128);

      const deltaBase  = binGrowthBase  > pbGrowthBase  ? binGrowthBase  - pbGrowthBase  : 0n;
      const deltaQuote = binGrowthQuote > pbGrowthQuote ? binGrowthQuote - pbGrowthQuote : 0n;

      const feeBase  = (deltaBase  * shares) / Q128;
      const feeQuote = (deltaQuote * shares) / Q128;

      if (feeBase === 0n && feeQuote === 0n) continue;

      totalFeeBase  += feeBase;
      totalFeeQuote += feeQuote;

      bins.push({
        binIndex:            binIndex.toString(),
        liquidityBinAddress: liquidityBinPks[i].toBase58(),
        positionBinAddress:  pb.pk.toBase58(),
        feeBaseAtoms:        feeBase.toString(),
        feeQuoteAtoms:       feeQuote.toString(),
      });
    }

    results.push({
      pool:               poolPk.toBase58(),
      position:           positionPk.toBase58(),
      nonce:              nonce.toString(),
      bins,
      totalFeeBaseAtoms:  totalFeeBase.toString(),
      totalFeeQuoteAtoms: totalFeeQuote.toString(),
    });
  }

  return results;
}
