/**
 * NFT Staking Realtime Indexer
 *
 * Listens for NFT staking events from the Cipher NFT Staking program and
 * maintains the nft_stakes table with current stake positions.
 *
 * Events handled:
 * - NftStaked: Creates new stake record
 * - NftUnstaked: Marks stake as withdrawn
 * - RewardsClaimed: Updates rewards_claimed amount
 */

import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import { supabase } from "../supabase.js";

// NFT Staking Program ID
const NFT_STAKING_PROGRAM_ID = "7dMir6E96FwiYQQ9mdsL6AKUmgzzrERwqj7mkhthxQgV";

type NftStakeEvent = NftStakedEvent | NftUnstakedEvent | RewardsClaimedEvent;

type NftStakedEvent = {
  name: "NftStaked";
  data: {
    staker: string;
    nftMint: string;
    collection: string;
    stakedAt: number; // i64 unix timestamp
    unlockAt: number; // i64 unix timestamp
    lockDuration: number; // i64 seconds
    stakeAccount: string;
  };
};

type NftUnstakedEvent = {
  name: "NftUnstaked";
  data: {
    staker: string;
    nftMint: string;
    unstakedAt: number; // i64 unix timestamp
    totalStakedDuration: number; // i64 seconds
    rewardsEarned: number; // u64
  };
};

type RewardsClaimedEvent = {
  name: "RewardsClaimed";
  data: {
    staker: string;
    nftMint: string;
    amount: number; // u64
    claimedAt: number; // i64 unix timestamp
  };
};

type TransactionMetadata = {
  signature: string;
  blockTime: number | null;
  slot: number;
};

/**
 * Check if transaction involves the NFT staking program
 */
export function txTouchesNftStaking(tx: VersionedTransactionResponse): boolean {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  for (const line of logs) {
    if (typeof line === "string" && line.includes(`Program ${NFT_STAKING_PROGRAM_ID} `)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract NFT staking events from transaction logs
 *
 * Events are emitted as base64-encoded data following "Program data:" prefix
 */
export function extractNftStakingEvents(tx: VersionedTransactionResponse): NftStakeEvent[] {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  const events: NftStakeEvent[] = [];

  for (const line of logs) {
    if (!line.includes("Program data: ")) continue;

    try {
      const parts = line.split("Program data: ");
      if (parts.length < 2) continue;

      const base64Data = parts[1].trim();
      const buffer = Buffer.from(base64Data, "base64");

      // First 8 bytes are the discriminator (event name hash)
      if (buffer.length < 8) continue;

      const discriminator = buffer.subarray(0, 8);
      const data = buffer.subarray(8);

      // Match discriminator to event type from IDL
      // NftStaked: [150, 229, 155, 99, 88, 181, 254, 61]
      // NftUnstaked: [253, 242, 47, 131, 231, 214, 72, 117]
      // RewardsClaimed: [75, 98, 88, 18, 219, 112, 88, 121]

      if (matchesDiscriminator(discriminator, [150, 229, 155, 99, 88, 181, 254, 61])) {
        const event = parseNftStakedEvent(data);
        if (event) events.push(event);
      } else if (matchesDiscriminator(discriminator, [253, 242, 47, 131, 231, 214, 72, 117])) {
        const event = parseNftUnstakedEvent(data);
        if (event) events.push(event);
      } else if (matchesDiscriminator(discriminator, [75, 98, 88, 18, 219, 112, 88, 121])) {
        const event = parseRewardsClaimedEvent(data);
        if (event) events.push(event);
      }
    } catch (err) {
      console.error("Failed to parse NFT staking event:", err);
    }
  }

  return events;
}

function matchesDiscriminator(disc: Buffer, expected: number[]): boolean {
  if (disc.length !== 8 || expected.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    if (disc[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Parse NftStaked event from borsh-encoded data
 * struct NftStaked { staker: Pubkey, nft_mint: Pubkey, collection: Pubkey,
 *   staked_at: i64, unlock_at: i64, lock_duration: i64, stake_account: Pubkey }
 */
function parseNftStakedEvent(data: Buffer): NftStakedEvent | null {
  try {
    if (data.length < 152) return null;
    let offset = 0;
    const staker = data.subarray(offset, offset + 32); offset += 32;
    const nftMint = data.subarray(offset, offset + 32); offset += 32;
    const collection = data.subarray(offset, offset + 32); offset += 32;
    const stakedAt = data.readBigInt64LE(offset); offset += 8;
    const unlockAt = data.readBigInt64LE(offset); offset += 8;
    const lockDuration = data.readBigInt64LE(offset); offset += 8;
    const stakeAccount = data.subarray(offset, offset + 32);

    const { PublicKey } = require("@solana/web3.js");
    return {
      name: "NftStaked",
      data: {
        staker: new PublicKey(staker).toBase58(),
        nftMint: new PublicKey(nftMint).toBase58(),
        collection: new PublicKey(collection).toBase58(),
        stakedAt: Number(stakedAt),
        unlockAt: Number(unlockAt),
        lockDuration: Number(lockDuration),
        stakeAccount: new PublicKey(stakeAccount).toBase58(),
      },
    };
  } catch (err) {
    console.error("Failed to parse NftStaked event:", err);
    return null;
  }
}

/**
 * Parse NftUnstaked event from borsh-encoded data
 * struct NftUnstaked { staker: Pubkey, nft_mint: Pubkey, unstaked_at: i64,
 *   total_staked_duration: i64, rewards_earned: u64 }
 */
function parseNftUnstakedEvent(data: Buffer): NftUnstakedEvent | null {
  try {
    if (data.length < 88) return null;
    let offset = 0;
    const staker = data.subarray(offset, offset + 32); offset += 32;
    const nftMint = data.subarray(offset, offset + 32); offset += 32;
    const unstakedAt = data.readBigInt64LE(offset); offset += 8;
    const totalStakedDuration = data.readBigInt64LE(offset); offset += 8;
    const rewardsEarned = data.readBigUInt64LE(offset);

    const { PublicKey } = require("@solana/web3.js");
    return {
      name: "NftUnstaked",
      data: {
        staker: new PublicKey(staker).toBase58(),
        nftMint: new PublicKey(nftMint).toBase58(),
        unstakedAt: Number(unstakedAt),
        totalStakedDuration: Number(totalStakedDuration),
        rewardsEarned: Number(rewardsEarned),
      },
    };
  } catch (err) {
    console.error("Failed to parse NftUnstaked event:", err);
    return null;
  }
}

/**
 * Parse RewardsClaimed event from borsh-encoded data
 * struct RewardsClaimed { staker: Pubkey, nft_mint: Pubkey, amount: u64, claimed_at: i64 }
 */
function parseRewardsClaimedEvent(data: Buffer): RewardsClaimedEvent | null {
  try {
    if (data.length < 80) return null;
    let offset = 0;
    const staker = data.subarray(offset, offset + 32); offset += 32;
    const nftMint = data.subarray(offset, offset + 32); offset += 32;
    const amount = data.readBigUInt64LE(offset); offset += 8;
    const claimedAt = data.readBigInt64LE(offset);

    const { PublicKey } = require("@solana/web3.js");
    return {
      name: "RewardsClaimed",
      data: {
        staker: new PublicKey(staker).toBase58(),
        nftMint: new PublicKey(nftMint).toBase58(),
        amount: Number(amount),
        claimedAt: Number(claimedAt),
      },
    };
  } catch (err) {
    console.error("Failed to parse RewardsClaimed event:", err);
    return null;
  }
}

/**
 * Handle NftStaked event
 */
async function handleNftStaked(
  event: NftStakedEvent,
  metadata: TransactionMetadata
): Promise<void> {
  const { staker, nftMint, collection, stakedAt, unlockAt, lockDuration, stakeAccount } = event.data;

  const { error } = await supabase.from("nft_stakes").insert({
    nft_mint: nftMint,
    owner_wallet: staker,
    staked_at: new Date(stakedAt * 1000).toISOString(),
    unlock_at: new Date(unlockAt * 1000).toISOString(),
    lock_duration_seconds: lockDuration,
    status: "active",
    escrow_pda: stakeAccount,
    stake_signature: metadata.signature,
    nft_collection: collection,
    // Note: reward_tier and reward_multiplier can be set based on collection rules
    reward_tier: "standard",
    reward_multiplier: 1.0,
  });

  if (error) {
    console.error("Failed to insert nft_stake:", error);
    throw error;
  }

  console.log(`[NFT_STAKING] NFT staked: ${nftMint} by ${staker}`);
}

/**
 * Handle NftUnstaked event
 */
async function handleNftUnstaked(
  event: NftUnstakedEvent,
  metadata: TransactionMetadata
): Promise<void> {
  const { staker, nftMint, unstakedAt, rewardsEarned } = event.data;

  const { error } = await supabase
    .from("nft_stakes")
    .update({
      status: "withdrawn",
      withdraw_signature: metadata.signature,
      rewards_claimed: rewardsEarned.toString(),
      updated_at: new Date().toISOString(),
    })
    .eq("nft_mint", nftMint)
    .eq("owner_wallet", staker)
    .eq("status", "active");

  if (error) {
    console.error("Failed to update nft_stake on unstake:", error);
    throw error;
  }

  console.log(`[NFT_STAKING] NFT unstaked: ${nftMint} by ${staker}`);
}

/**
 * Handle RewardsClaimed event
 */
async function handleRewardsClaimed(
  event: RewardsClaimedEvent,
  metadata: TransactionMetadata
): Promise<void> {
  const { staker, nftMint, amount, claimedAt } = event.data;

  // Increment rewards_claimed and update last_claim_at
  const { data: existing, error: fetchError } = await supabase
    .from("nft_stakes")
    .select("rewards_claimed")
    .eq("nft_mint", nftMint)
    .eq("owner_wallet", staker)
    .eq("status", "active")
    .single();

  if (fetchError || !existing) {
    console.error("Failed to fetch existing stake for reward claim:", fetchError);
    return;
  }

  const previousClaimed = parseFloat(existing.rewards_claimed || "0");
  const newTotal = previousClaimed + amount;

  const { error } = await supabase
    .from("nft_stakes")
    .update({
      rewards_claimed: newTotal.toString(),
      last_claim_at: new Date(claimedAt * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("nft_mint", nftMint)
    .eq("owner_wallet", staker)
    .eq("status", "active");

  if (error) {
    console.error("Failed to update rewards_claimed:", error);
    throw error;
  }

  console.log(`[NFT_STAKING] Rewards claimed: ${amount} for ${nftMint} by ${staker}`);
}

/**
 * Process NFT staking transaction
 *
 * Extracts events and updates database accordingly
 */
export async function processNftStakingTransaction(
  tx: VersionedTransactionResponse
): Promise<void> {
  if (!tx.meta?.err && tx.blockTime) {
    const metadata: TransactionMetadata = {
      signature: tx.transaction.signatures[0],
      blockTime: tx.blockTime,
      slot: tx.slot,
    };

    const events = extractNftStakingEvents(tx);

    for (const event of events) {
      try {
        switch (event.name) {
          case "NftStaked":
            await handleNftStaked(event, metadata);
            break;
          case "NftUnstaked":
            await handleNftUnstaked(event, metadata);
            break;
          case "RewardsClaimed":
            await handleRewardsClaimed(event, metadata);
            break;
          default:
            console.warn("Unknown NFT staking event:", (event as any).name);
        }
      } catch (err) {
        console.error(`Failed to process event ${event.name}:`, err);
        // Continue processing other events
      }
    }
  }
}

/**
 * Start listening for NFT staking transactions
 */
export async function startNftStakingIndexer(connection: Connection): Promise<number> {
  console.log("[NFT_STAKING] Starting NFT Staking indexer...");
  console.log(`[NFT_STAKING] Program ID: ${NFT_STAKING_PROGRAM_ID}`);

  const programPubkey = new (await import("@solana/web3.js")).PublicKey(NFT_STAKING_PROGRAM_ID);

  const subscriptionId = connection.onLogs(
    programPubkey,
    async (logs, context) => {
      try {
        // Fetch full transaction
        const tx = await connection.getTransaction(logs.signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });

        if (tx) {
          await processNftStakingTransaction(tx);
        }
      } catch (err) {
        console.error("Error processing NFT staking transaction:", err);
      }
    },
    "finalized"
  );

  console.log("[NFT_STAKING] NFT Staking indexer started (subscription:", subscriptionId, ")");
  return subscriptionId;
}

/**
 * Check for expired stakes and update their status
 *
 * Run this periodically (e.g., every 5 minutes) to mark stakes
 * that have reached unlock_at but haven't been withdrawn yet
 */
export async function markExpiredStakes(): Promise<void> {
  const { data, error } = await supabase
    .from("nft_stakes")
    .update({ status: "unlocked" })
    .eq("status", "active")
    .lt("unlock_at", new Date().toISOString())
    .select();

  if (error) {
    console.error("Failed to mark expired stakes:", error);
    return;
  }

  if (data && data.length > 0) {
    console.log(`[NFT_STAKING] Marked ${data.length} stakes as unlocked`);
  }
}
