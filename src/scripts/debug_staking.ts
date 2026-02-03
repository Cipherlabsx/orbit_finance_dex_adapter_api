#!/usr/bin/env node
import "dotenv/config";

const OWNER = process.argv[2];
if (!OWNER) {
  console.error("Usage: tsx src/scripts/debug_staking.ts <WALLET_ADDRESS>");
  process.exit(1);
}

async function getSupa() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const m = await import("@supabase/supabase-js");
  return m.createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const supa = await getSupa();

  console.log("Wallet:", OWNER);
  console.log("=" .repeat(80));

  // 1. Check current balance
  const { data: stakes, error: stakesError } = await supa
    .from("streamflow_stakes")
    .select("vault_id, staked_raw")
    .eq("owner", OWNER);

  if (stakesError) throw stakesError;

  console.log("\nCurrent Stakes:");
  for (const s of stakes ?? []) {
    const raw = BigInt((s as any).staked_raw);
    const ui = Number(raw) / 1e9;
    console.log(`  Vault ${(s as any).vault_id}: ${raw} raw = ${ui.toFixed(4)} CIPHER`);
  }

  // 2. Get all events
  const { data: events, error: eventsError } = await supa
    .from("streamflow_events")
    .select("vault_id, signature, block_time, slot, delta_raw, balance_after_raw")
    .eq("owner", OWNER)
    .order("block_time", { ascending: true });

  if (eventsError) throw eventsError;

  console.log(`\nTotal Events: ${events?.length ?? 0}`);

  // 3. Check for duplicate signatures
  const sigCount = new Map<string, number>();
  for (const e of events ?? []) {
    const sig = (e as any).signature;
    sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
  }

  const duplicates = Array.from(sigCount.entries()).filter(([_, count]) => count > 1);
  if (duplicates.length > 0) {
    console.log("\n⚠️  DUPLICATE SIGNATURES FOUND:");
    for (const [sig, count] of duplicates) {
      console.log(`  ${sig}: ${count} times`);
    }
  } else {
    console.log("\n✓ No duplicate signatures");
  }

  // 4. Replay events to verify balance
  console.log("\nEvent History:");
  const replayBalance = new Map<number, bigint>();

  for (const e of events ?? []) {
    const vaultId = Number((e as any).vault_id);
    const sig = String((e as any).signature).slice(0, 16) + "...";
    const delta = BigInt((e as any).delta_raw);
    const balanceAfter = BigInt((e as any).balance_after_raw);
    const slot = Number((e as any).slot);

    const before = replayBalance.get(vaultId) ?? 0n;
    const computed = before + delta;

    replayBalance.set(vaultId, computed);

    const match = computed === balanceAfter ? "✓" : "✗ MISMATCH";
    console.log(
      `  [${slot}] ${sig} | delta: ${delta > 0n ? "+" : ""}${delta} | computed: ${computed} | expected: ${balanceAfter} ${match}`
    );
  }

  // 5. Compare final balance
  console.log("\nFinal Balance Comparison:");
  for (const [vaultId, computed] of replayBalance.entries()) {
    const dbStake = stakes?.find((s: any) => s.vault_id === vaultId);
    const dbRaw = dbStake ? BigInt((dbStake as any).staked_raw) : 0n;

    const match = computed === dbRaw ? "✓" : "✗ MISMATCH";
    console.log(`  Vault ${vaultId}:`);
    console.log(`    Computed from events: ${computed} raw = ${Number(computed) / 1e9} CIPHER`);
    console.log(`    Database stakes:      ${dbRaw} raw = ${Number(dbRaw) / 1e9} CIPHER ${match}`);
  }
}

main().catch((e) => {
  console.error("Error:", e.message ?? e);
  process.exit(1);
});
