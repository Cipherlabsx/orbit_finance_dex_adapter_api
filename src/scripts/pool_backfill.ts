import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";

type DexPoolRow = {
  pool: string;
  program_id: string | null;

  base_mint: string | null;
  quote_mint: string | null;
  base_decimals: number | null;
  quote_decimals: number | null;

  last_price_quote_per_base: string | number | null;
  updated_at: string | null;

  // fields we want to backfill
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

// CONFIG
// batch size for getMultipleAccountsInfo
const BATCH = Number(process.env.POOL_BACKFILL_BATCH ?? 100);
const DISCRIM = 8;
const PUBKEY = 32;

// These are the ONLY things likely to need adjustment:
const FIELD_INDEX = {
  // pubkey fields (0-based within the pubkey list AFTER discriminator)
  baseVault: 7,  // <-- if wrong, change
  quoteVault: 8, // <-- if wrong, change
  lpMint: 12,    // <-- matches your frontend code
};

// Non-pubkey scalar offsets (best-effort).
// These vary a lot by struct layout; we’ll parse only if the offset is known.
// If you *know* exact offsets for these in your Rust struct, set them here.
const SCALAR_OFFSETS: Partial<Record<keyof DexPoolRow, number>> = {
  // Example placeholders (likely wrong unless you confirm the layout)
  // base_fee_bps: <byte_offset>,
  // bin_step_bps: <byte_offset>,
  // paused_bits: <byte_offset>,
  // active_bin: <byte_offset>,
  // initial_bin: <byte_offset>,
};

// ---- helpers ----
function isLikelyPubkey(s: string | null | undefined): boolean {
  if (!s) return false;
  if (s.length < 32 || s.length > 60) return false;
  try {
    // will throw if invalid
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function readPubkeyAt(data: Buffer, pubkeyFieldIndex: number): string | null {
  const offset = DISCRIM + pubkeyFieldIndex * PUBKEY;
  if (offset + PUBKEY > data.length) return null;
  const bytes = data.subarray(offset, offset + PUBKEY);
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    return null;
  }
}

function readU16LE(data: Buffer, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return data.readUInt16LE(offset);
}

function readI32LE(data: Buffer, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return data.readInt32LE(offset);
}

function readU32LE(data: Buffer, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return data.readUInt32LE(offset);
}

function onlyNullUpdates(row: DexPoolRow, patch: Partial<DexPoolRow>): Partial<DexPoolRow> {
  const out: Partial<DexPoolRow> = {};
  for (const [k, v] of Object.entries(patch) as [keyof DexPoolRow, any][]) {
    if (v == null) continue;
    const cur = row[k];
    const isEmpty =
      cur == null ||
      (typeof cur === "string" && cur.trim() === "") ||
      (typeof cur === "number" && !Number.isFinite(cur));
    if (isEmpty) out[k] = v;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- main ----
async function main() {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SOLANA_RPC_URL = mustEnv("SOLANA_RPC_URL");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const conn = new Connection(SOLANA_RPC_URL, {
    commitment: "processed",
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 10_000,
  });

  console.log("[pool_backfill] rpc=", SOLANA_RPC_URL);
  console.log("[pool_backfill] batch=", BATCH);
  console.log("[pool_backfill] fieldIndex=", FIELD_INDEX);

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
  console.log("[pool_backfill] dex_pools rows=", rows.length);
  if (!rows.length) return;

  // 2) fetch on-chain in batches
  const poolKeys = rows.map((r) => new PublicKey(r.pool));
  const batches = chunk(poolKeys, BATCH);

  let updated = 0;
  let skipped = 0;
  let missingAcc = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const b = batches[bi]!;
    const infos = await conn.getMultipleAccountsInfo(b, "processed");

    // 3) parse + build updates
    const updates: Array<{ pool: string } & Partial<DexPoolRow>> = [];

    for (let i = 0; i < b.length; i++) {
      const poolPk = b[i]!.toBase58();
      const info = infos[i];
      const row = rows.find((r) => r.pool === poolPk);
      if (!row) continue;

      if (!info?.data) {
        missingAcc++;
        continue;
      }

      const data = Buffer.from(info.data);

      const baseVault = readPubkeyAt(data, FIELD_INDEX.baseVault);
      const quoteVault = readPubkeyAt(data, FIELD_INDEX.quoteVault);
      const lpMint = readPubkeyAt(data, FIELD_INDEX.lpMint);

      // Scalars (optional; only if offsets configured)
      const base_fee_bps =
        SCALAR_OFFSETS.base_fee_bps != null ? readU16LE(data, SCALAR_OFFSETS.base_fee_bps) : null;

      const bin_step_bps =
        SCALAR_OFFSETS.bin_step_bps != null ? readU16LE(data, SCALAR_OFFSETS.bin_step_bps) : null;

      const paused_bits =
        SCALAR_OFFSETS.paused_bits != null
          ? readU32LE(data, SCALAR_OFFSETS.paused_bits)
          : null;

      const active_bin =
        SCALAR_OFFSETS.active_bin != null ? readI32LE(data, SCALAR_OFFSETS.active_bin) : null;

      const initial_bin =
        SCALAR_OFFSETS.initial_bin != null ? readI32LE(data, SCALAR_OFFSETS.initial_bin) : null;

      // sanity: don’t write garbage pubkeys
      const patch: Partial<DexPoolRow> = {
        base_vault: isLikelyPubkey(baseVault) ? baseVault : null,
        quote_vault: isLikelyPubkey(quoteVault) ? quoteVault : null,
        lp_mint: isLikelyPubkey(lpMint) ? lpMint : null,

        // only if present & sane
        base_fee_bps: base_fee_bps != null ? base_fee_bps : null,
        bin_step_bps: bin_step_bps != null ? bin_step_bps : null,
        paused_bits: paused_bits != null ? paused_bits : null,
        active_bin: active_bin != null ? active_bin : null,
        initial_bin: initial_bin != null ? initial_bin : null,
      };

      const safeUpdate = onlyNullUpdates(row, patch);

      if (Object.keys(safeUpdate).length === 0) {
        skipped++;
        continue;
      }

      updates.push({ pool: poolPk, ...safeUpdate });
    }

    // 4) write updates (upsert)
    if (updates.length) {
    for (const u of updates) {
    const { pool, ...patch } = u;

    const { error: updErr } = await supa
        .from("dex_pools")
        .update(patch)
        .eq("pool", pool);

    if (updErr) {
        throw new Error(
        `[pool_backfill] update failed for pool ${pool}: ${updErr.message}`
        );
    }
    }

      updated += updates.length;
      console.log(`[pool_backfill] batch ${bi + 1}/${batches.length}: updated=${updates.length}`);
    } else {
      console.log(`[pool_backfill] batch ${bi + 1}/${batches.length}: no updates`);
    }
  }

  console.log("[pool_backfill] done", {
    updated,
    skipped,
    missingAcc,
  });

  console.log(
    "[pool_backfill] NOTE: if base_vault/quote_vault look wrong, adjust FIELD_INDEX.baseVault / quoteVault and rerun (safe)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});