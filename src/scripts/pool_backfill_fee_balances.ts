import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout } from "@solana/spl-token";

type Row = {
  pool: string;
  creator_fee_vault: string | null;
  holders_fee_vault: string | null;
  nft_fee_vault: string | null;

  creator_fee_ui: string | number | null;
  holders_fee_ui: string | number | null;
  nft_fee_ui: string | number | null;
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
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function decodeTokenAccount(data: Buffer | Uint8Array): { mint: string; amountRaw: bigint } | null {
  try {
    const acc = AccountLayout.decode(data);
    const mint = new PublicKey(acc.mint).toBase58();
    const amountRaw = acc.amount as unknown as bigint;
    return { mint, amountRaw };
  } catch {
    return null;
  }
}

async function fetchMintDecimals(conn: Connection, mints: string[]): Promise<Map<string, number>> {
  const uniq = Array.from(new Set(mints)).filter(Boolean);
  const out = new Map<string, number>();
  if (uniq.length === 0) return out;

  const keys = uniq.map((m) => new PublicKey(m));
  for (const b of chunk(keys, 100)) {
    const infos = await conn.getMultipleAccountsInfo(b, "processed");
    for (let i = 0; i < b.length; i++) {
      const mintPk = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;
      try {
        const mint = MintLayout.decode(info.data);
        out.set(mintPk, Number(mint.decimals));
      } catch {}
    }
  }
  return out;
}

function toUi(raw: bigint, decimals: number): number {
  const denom = 10 ** decimals;
  const ui = Number(raw) / denom;
  return Number.isFinite(ui) ? ui : 0;
}

async function readVaultUiMap(conn: Connection, vaults: string[]): Promise<Map<string, number>> {
  const uniq = Array.from(new Set(vaults)).filter(Boolean);
  const out = new Map<string, number>();
  if (uniq.length === 0) return out;

  const keys = uniq.map((v) => new PublicKey(v));
  const mintByVault = new Map<string, string>();
  const rawByVault = new Map<string, bigint>();
  const discoveredMints: string[] = [];

  for (const b of chunk(keys, 100)) {
    const infos = await conn.getMultipleAccountsInfo(b, "processed");
    for (let i = 0; i < b.length; i++) {
      const vaultPk = b[i]!.toBase58();
      const info = infos[i];
      if (!info?.data) continue;

      const dec = decodeTokenAccount(info.data);
      if (!dec) continue;

      mintByVault.set(vaultPk, dec.mint);
      rawByVault.set(vaultPk, dec.amountRaw);
      discoveredMints.push(dec.mint);
    }
  }

  const decMap = await fetchMintDecimals(conn, discoveredMints);

  for (const [vaultPk, raw] of rawByVault.entries()) {
    const mint = mintByVault.get(vaultPk);
    const dec = mint ? decMap.get(mint) : undefined;
    out.set(vaultPk, dec == null ? 0 : toUi(raw, dec));
  }

  return out;
}

function num0(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SOLANA_RPC_URL = mustEnv("SOLANA_RPC_URL");

  const BATCH = clampInt(Number(process.env.FEE_BAL_BACKFILL_BATCH ?? 50), 1, 250);
  const DELAY_MS = clampInt(Number(process.env.FEE_BAL_BACKFILL_DELAY_MS ?? 150), 0, 5000);
  const DRY_RUN = parseBoolEnv("FEE_BAL_BACKFILL_DRY_RUN", false);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const conn = new Connection(SOLANA_RPC_URL, {
    commitment: "processed",
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 10_000,
  });

  console.log("[fee_bal_backfill] rpc =", SOLANA_RPC_URL);
  console.log("[fee_bal_backfill] batch =", BATCH);
  console.log("[fee_bal_backfill] delay_ms =", DELAY_MS);
  console.log("[fee_bal_backfill] dry_run =", DRY_RUN);

  const { data, error } = await supa
    .from("dex_pools")
    .select(
      [
        "pool",
        "creator_fee_vault",
        "holders_fee_vault",
        "nft_fee_vault",
        "creator_fee_ui",
        "holders_fee_ui",
        "nft_fee_ui",
      ].join(",")
    );

  if (error) throw new Error(`[fee_bal_backfill] select failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  console.log("[fee_bal_backfill] dex_pools rows =", rows.length);
  if (!rows.length) return;

  // Read all vault balances in big batches (fast)
  const allVaults: string[] = [];
  for (const r of rows) {
    if (r.creator_fee_vault) allVaults.push(r.creator_fee_vault);
    if (r.holders_fee_vault) allVaults.push(r.holders_fee_vault);
    if (r.nft_fee_vault) allVaults.push(r.nft_fee_vault);
  }

  const uiByVault = await readVaultUiMap(conn, allVaults);

  let updated = 0;
  let skipped = 0;

  const nowIso = new Date().toISOString();

  const updates = rows.map((r) => {
    const creator = r.creator_fee_vault ? uiByVault.get(r.creator_fee_vault) ?? 0 : 0;
    const holders = r.holders_fee_vault ? uiByVault.get(r.holders_fee_vault) ?? 0 : 0;
    const nft = r.nft_fee_vault ? uiByVault.get(r.nft_fee_vault) ?? 0 : 0;

    const curC = num0(r.creator_fee_ui);
    const curH = num0(r.holders_fee_ui);
    const curN = num0(r.nft_fee_ui);

    // only write if something changed (avoid noisy updates)
    const changed = creator !== curC || holders !== curH || nft !== curN;

    return { pool: r.pool, creator, holders, nft, changed };
  });

  // write in batches (upsert style via update-per-row is fine for 6 pools; batching is fine too)
  for (const b of chunk(updates, BATCH)) {
    const changed = b.filter((x) => x.changed);

    if (changed.length === 0) {
      skipped += b.length;
      console.log(`[fee_bal_backfill] batch: no changes (${b.length} rows)`);
      if (DELAY_MS) await sleep(DELAY_MS);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[fee_bal_backfill] DRY_RUN would_update=${changed.length}`);
      if (DELAY_MS) await sleep(DELAY_MS);
      continue;
    }

    for (const u of changed) {
      const patch = {
        creator_fee_ui: u.creator,
        holders_fee_ui: u.holders,
        nft_fee_ui: u.nft,
        fees_updated_at: nowIso,
        updated_at: nowIso,
      };

      const { error: updErr } = await supa.from("dex_pools").update(patch).eq("pool", u.pool);
      if (updErr) throw new Error(`[fee_bal_backfill] update failed for ${u.pool}: ${updErr.message}`);
      updated++;
    }

    console.log(`[fee_bal_backfill] batch: updated=${changed.length}`);
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log("[fee_bal_backfill] done", { updated, skipped, dryRun: DRY_RUN });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});