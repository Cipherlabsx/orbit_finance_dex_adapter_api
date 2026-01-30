import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, getAssociatedTokenAddress } from "@solana/spl-token";

type DexPoolRow = {
  pool: string;

  base_mint: string;
  quote_mint: string;
  base_decimals: number;
  quote_decimals: number;

  base_vault: string;
  quote_vault: string;
  lp_mint: string;

  last_price_quote_per_base: string | number | null;

  // columns to write
  escrow_lp_ata?: string | null;
  escrow_lp_raw?: string | number | null;
  lp_supply_raw?: string | number | null;
  liquidity_quote?: string | number | null;
  tvl_locked_quote?: string | number | null;
  updated_at?: string | null;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const BATCH = Number(process.env.POOL_LIQ_BACKFILL_BATCH ?? 100);

// For “make DB correct now”, do NOT use processed.
// confirmed is a good default; finalized is slower but safest.
const RPC_COMMITMENT: Parameters<Connection["getMultipleAccountsInfo"]>[1] =
  (process.env.POOL_LIQ_RPC_COMMITMENT as any) ?? "confirmed";

// Price sanity bounds (quote per base). Prevents another 1000x style corruption.
const MAX_SANE_PX = Number(process.env.POOL_LIQ_MAX_SANE_PX ?? 100);
const MIN_SANE_PX = Number(process.env.POOL_LIQ_MIN_SANE_PX ?? 0);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type TokenAccDecoded = { mint: string; amountRaw: bigint };

function u64LeToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(bytes[i]!) << (8n * BigInt(i));
  return v;
}

function u64ToBigInt(x: any): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return Number.isFinite(x) ? BigInt(Math.trunc(x)) : 0n;

  if (x instanceof Uint8Array) return x.length >= 8 ? u64LeToBigInt(x) : 0n;

  // Buffer in Node
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) {
    const u8 = new Uint8Array(x);
    return u8.length >= 8 ? u64LeToBigInt(u8) : 0n;
  }

  if (x && typeof x === "object" && typeof x.toString === "function") {
    try {
      return BigInt(x.toString(10));
    } catch {
      try {
        return BigInt(String(x));
      } catch {
        return 0n;
      }
    }
  }

  return 0n;
}

type DecodedTokenAccount = { mint: PublicKey | Uint8Array; amount: any };

function decodeTokenAccount(data: Buffer | Uint8Array): TokenAccDecoded | null {
  try {
    const acc = AccountLayout.decode(data) as unknown as DecodedTokenAccount;

    const mintPk = acc.mint instanceof PublicKey ? acc.mint : new PublicKey(acc.mint);
    const mint = mintPk.toBase58();

    const amountRaw = u64ToBigInt(acc.amount);
    return { mint, amountRaw };
  } catch {
    return null;
  }
}

type DecodedMint = { decimals: number; supply: any };

function decodeMint(data: Buffer | Uint8Array): { decimals: number; supplyRaw: bigint } | null {
  try {
    const m = MintLayout.decode(data) as unknown as DecodedMint;
    const decimals = Number(m.decimals);
    const supplyRaw = u64ToBigInt(m.supply);
    if (!Number.isFinite(decimals)) return null;
    return { decimals, supplyRaw };
  } catch {
    return null;
  }
}

function toUi(raw: bigint, decimals: number): number {
  const denom = 10 ** decimals;
  const ui = Number(raw) / denom;
  return Number.isFinite(ui) ? ui : 0;
}

function num(x: unknown, fallback = 0): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function isSanePx(px: number): boolean {
  return Number.isFinite(px) && px > MIN_SANE_PX && px <= MAX_SANE_PX;
}

/**
 * Prefer on-chain vault ratio for price when possible:
 *   px = quoteUi / baseUi  (quote per base)
 *
 * If baseUi is ~0 (empty pool), return null.
 */
function priceFromVaults(baseUi: number, quoteUi: number): number | null {
  if (!Number.isFinite(baseUi) || !Number.isFinite(quoteUi)) return null;
  if (baseUi <= 0) return null;
  const px = quoteUi / baseUi;
  if (!isSanePx(px)) return null;
  return px;
}

async function main() {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SOLANA_RPC_URL = mustEnv("SOLANA_RPC_URL");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const conn = new Connection(SOLANA_RPC_URL, {
    commitment: RPC_COMMITMENT as any,
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 15_000,
  });

  console.log("[pool_liq_backfill] rpc=", SOLANA_RPC_URL);
  console.log("[pool_liq_backfill] commitment=", RPC_COMMITMENT);
  console.log("[pool_liq_backfill] batch=", BATCH);
  console.log("[pool_liq_backfill] sane_px=", { MIN_SANE_PX, MAX_SANE_PX });

  const { data, error } = await supa
    .from("dex_pools")
    .select(
      [
        "pool",
        "base_mint",
        "quote_mint",
        "base_decimals",
        "quote_decimals",
        "base_vault",
        "quote_vault",
        "lp_mint",
        "last_price_quote_per_base",
        "escrow_lp_ata",
        "escrow_lp_raw",
        "lp_supply_raw",
        "liquidity_quote",
        "tvl_locked_quote",
      ].join(",")
    );

  if (error) throw new Error(`[pool_liq_backfill] select dex_pools failed: ${error.message}`);
  const rows = (data ?? []) as unknown as DexPoolRow[];
  console.log("[pool_liq_backfill] dex_pools rows=", rows.length);
  if (!rows.length) return;

  // build required pubkeys
  const baseVaultKeys: PublicKey[] = [];
  const quoteVaultKeys: PublicKey[] = [];
  const escrowKeys: PublicKey[] = [];
  const lpMintKeys: PublicKey[] = [];

  // compute escrow ATA for each pool: ATA(lp_mint, owner=pool PDA, allowOwnerOffCurve=true)
  const poolMeta = new Map<
    string,
    { baseVault: string; quoteVault: string; lpMint: string; escrowAta: string }
  >();

  for (const r of rows) {
    const poolPk = new PublicKey(r.pool);
    const lpMintPk = new PublicKey(r.lp_mint);

    const escrowAta = await getAssociatedTokenAddress(lpMintPk, poolPk, true);

    poolMeta.set(r.pool, {
      baseVault: r.base_vault,
      quoteVault: r.quote_vault,
      lpMint: r.lp_mint,
      escrowAta: escrowAta.toBase58(),
    });

    baseVaultKeys.push(new PublicKey(r.base_vault));
    quoteVaultKeys.push(new PublicKey(r.quote_vault));
    escrowKeys.push(escrowAta);
    lpMintKeys.push(lpMintPk);
  }

  // fetch token accounts (base/quote vaults + escrow)
  const uniqTokenAccs = Array.from(
    new Set([...baseVaultKeys, ...quoteVaultKeys, ...escrowKeys].map((k) => k.toBase58()))
  ).map((s) => new PublicKey(s));

  const tokenAccInfo = new Map<string, TokenAccDecoded>();
  for (const b of chunk(uniqTokenAccs, BATCH)) {
    const infos = await conn.getMultipleAccountsInfo(b, RPC_COMMITMENT);
    for (let i = 0; i < b.length; i++) {
      const pk = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;
      const dec = decodeTokenAccount(Buffer.from(info.data));
      if (dec) tokenAccInfo.set(pk, dec);
    }
  }

  // fetch LP mint supplies
  const uniqLpMints = Array.from(new Set(lpMintKeys.map((k) => k.toBase58()))).map((s) => new PublicKey(s));
  const lpMintInfo = new Map<string, { decimals: number; supplyRaw: bigint }>();
  for (const b of chunk(uniqLpMints, BATCH)) {
    const infos = await conn.getMultipleAccountsInfo(b, RPC_COMMITMENT);
    for (let i = 0; i < b.length; i++) {
      const pk = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;
      const dec = decodeMint(Buffer.from(info.data));
      if (dec) lpMintInfo.set(pk, dec);
    }
  }

  // compute and write updates per pool
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    const meta = poolMeta.get(r.pool);
    if (!meta) continue;

    const baseVault = meta.baseVault;
    const quoteVault = meta.quoteVault;
    const escrowAta = meta.escrowAta;
    const lpMint = meta.lpMint;

    const baseTok = tokenAccInfo.get(baseVault);
    const quoteTok = tokenAccInfo.get(quoteVault);
    const escTok = tokenAccInfo.get(escrowAta);
    const lpMintDec = lpMintInfo.get(lpMint);

    if (!baseTok || !quoteTok || !lpMintDec) {
      skipped++;
      continue;
    }

    // raw token amounts (atoms)
    const baseRaw = baseTok.amountRaw;
    const quoteRaw = quoteTok.amountRaw;

    // UI amounts (token units)
    const baseUi = toUi(baseRaw, r.base_decimals);
    const quoteUi = toUi(quoteRaw, r.quote_decimals);

    // Prefer on-chain vault ratio for price; fallback to stored DB px if sane.
    const pxVault = priceFromVaults(baseUi, quoteUi);
    const pxStored = num(r.last_price_quote_per_base, 0);
    const px =
      pxVault != null ? pxVault :
      isSanePx(pxStored) ? pxStored :
      null;

    // liquidity_quote = quoteVault + baseVault * px (in quote units)
    // if px missing, we still keep quote side as “at least”
    const liquidityQuote = px != null ? quoteUi + baseUi * px : quoteUi;

    // LP lock share = escrow_lp / total_supply
    const totalLpUi = toUi(lpMintDec.supplyRaw, lpMintDec.decimals);
    const escrowLpRaw = escTok?.amountRaw ?? 0n;
    const escrowLpUi = toUi(escrowLpRaw, lpMintDec.decimals);

    const lockedShare = totalLpUi > 0 ? Math.max(0, Math.min(1, escrowLpUi / totalLpUi)) : 0;
    const tvlLockedQuote = liquidityQuote * lockedShare;

    const patch: any = {
      escrow_lp_ata: escrowAta,
      escrow_lp_raw: escrowLpRaw.toString(),
      lp_supply_raw: lpMintDec.supplyRaw.toString(),
      liquidity_quote: liquidityQuote,
      tvl_locked_quote: tvlLockedQuote,
      updated_at: new Date().toISOString(),
    };

    // If we have a sane vault-derived price, update last_price_quote_per_base too.
    // (This makes the frontend “latest price” correct even if no new swaps come in.)
    if (pxVault != null) {
      patch.last_price_quote_per_base = pxVault;
    }

    const { error: updErr } = await supa.from("dex_pools").update(patch).eq("pool", r.pool);
    if (updErr) throw new Error(`[pool_liq_backfill] update failed for pool ${r.pool}: ${updErr.message}`);

    updated++;
  }

  console.log("[pool_liq_backfill] done", { updated, skipped });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});