import bs58 from "bs58";
import { connection, PROGRAM_ID } from "../solana.js";
import { env } from "../config.js";

/**
 * Anchor account discriminator is the first 8 bytes of account data.
 * From your IDL:
 * pool discriminator = [241,154,109,4,17,177,109,188]
 */
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const POOL_DISCRIMINATOR_B58 = bs58.encode(POOL_DISCRIMINATOR);

export async function discoverPools(): Promise<string[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: POOL_DISCRIMINATOR_B58,
        },
      },
    ],
  });

  // Safety cap to avoid accidental huge indexing on bad RPC / forks
  const limited = accounts.slice(0, env.DISCOVERY_LIMIT);

  return limited.map((a) => a.pubkey.toBase58());
}