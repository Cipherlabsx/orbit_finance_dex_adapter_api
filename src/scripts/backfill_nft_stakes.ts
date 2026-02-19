/**
 * Backfill NFT Stakes
 *
 * Scans all historical transactions for the NFT Staking program
 * and populates the nft_stakes table with any missed stakes.
 *
 * Usage:
 *   tsx src/scripts/backfill_nft_stakes.ts
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { supabase } from "../supabase.js";
import {
  txTouchesNftStaking,
  extractNftStakingEvents,
  processNftStakingTransaction,
} from "../services/nft_staking_indexer.js";

const NFT_STAKING_PROGRAM_ID = "7dMir6E96FwiYQQ9mdsL6AKUmgzzrERwqj7mkhthxQgV";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function backfillNftStakes() {
  console.log("[BACKFILL] Starting NFT stakes backfill...");
  console.log(`[BACKFILL] Program ID: ${NFT_STAKING_PROGRAM_ID}`);
  console.log(`[BACKFILL] RPC: ${RPC_URL}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const programPubkey = new PublicKey(NFT_STAKING_PROGRAM_ID);

  // Fetch all signatures for the program
  console.log("[BACKFILL] Fetching all transaction signatures...");
  let allSignatures: string[] = [];
  let before: string | undefined = undefined;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    pageCount++;
    console.log(`[BACKFILL] Fetching page ${pageCount}...`);

    const sigs = await connection.getSignaturesForAddress(programPubkey, {
      before,
      limit: 1000,
    });

    if (sigs.length === 0) {
      hasMore = false;
      break;
    }

    const sigStrings = sigs.map((s) => s.signature);
    allSignatures.push(...sigStrings);

    console.log(`[BACKFILL] Page ${pageCount}: ${sigs.length} signatures (total: ${allSignatures.length})`);

    // If less than 1000, we've reached the end
    if (sigs.length < 1000) {
      hasMore = false;
    } else {
      before = sigs[sigs.length - 1].signature;
    }

    // Add delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[BACKFILL] Found ${allSignatures.length} total transactions`);

  // Process transactions in batches
  const BATCH_SIZE = 10;
  let processed = 0;
  let stakedEvents = 0;
  let unstakedEvents = 0;
  let errors = 0;

  for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
    const batch = allSignatures.slice(i, i + BATCH_SIZE);

    console.log(
      `[BACKFILL] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allSignatures.length / BATCH_SIZE)} (${i + 1}-${Math.min(i + BATCH_SIZE, allSignatures.length)}/${allSignatures.length})`
    );

    // Fetch transactions in parallel
    const txPromises = batch.map((sig) =>
      connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
    );

    const txs = await Promise.all(txPromises);

    // Process each transaction
    for (const tx of txs) {
      if (!tx) {
        errors++;
        continue;
      }

      try {
        // Check if transaction has NFT staking events
        if (txTouchesNftStaking(tx)) {
          const events = extractNftStakingEvents(tx);

          if (events.length > 0) {
            // Count event types
            for (const event of events) {
              if (event.name === "NftStaked") stakedEvents++;
              if (event.name === "NftUnstaked") unstakedEvents++;
            }

            // Process transaction (will insert/update database)
            await processNftStakingTransaction(tx);
            processed++;
          }
        }
      } catch (err) {
        console.error(`[BACKFILL] Error processing tx ${tx.transaction.signatures[0]}:`, err);
        errors++;
      }
    }

    // Rate limiting delay
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log("\n[BACKFILL] Backfill complete!");
  console.log(`[BACKFILL] Total transactions scanned: ${allSignatures.length}`);
  console.log(`[BACKFILL] Transactions with NFT staking events: ${processed}`);
  console.log(`[BACKFILL] NftStaked events: ${stakedEvents}`);
  console.log(`[BACKFILL] NftUnstaked events: ${unstakedEvents}`);
  console.log(`[BACKFILL] Errors: ${errors}`);

  // Query final state
  const { data: stakes, error } = await supabase
    .from("nft_stakes")
    .select("status")
    .order("staked_at", { ascending: false });

  if (!error && stakes) {
    const active = stakes.filter((s) => s.status === "active").length;
    const unlocked = stakes.filter((s) => s.status === "unlocked").length;
    const withdrawn = stakes.filter((s) => s.status === "withdrawn").length;

    console.log("\n[BACKFILL] Database state:");
    console.log(`[BACKFILL] Active stakes: ${active}`);
    console.log(`[BACKFILL] Unlocked stakes: ${unlocked}`);
    console.log(`[BACKFILL] Withdrawn stakes: ${withdrawn}`);
    console.log(`[BACKFILL] Total: ${stakes.length}`);
  }

  process.exit(0);
}

backfillNftStakes().catch((err) => {
  console.error("[BACKFILL] Fatal error:", err);
  process.exit(1);
});
