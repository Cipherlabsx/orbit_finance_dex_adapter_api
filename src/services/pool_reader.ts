import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID, connection, pk } from "../solana.js";
import { getProvider } from "../anchor/provider.js";
import { getProgram, requireProgramId } from "../anchor/program.js";
import { safeNumber } from "../utils/http.js";
import { deriveBinPda } from "../utils/pda.js";

export type PoolView = {
  id: string;
  programId: string;

  baseMint: string;
  quoteMint: string;

  baseDecimals: number;
  quoteDecimals: number;

  priceQ6464: string;
  priceNumber: number | null;

  baseVault: string;
  quoteVault: string;

  creatorFeeVault: string | null;
  holdersFeeVault: string | null;
  nftFeeVault: string | null;

  activeBin: number;
  initialBin: number;

  // Active-bin reserves in ATOMS (stringified bigint)
  binReserveBaseAtoms: string | null;
  binReserveQuoteAtoms: string | null;

  admin: string;
  pausedBits: number;
  binStepBps: number;
  baseFeeBps: number;
};

const DECIMALS_CACHE = new Map<string, number>();

async function getMintDecimals(mint: PublicKey): Promise<number> {
  const k = mint.toBase58();
  const cached = DECIMALS_CACHE.get(k);
  if (cached != null) return cached;

  const info = await connection.getParsedAccountInfo(mint, "confirmed");
  const value = info.value;
  if (!value) throw new Error(`mint_not_found: ${k}`);

  // Parsed format: { data: { parsed: { info: { decimals }}}}
  const data: unknown = value.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("parsed" in data) ||
    typeof (data as any).parsed !== "object" ||
    (data as any).parsed === null
  ) {
    throw new Error(`mint_not_parsed: ${k}`);
  }

  const parsed = (data as any).parsed;
  const decimals = parsed?.info?.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`mint_decimals_invalid: ${k}`);
  }

  DECIMALS_CACHE.set(k, decimals);
  return decimals;
}

export async function readPool(pool: string): Promise<PoolView> {
  const provider = getProvider() as AnchorProvider;
  const program = getProgram(provider);
  requireProgramId(program, PROGRAM_ID);

  const p = await program.account.pool.fetch(pk(pool));

  // price
  const priceQ64 = BigInt(p.priceQ6464.toString());
  const priceNumber = safeNumber(priceQ64) === null ? null : Number(priceQ64) / 2 ** 64;

  // decimals
  const baseMintPk = p.baseMint as PublicKey;
  const quoteMintPk = p.quoteMint as PublicKey;

  const [baseDecimals, quoteDecimals] = await Promise.all([
    getMintDecimals(baseMintPk),
    getMintDecimals(quoteMintPk),
  ]);

  // active bin reserves (best-effort)
  // liquidityBin PDA seed expects u64, pool.activeBin is i32 in Orbit Finance IDL.
  const activeBin = Number(p.activeBin);
  let binReserveBaseAtoms: string | null = null;
  let binReserveQuoteAtoms: string | null = null;

  if (Number.isInteger(activeBin) && activeBin >= 0) {
    const binIndexU64 = BigInt(activeBin);
    const poolPk = pk(pool);
    const binPda = deriveBinPda(PROGRAM_ID, poolPk, binIndexU64);

    try {
      const bin = await program.account.liquidityBin.fetch(binPda);

      // Orbit Finance IDL reserveBase/reserveQuote as u128.
      // Anchor returns BN-like, we stringify to BigInt safely via .toString().
      const reserveBaseAtoms = BigInt((bin as any).reserveBase.toString());
      const reserveQuoteAtoms = BigInt((bin as any).reserveQuote.toString());

      binReserveBaseAtoms = reserveBaseAtoms.toString();
      binReserveQuoteAtoms = reserveQuoteAtoms.toString();
    } catch {
      // If bin doesn't exist yet, keep null (do NOT lie with 0)
      binReserveBaseAtoms = null;
      binReserveQuoteAtoms = null;
    }
  }

  return {
    id: pool,
    programId: program.programId.toBase58(),

    baseMint: baseMintPk.toBase58(),
    quoteMint: quoteMintPk.toBase58(),

    baseDecimals,
    quoteDecimals,

    priceQ6464: p.priceQ6464.toString(),
    priceNumber,

    baseVault: p.baseVault.toBase58(),
    quoteVault: p.quoteVault.toBase58(),

    creatorFeeVault: p.creatorFeeVault?.toBase58?.() ?? null,
    holdersFeeVault: p.holdersFeeVault?.toBase58?.() ?? null,
    nftFeeVault: p.nftFeeVault?.toBase58?.() ?? null,

    activeBin,
    initialBin: Number(p.initialBinId),

    binReserveBaseAtoms,
    binReserveQuoteAtoms,

    admin: p.admin.toBase58(),
    pausedBits: Number(p.pauseBits),
    binStepBps: Number(p.binStepBps),
    baseFeeBps: Number(p.baseFeeBps),
  };
}