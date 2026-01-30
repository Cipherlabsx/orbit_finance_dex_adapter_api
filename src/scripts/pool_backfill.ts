import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";

import { decodeAccount } from "../idl/coder.js";

type DexPoolRow = {
  pool: string;

  program_id: string | null;

  base_mint: string | null;
  quote_mint: string | null;
  base_decimals: number | null;
  quote_decimals: number | null;

  last_price_quote_per_base: string | number | null;
  updated_at: string | null;

  base_vault: string | null;
  quote_vault: string | null;
  lp_mint: string | null;

  base_fee_bps: number | null;
  bin_step_bps: number | null;
  paused_bits: number | null;

  active_bin: number | null;
  initial_bin: number | null;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseBoolEnv(name: string, def = false): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickUnknown(obj: unknown, keys: string[]): unknown {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    if (k in obj) {
      const val = obj[k];
      if (val != null) return val;
    }
  }
  return undefined;
}

function asPk(x: unknown, label: string): PublicKey {
  if (x instanceof PublicKey) return x;
  if (typeof x === "string") return new PublicKey(x);
  if (x instanceof Uint8Array) return new PublicKey(x);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return new PublicKey(x);
  throw new Error(`${label}_invalid_pubkey`);
}

function asNumberI32(x: unknown, label: string): number {
  if (x == null) throw new Error(`${label}_missing`);

  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "bigint") return Number(x);

  if (typeof x === "string") {
    const n = Number(x);
    if (Number.isFinite(n)) return Math.trunc(n);
  }

  if (isRecord(x) && typeof x.toString === "function") {
    const n = Number((x as { toString: () => string }).toString());
    if (Number.isFinite(n)) return Math.trunc(n);
  }

  throw new Error(`${label}_invalid_i32`);
}

function asNumberU16(x: unknown, label: string): number {
  const n = asNumberI32(x, label);
  if (n < 0 || n > 65535) throw new Error(`${label}_invalid_u16`);
  return n;
}

function asNumberU32(x: unknown, label: string): number {
  const n = asNumberI32(x, label);
  if (n < 0 || n > 4294967295) throw new Error(`${label}_invalid_u32`);
  return n;
}

function setPatch<K extends keyof DexPoolRow>(obj: Partial<DexPoolRow>, key: K, val: DexPoolRow[K]) {
  obj[key] = val;
}

function onlyNullUpdates(row: DexPoolRow, patch: Partial<DexPoolRow>): Partial<DexPoolRow> {
  const out: Partial<DexPoolRow> = {};

  const entries = Object.entries(patch) as Array<
    [keyof DexPoolRow, DexPoolRow[keyof DexPoolRow] | undefined]
  >;

  for (const [k, v] of entries) {
    if (v == null) continue;

    const cur = row[k];

    const isEmpty =
      cur == null ||
      (typeof cur === "string" && cur.trim() === "") ||
      (typeof cur === "number" && !Number.isFinite(cur));

    if (isEmpty) {
      // TS needs help to relate k -> value type
      setPatch(out, k, v as DexPoolRow[typeof k]);
    }
  }

  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Decode Pool account using your IDL coder (same as readPool()).
 * Returns a DB patch with fields you want to backfill.
 */
function decodePoolToPatch(data: Buffer): Partial<DexPoolRow> | null {
  const raw: unknown = decodeAccount("Pool", data);
  if (!raw) return null;

  try {
    const baseVaultPk = asPk(pickUnknown(raw, ["baseVault", "base_vault"]), "base_vault");
    const quoteVaultPk = asPk(pickUnknown(raw, ["quoteVault", "quote_vault"]), "quote_vault");

    // lp mint might be named differently depending on your struct/IDL
    const lpMintVal = pickUnknown(raw, ["lpMint", "lp_mint", "lpTokenMint", "lp_token_mint"]);
    const lpMintPk = lpMintVal != null ? asPk(lpMintVal, "lp_mint") : null;

    const activeBin = asNumberI32(pickUnknown(raw, ["activeBin", "active_bin"]), "active_bin");

    // pool_reader uses initialBinId / initial_bin_id
    const initialBin = asNumberI32(
      pickUnknown(raw, ["initialBinId", "initial_bin_id", "initialBin", "initial_bin"]),
      "initial_bin_id"
    );

    // pool_reader uses pauseBits/binStepBps/baseFeeBps (and snake-case fallbacks)
    const pausedBits = asNumberU32(pickUnknown(raw, ["pauseBits", "pause_bits"]) ?? 0, "pause_bits");
    const binStepBps = asNumberU16(pickUnknown(raw, ["binStepBps", "bin_step_bps"]) ?? 0, "bin_step_bps");
    const baseFeeBps = asNumberU16(pickUnknown(raw, ["baseFeeBps", "base_fee_bps"]) ?? 0, "base_fee_bps");

    return {
      base_vault: baseVaultPk.toBase58(),
      quote_vault: quoteVaultPk.toBase58(),
      lp_mint: lpMintPk ? lpMintPk.toBase58() : null,

      active_bin: activeBin,
      initial_bin: initialBin,

      paused_bits: pausedBits,
      bin_step_bps: binStepBps,
      base_fee_bps: baseFeeBps,
    };
  } catch {
    return null;
  }
}

async function main() {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SOLANA_RPC_URL = mustEnv("SOLANA_RPC_URL");

  const BATCH = clampInt(Number(process.env.POOL_BACKFILL_BATCH ?? 50), 1, 250);
  const DELAY_MS = clampInt(Number(process.env.POOL_BACKFILL_DELAY_MS ?? 150), 0, 5000);
  const DRY_RUN = parseBoolEnv("POOL_BACKFILL_DRY_RUN", false);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const conn = new Connection(SOLANA_RPC_URL, {
    commitment: "processed",
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 10_000,
  });

  console.log("[pool_backfill] rpc =", SOLANA_RPC_URL);
  console.log("[pool_backfill] batch =", BATCH);
  console.log("[pool_backfill] delay_ms =", DELAY_MS);
  console.log("[pool_backfill] dry_run =", DRY_RUN);

  // 1) load pools
  const { data: pools, error } = await supa
    .from("dex_pools")
    .select(
      [
        "pool",
        "program_id",
        "base_mint",
        "quote_mint",
        "base_decimals",
        "quote_decimals",
        "last_price_quote_per_base",
        "updated_at",
        "base_vault",
        "quote_vault",
        "lp_mint",
        "base_fee_bps",
        "bin_step_bps",
        "paused_bits",
        "active_bin",
        "initial_bin",
      ].join(",")
    );

  if (error) throw new Error(`[pool_backfill] select dex_pools failed: ${error.message}`);
  const rows = (pools ?? []) as unknown as DexPoolRow[];
  console.log("[pool_backfill] dex_pools rows =", rows.length);
  if (!rows.length) return;

  const byPool = new Map<string, DexPoolRow>();
  for (const r of rows) byPool.set(r.pool, r);

  // 2) fetch on-chain accounts in batches
  const poolKeys = rows.map((r) => new PublicKey(r.pool));
  const batches = chunk(poolKeys, BATCH);

  let updated = 0;
  let skipped = 0;
  let missingAcc = 0;
  let decodeFailed = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const b = batches[bi]!;
    const infos = await conn.getMultipleAccountsInfo(b, "processed");

    const updates: Array<{ pool: string; patch: Partial<DexPoolRow> }> = [];

    for (let i = 0; i < b.length; i++) {
      const poolPk = b[i]!.toBase58();
      const row = byPool.get(poolPk);
      const info = infos[i];

      if (!row) continue;

      if (!info?.data) {
        missingAcc++;
        continue;
      }

      const patch = decodePoolToPatch(Buffer.from(info.data));
      if (!patch) {
        decodeFailed++;
        continue;
      }

      const safePatch = onlyNullUpdates(row, patch);
      if (Object.keys(safePatch).length === 0) {
        skipped++;
        continue;
      }

      updates.push({ pool: poolPk, patch: safePatch });
    }

    if (!updates.length) {
      console.log(`[pool_backfill] batch ${bi + 1}/${batches.length}: no updates`);
      if (DELAY_MS) await sleep(DELAY_MS);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[pool_backfill] batch ${bi + 1}/${batches.length}: DRY_RUN would_update=${updates.length}`);
      if (DELAY_MS) await sleep(DELAY_MS);
      continue;
    }

    // robust update: one-by-one
    for (const u of updates) {
      const { error: updErr } = await supa.from("dex_pools").update(u.patch).eq("pool", u.pool);
      if (updErr) throw new Error(`[pool_backfill] update failed for pool ${u.pool}: ${updErr.message}`);
    }

    updated += updates.length;
    console.log(`[pool_backfill] batch ${bi + 1}/${batches.length}: updated=${updates.length}`);

    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log("[pool_backfill] done", { updated, skipped, missingAcc, decodeFailed, dryRun: DRY_RUN });

  if (decodeFailed > 0) {
    console.log(
      "[pool_backfill] NOTE: decodeFailed > 0 usually means account isn't a Pool account, or decodeAccount('Pool') layout mismatch."
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});