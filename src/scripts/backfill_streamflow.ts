#!/usr/bin/env node
import "dotenv/config";

import { Connection, PublicKey } from "@solana/web3.js";

const RPC =
  process.env.RPC ??
  "https://cipherw-solanam-01bf.mainnet.rpcpool.com/2892e67a-5440-42fe-8ec5-8f663d35127a";

const STREAMFLOW_VAULT_OR_ACCOUNT = new PublicKey(
  process.env.VAULT ?? "Fh7u35PsxFWBWNE5Pme2yffixJ5H7YocAymJHs6L73N"
);

const STREAMFLOW_STAKE_PROGRAM_ID = new PublicKey(
  process.env.STAKE_PROGRAM ?? "STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH"
);

const CIPHER_MINT = new PublicKey(
  process.env.MINT ?? "Ciphern9cCXtms66s8Mm6wCFC27b2JProRQLYmiLMH3N"
);

const DECIMALS = Number(process.env.DECIMALS ?? 9);

// Controls
const SIG_PAGE_SIZE = Number(process.env.SIG_PAGE_SIZE ?? 1000);
const TX_BATCH = Number(process.env.TX_BATCH ?? 10);
const UPSERT_BATCH = Number(process.env.UPSERT_BATCH ?? 500);

// Either set VAULT_ID directly, or we’ll look it up by scan_address
const VAULT_ID = process.env.VAULT_ID ? Number(process.env.VAULT_ID) : null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function bigFromTokenAmountString(amountStr: unknown): bigint {
  if (!amountStr || typeof amountStr !== "string") return 0n;
  return BigInt(amountStr);
}

function txTouchesStreamflowStake(tx: any) {
  const prog = STREAMFLOW_STAKE_PROGRAM_ID.toBase58();
  const logs: string[] = tx?.meta?.logMessages ?? [];
  for (const line of logs) {
    if (typeof line === "string" && line.includes(`Program ${prog} `)) return true;
  }
  return false;
}

function accumulateCipherDeltasByOwner(tx: any, ownerToDelta: Map<string, bigint>) {
  const mint = CIPHER_MINT.toBase58();
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];

  const preMap = new Map<number, { owner: string | null; amt: bigint }>();
  for (const b of pre) {
    if (b?.mint !== mint) continue;
    preMap.set(Number(b?.accountIndex ?? -1), {
      owner: (b?.owner ?? null) as string | null,
      amt: bigFromTokenAmountString(b?.uiTokenAmount?.amount),
    });
  }

  const postMap = new Map<number, { owner: string | null; amt: bigint }>();
  for (const b of post) {
    if (b?.mint !== mint) continue;
    postMap.set(Number(b?.accountIndex ?? -1), {
      owner: (b?.owner ?? null) as string | null,
      amt: bigFromTokenAmountString(b?.uiTokenAmount?.amount),
    });
  }

  const indices = new Set<number>([...preMap.keys(), ...postMap.keys()]);
  for (const idx of indices) {
    const a = preMap.get(idx);
    const b = postMap.get(idx);

    const owner = (b?.owner ?? a?.owner) ?? null;
    if (!owner) continue;

    const preAmt = a?.amt ?? 0n;
    const postAmt = b?.amt ?? 0n;

    const delta = postAmt - preAmt; // post - pre
    if (delta === 0n) continue;

    const stakedChange = -delta; // EXACT stake.json behavior
    ownerToDelta.set(owner, (ownerToDelta.get(owner) ?? 0n) + stakedChange);
  }
}

async function getSupa() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const m = await import("@supabase/supabase-js");
  return m.createClient(url, key, { auth: { persistSession: false } });
}

async function resolveVaultId(supa: any): Promise<number> {
  if (VAULT_ID) return VAULT_ID;

  const scan = STREAMFLOW_VAULT_OR_ACCOUNT.toBase58();
  const { data, error } = await supa
    .from("streamflow_vaults")
    .select("id")
    .eq("scan_address", scan)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error(`Could not find streamflow_vaults row for scan_address=${scan}. Set VAULT_ID.`);
  return Number(data.id);
}

async function replaceSnapshotInDb(opts: {
  vaultId: number;
  rows: Array<{ owner: string; staked_raw: string }>;
  holdersCount: string;
  totalStakedRaw: string;
}) {
  const supa = await getSupa();
  const nowIso = new Date().toISOString();

  // 1) delete existing for vault
  {
    const { error } = await supa.from("streamflow_stakes").delete().eq("vault_id", opts.vaultId);
    if (error) throw error;
  }

  // 2) upsert new snapshot (batched)
  for (let i = 0; i < opts.rows.length; i += UPSERT_BATCH) {
    const chunk = opts.rows.slice(i, i + UPSERT_BATCH).map((r) => ({
      vault_id: opts.vaultId,
      owner: r.owner,
      staked_raw: r.staked_raw, // numeric: send as string
      updated_at: nowIso,
    }));

    const { error } = await supa
      .from("streamflow_stakes")
      .upsert(chunk, { onConflict: "vault_id,owner" });

    if (error) throw error;
  }

  // 3) update totals on vault row
  {
    const { error } = await supa
      .from("streamflow_vaults")
      .update({
        holders_count: opts.holdersCount,
        total_staked_raw: opts.totalStakedRaw,
        updated_at: nowIso,
      })
      .eq("id", opts.vaultId);

    if (error) throw error;
  }
}

async function main() {
  const connection = new Connection(RPC, {
    commitment: "finalized",
    disableRetryOnRateLimit: false,
  });

  console.log("RPC:", RPC);
  console.log("Scan address:", STREAMFLOW_VAULT_OR_ACCOUNT.toBase58());
  console.log("Stake program:", STREAMFLOW_STAKE_PROGRAM_ID.toBase58());
  console.log("Mint:", CIPHER_MINT.toBase58());
  console.log("Decimals:", DECIMALS);

  // 1) fetch ALL signatures for the address
  const allSigs: Array<{ signature: string }> = [];
  let before: string | undefined;

  for (;;) {
    const batch = await connection.getSignaturesForAddress(STREAMFLOW_VAULT_OR_ACCOUNT, {
      limit: SIG_PAGE_SIZE,
      before,
    });

    if (!batch.length) break;

    allSigs.push(...batch.filter((x) => !!x.signature).map((x) => ({ signature: x.signature! })));
    before = batch[batch.length - 1]!.signature!;

    console.log(`signatures: +${batch.length} (total ${allSigs.length})`);
    await sleep(150);
  }

  console.log(`Total signatures fetched: ${allSigs.length}`);

  // 2) fetch transactions & aggregate
  const ownerToStakedRaw = new Map<string, bigint>();
  let scanned = 0;
  let used = 0;
  let missing = 0;

  const sigs = allSigs.map((s) => s.signature);

  for (let i = 0; i < sigs.length; i += TX_BATCH) {
    const chunk = sigs.slice(i, i + TX_BATCH);

    const txs = await Promise.all(
      chunk.map(async (sig) => {
        try {
          const tx = await connection.getTransaction(sig, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          });
          return { sig, tx };
        } catch {
          return { sig, tx: null };
        }
      })
    );

    for (const { tx } of txs) {
      scanned++;
      if (!tx) {
        missing++;
        continue;
      }
      if (!txTouchesStreamflowStake(tx)) continue;

      used++;
      accumulateCipherDeltasByOwner(tx, ownerToStakedRaw);
    }

    if ((i / TX_BATCH) % 20 === 0) {
      console.log(
        `progress: ${Math.min(i + TX_BATCH, sigs.length)}/${sigs.length} | scanned=${scanned} used=${used} missing=${missing} | owners=${ownerToStakedRaw.size}`
      );
    }

    await sleep(120);
  }

  // 3) Build rows EXACTLY like stake.json output
  const rows: Array<{ owner: string; staked_raw: string }> = [];
  let totalRaw = 0n;

  for (const [owner, raw] of ownerToStakedRaw.entries()) {
    if (raw <= 0n) continue; // exact stake.json behavior
    totalRaw += raw;
    rows.push({ owner, staked_raw: raw.toString() });
  }

  rows.sort((a, b) => {
    const ar = BigInt(a.staked_raw);
    const br = BigInt(b.staked_raw);
    return br > ar ? 1 : br < ar ? -1 : 0;
  });

  console.log("Computed owners:", rows.length);
  console.log("Computed totalRaw:", totalRaw.toString());

  // 4) push snapshot to DB
  const supa = await getSupa();
  const vaultId = await resolveVaultId(supa);

  console.log("DB vault_id:", vaultId);

  await replaceSnapshotInDb({
    vaultId,
    rows,
    holdersCount: String(rows.length),       // if your column is numeric/text, string is safest
    totalStakedRaw: totalRaw.toString(),
  });

  console.log("✅ DB snapshot replaced");
  console.log("stats:", { signatures: sigs.length, scanned, used, missing });
}

main().catch((e) => {
  console.error("fatal:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});