/**
 * NFT Staking Utilities
 *
 * Provides helper functions for querying NFT stake status and deriving PDAs
 * for the Cipher NFT Staking program.
 */

import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { connection } from "../solana.js";
import type { CipherNftStaking } from "../idl/cipher_nft_staking.js";
import cipherNftStakingIdl from "../idl/cipher_nft_staking.json" with { type: "json" };

const { Program: AnchorProgram, AnchorProvider } = anchor;

const NFT_STAKING_PROGRAM_ID = new PublicKey("7dMir6E96FwiYQQ9mdsL6AKUmgzzrERwqj7mkhthxQgV");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/**
 * Get program instance
 */
function getProgram(userPubkey: PublicKey): Program<CipherNftStaking> {
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: userPubkey,
      signAllTransactions: async (txs) => txs,
      signTransaction: async (tx) => tx,
    },
    { commitment: "confirmed" }
  );

  return new AnchorProgram(cipherNftStakingIdl as CipherNftStaking, provider);
}

/**
 * Derive global config PDA
 */
export function deriveConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    NFT_STAKING_PROGRAM_ID
  );
}

/**
 * Derive collection config PDA
 */
export function deriveCollectionConfigPda(collection: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collection"), collection.toBuffer()],
    NFT_STAKING_PROGRAM_ID
  );
}

/**
 * Derive stake account PDA
 */
export function deriveStakeAccountPda(
  nftMint: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), nftMint.toBuffer(), owner.toBuffer()],
    NFT_STAKING_PROGRAM_ID
  );
}

/**
 * Derive escrow authority PDA (per-user)
 */
export function deriveEscrowAuthorityPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_authority"), owner.toBuffer()],
    NFT_STAKING_PROGRAM_ID
  );
}

/**
 * Derive NFT metadata PDA
 */
export function deriveMetadataPda(nftMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), nftMint.toBuffer()],
    METADATA_PROGRAM_ID
  );
}


/**
 * Get NFT stake status
 */
export async function getNftStakeStatus(params: {
  nftMint: string;
  owner: string;
}): Promise<{
  isStaked: boolean;
  stakeAccount?: string;
  unlockAt?: number;
  status?: "active" | "unlocked";
} | null> {
  try {
    const nftMint = new PublicKey(params.nftMint);
    const owner = new PublicKey(params.owner);
    const program = getProgram(owner);

    const [stakeAccountPda] = deriveStakeAccountPda(nftMint, owner);

    const stakeAccount = await program.account.stakeAccount.fetch(stakeAccountPda);

    const now = Math.floor(Date.now() / 1000);
    const unlockAt = stakeAccount.unlockAt.toNumber();
    const isUnlocked = now >= unlockAt;

    return {
      isStaked: stakeAccount.isActive,
      stakeAccount: stakeAccountPda.toBase58(),
      unlockAt,
      status: isUnlocked ? "unlocked" : "active",
    };
  } catch (error) {
    return null;
  }
}
