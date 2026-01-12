import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID, connection, pk } from "../solana.js";
import { safeNumber } from "../utils/http.js";
import { deriveBinPda } from "../utils/pda.js";
import { decodeAccount } from "../idl/coder.js";

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

export type BinPoint = {
  binId: number;
  price: number | null;   // quote per base (same style you already use)
  baseAtoms: string;      // raw reserves as stringified bigint
  quoteAtoms: string;     // raw reserves as stringified bigint
  baseUi: number;         // ui reserves
  quoteUi: number;        // ui reserves
};

export type BinsView = {
  pool: string;
  programId: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  activeBin: number;
  initialBin: number;
  binStepBps: number;
  priceActive: number | null;
  bins: BinPoint[];
};

const DECIMALS_CACHE = new Map<string, number>();

function pick<T = any>(obj: any, keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k] as T;
  }
  return undefined;
}

function asPk(x: any, label: string): PublicKey {
  if (x instanceof PublicKey) return x;
  if (typeof x === "string") return new PublicKey(x);
  if (x instanceof Uint8Array || Buffer.isBuffer(x)) return new PublicKey(x);
  throw new Error(`${label}_invalid_pubkey`);
}

function asU64String(x: any, label: string): string {
  if (x == null) throw new Error(`${label}_missing`);
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") return BigInt(Math.trunc(x)).toString();
  if (typeof x === "string") return x;
  if (typeof x?.toString === "function") return x.toString();
  throw new Error(`${label}_invalid_u64`);
}

function asNumberI32(x: any, label: string): number {
  if (x == null) throw new Error(`${label}_missing`);
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") {
    const n = Number(x);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  if (typeof x?.toString === "function") {
    const n = Number(x.toString());
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  throw new Error(`${label}_invalid_i32`);
}

async function getMintDecimals(mint: PublicKey): Promise<number> {
  const k = mint.toBase58();
  const cached = DECIMALS_CACHE.get(k);
  if (cached != null) return cached;

  const info = await connection.getParsedAccountInfo(mint, "confirmed");
  const value = info.value;
  if (!value) throw new Error(`mint_not_found: ${k}`);

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

/**
 * state stores binId as i32 (can be negative).
 * deriveBinPda expects a u64 seed. Convert i32 -> u32 two's complement, then to u64.
 * -1203 becomes (2^32 - 1203) as the seed.
 */
function binIdI32ToSeedU64(binId: number): bigint {
  if (!Number.isInteger(binId)) throw new Error("bin_id_not_int");
  const b = BigInt(binId);
  if (b >= 0n) return b;
  return (1n << 32n) + b; // wrap i32 -> u32 (two's complement)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function powRatio(stepBps: number, delta: number): number {
  const r = 1 + stepBps / 10_000;
  return Math.pow(r, delta);
}

function toUi(atomsStr: string, decimals: number): number {
  try {
    const atoms = BigInt(atomsStr);
    const denom = 10 ** decimals;
    const ui = Number(atoms) / denom;
    return Number.isFinite(ui) ? ui : 0;
  } catch {
    return 0;
  }
}

export async function readPool(pool: string): Promise<PoolView> {
  const poolPk = pk(pool);

  const info = await connection.getAccountInfo(poolPk, "confirmed");
  if (!info?.data) throw new Error(`pool_not_found: ${pool}`);

  // Decode via IDL coder
  const raw: any = decodeAccount("Pool", Buffer.from(info.data));
  const adminPk = asPk(pick(raw, ["admin"])!, "admin");
  const baseMintPk = asPk(pick(raw, ["baseMint", "base_mint"])!, "base_mint");
  const quoteMintPk = asPk(pick(raw, ["quoteMint", "quote_mint"])!, "quote_mint");
  const baseVaultPk = asPk(pick(raw, ["baseVault", "base_vault"])!, "base_vault");
  const quoteVaultPk = asPk(pick(raw, ["quoteVault", "quote_vault"])!, "quote_vault");
  const creatorFeeVaultPk = pick<any>(raw, ["creatorFeeVault", "creator_fee_vault"]);
  const holdersFeeVaultPk = pick<any>(raw, ["holdersFeeVault", "holders_fee_vault"]);
  const nftFeeVaultPk = pick<any>(raw, ["nftFeeVault", "nft_fee_vault"]);

  const priceVal = pick<any>(raw, ["priceQ6464", "priceQ64_64", "price_q64_64"]);
  const priceQ64 = BigInt(asU64String(priceVal, "price_q64_64"));
  const priceNumber = safeNumber(priceQ64) === null ? null : Number(priceQ64) / 2 ** 64;

  const activeBin = asNumberI32(pick(raw, ["activeBin", "active_bin"])!, "active_bin");
  const initialBin = asNumberI32(pick(raw, ["initialBinId", "initial_bin_id"])!, "initial_bin_id");
  const pauseBits = asNumberI32(pick(raw, ["pauseBits", "pause_bits"]) ?? 0, "pause_bits");
  const binStepBps = asNumberI32(pick(raw, ["binStepBps", "bin_step_bps"]) ?? 0, "bin_step_bps");
  const baseFeeBps = asNumberI32(pick(raw, ["baseFeeBps", "base_fee_bps"]) ?? 0, "base_fee_bps");

  // decimals
  const [baseDecimals, quoteDecimals] = await Promise.all([
    getMintDecimals(baseMintPk),
    getMintDecimals(quoteMintPk),
  ]);

  // active bin reserves (best-effort)
  let binReserveBaseAtoms: string | null = null;
  let binReserveQuoteAtoms: string | null = null;

  // allow negative activeBin too (wrap seed)
  if (Number.isInteger(activeBin)) {
    const binIndexU64 = binIdI32ToSeedU64(activeBin);
    const binPda = deriveBinPda(PROGRAM_ID, poolPk, binIndexU64);

    try {
      const binInfo = await connection.getAccountInfo(binPda, "confirmed");
      if (binInfo?.data) {
        const binRaw: any = decodeAccount("LiquidityBin", Buffer.from(binInfo.data));

        const reserveBaseVal = pick<any>(binRaw, ["reserveBase", "reserve_base"]);
        const reserveQuoteVal = pick<any>(binRaw, ["reserveQuote", "reserve_quote"]);

        if (reserveBaseVal != null && reserveQuoteVal != null) {
          const reserveBaseAtoms = BigInt(asU64String(reserveBaseVal, "reserve_base"));
          const reserveQuoteAtoms = BigInt(asU64String(reserveQuoteVal, "reserve_quote"));
          binReserveBaseAtoms = reserveBaseAtoms.toString();
          binReserveQuoteAtoms = reserveQuoteAtoms.toString();
        }
      }
    } catch {
      binReserveBaseAtoms = null;
      binReserveQuoteAtoms = null;
    }
  }

  return {
    id: pool,
    programId: PROGRAM_ID.toBase58(),

    baseMint: baseMintPk.toBase58(),
    quoteMint: quoteMintPk.toBase58(),

    baseDecimals,
    quoteDecimals,

    priceQ6464: priceQ64.toString(),
    priceNumber,

    baseVault: baseVaultPk.toBase58(),
    quoteVault: quoteVaultPk.toBase58(),

    creatorFeeVault:
      creatorFeeVaultPk != null ? asPk(creatorFeeVaultPk, "creator_fee_vault").toBase58() : null,
    holdersFeeVault:
      holdersFeeVaultPk != null ? asPk(holdersFeeVaultPk, "holders_fee_vault").toBase58() : null,
    nftFeeVault:
      nftFeeVaultPk != null ? asPk(nftFeeVaultPk, "nft_fee_vault").toBase58() : null,

    activeBin,
    initialBin,

    binReserveBaseAtoms,
    binReserveQuoteAtoms,

    admin: adminPk.toBase58(),
    pausedBits: pauseBits,
    binStepBps,
    baseFeeBps,
  };
}

/**
 * Read a histogram window of LiquidityBin accounts around activeBin in ONE batched RPC pass.
 * This returns:
 * - bins[] suitable for drawing (base/quote per bin)
 * - price per bin computed from pool.priceNumber and binStepBps
 */
export async function readBins(pool: string, opts?: { radius?: number; limit?: number }): Promise<BinsView> {
  const radius = Math.max(10, Math.min(2000, Math.trunc(opts?.radius ?? 300)));
  const limit = Math.max(20, Math.min(4000, Math.trunc(opts?.limit ?? (radius * 2 + 1))));

  const poolView = await readPool(pool);
  const poolPk = pk(pool);

  const activeBin = poolView.activeBin;
  const startBin = activeBin - radius;
  const endBin = activeBin + radius;

  const binIds: number[] = [];
  for (let b = startBin; b <= endBin; b++) binIds.push(b);

  // derive all bin PDAs
  const pdas = binIds.map((binId) => {
    const seed = binIdI32ToSeedU64(binId);
    return deriveBinPda(PROGRAM_ID, poolPk, seed);
  });

  // batch fetch (100 is safe for getMultipleAccountsInfo)
  const batches = chunk(pdas, 100);
  const infos: (Awaited<ReturnType<typeof connection.getMultipleAccountsInfo>>[number])[] = [];
  for (const b of batches) {
    const res = await connection.getMultipleAccountsInfo(b, "confirmed");
    infos.push(...res);
  }

  // pre-fill all bins (so empty bins render as 0)
  const points: BinPoint[] = binIds.map((binId) => {
    const priceActive = poolView.priceNumber;
    const price =
      priceActive != null && Number.isFinite(priceActive)
        ? priceActive * powRatio(poolView.binStepBps, binId - activeBin)
        : null;

    return {
      binId,
      price: price != null && Number.isFinite(price) ? price : null,
      baseAtoms: "0",
      quoteAtoms: "0",
      baseUi: 0,
      quoteUi: 0,
    };
  });

  // fill decoded reserves where accounts exist
  for (let i = 0; i < infos.length && i < points.length; i++) {
    const info = infos[i];
    if (!info?.data) continue;

    try {
      const binRaw: any = decodeAccount("LiquidityBin", Buffer.from(info.data));
      const reserveBaseVal = pick<any>(binRaw, ["reserveBase", "reserve_base"]);
      const reserveQuoteVal = pick<any>(binRaw, ["reserveQuote", "reserve_quote"]);
      if (reserveBaseVal == null || reserveQuoteVal == null) continue;

      const baseAtoms = BigInt(asU64String(reserveBaseVal, "reserve_base")).toString();
      const quoteAtoms = BigInt(asU64String(reserveQuoteVal, "reserve_quote")).toString();

      const p = points[i]!;
      p.baseAtoms = baseAtoms;
      p.quoteAtoms = quoteAtoms;
      p.baseUi = toUi(baseAtoms, poolView.baseDecimals);
      p.quoteUi = toUi(quoteAtoms, poolView.quoteDecimals);
    } catch {
      // ignore decode failures
    }
  }

  // filter/sort
  const bins = points
    .filter((b: BinPoint) =>
      Number.isFinite(b.binId) &&
      (b.price == null || Number.isFinite(b.price)) &&
      Number.isFinite(b.baseUi) &&
      Number.isFinite(b.quoteUi)
    )
    .sort((a: BinPoint, b: BinPoint) => a.binId - b.binId)
    .slice(0, limit);

  return {
    pool,
    programId: poolView.programId,
    baseMint: poolView.baseMint,
    quoteMint: poolView.quoteMint,
    baseDecimals: poolView.baseDecimals,
    quoteDecimals: poolView.quoteDecimals,
    activeBin: poolView.activeBin,
    initialBin: poolView.initialBin,
    binStepBps: poolView.binStepBps,
    priceActive: poolView.priceNumber,
    bins,
  };
}