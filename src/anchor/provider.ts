import * as anchor from "@coral-xyz/anchor";

/**
 * Uses AnchorProvider.env().
 * It’s OK if ANCHOR_WALLET is not set
 * as long as you only do read-only RPC calls (fetch, getSignatures, getTransaction).
 *
 * If you want event decoding through Anchor logs in some flows, you can still set:
 *   ANCHOR_PROVIDER_URL
 *   ANCHOR_WALLET
 */
export function getProvider(): anchor.AnchorProvider {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  return provider;
}