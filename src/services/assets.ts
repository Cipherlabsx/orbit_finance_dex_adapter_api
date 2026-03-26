import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { connection, pk } from "../solana.js";
import { dbGetToken } from "./token_registry.js";

const TOKEN_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/**
 * Parse a Borsh-encoded string from a buffer at the given offset.
 * Metaplex metadata strings are u32-prefixed and null-padded.
 */
function readBorshString(buf: Buffer, offset: number): { value: string; nextOffset: number } {
  if (offset + 4 > buf.length) return { value: "", nextOffset: offset };
  const len = buf.readUInt32LE(offset);
  const end = offset + 4 + len;
  if (end > buf.length) return { value: "", nextOffset: offset };
  const value = buf.subarray(offset + 4, end).toString("utf8").replace(/\0/g, "").trim();
  return { value, nextOffset: end };
}

/**
 * Derive and fetch Metaplex token metadata for a mint.
 * Returns null if the metadata account doesn't exist.
 * Layout: 1 (key) + 32 (update_authority) + 32 (mint) = 65 bytes header, then name, then symbol.
 */
async function fetchMetaplexMetadata(mintPk: PublicKey): Promise<{ name: string; symbol: string } | null> {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
    TOKEN_METADATA_PROGRAM
  );

  const info = await connection.getAccountInfo(metadataPda, "confirmed");
  if (!info?.data || info.data.length < 69) return null;

  const buf = Buffer.from(info.data);
  const nameResult = readBorshString(buf, 65);
  const symbolResult = readBorshString(buf, nameResult.nextOffset);

  return {
    name: nameResult.value,
    symbol: symbolResult.value,
  };
}

/**
 * Decimalize a bigint supply value to a string without precision loss.
 * e.g. 1_000_000_000n with decimals=6 => "1000"
 */
function decimalizeSupply(supply: bigint, decimals: number): string {
  if (decimals === 0) return supply.toString();
  const divisor = BigInt(10 ** decimals);
  const whole = supply / divisor;
  const frac = supply % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Standards Asset:
 * - id, name, symbol, decimals (required)
 * - totalSupply (needed for FDV/MarketCap on GeckoTerminal)
 * - coinGeckoId (optional, from token registry)
 *
 * Source priority for name/symbol:
 *   1. token_registry (curated, most accurate for known tokens)
 *   2. Metaplex Token Metadata PDA (on-chain, covers all SPL tokens with metadata)
 *   3. Fallback to first-6-chars of mint address
 */
export async function readAsset(id: string) {
  const mintPk = pk(id);
  const base58 = mintPk.toBase58();

  const [mint, registryToken] = await Promise.all([
    getMint(connection, mintPk, "confirmed"),
    dbGetToken(base58).catch(() => null),
  ]);

  const totalSupply = decimalizeSupply(mint.supply, mint.decimals);

  // Use registry data if available (name/symbol/coinGeckoId)
  if (registryToken?.name && registryToken?.symbol) {
    return {
      asset: {
        id: base58,
        name: registryToken.name,
        symbol: registryToken.symbol,
        decimals: mint.decimals,
        totalSupply,
        ...(registryToken.coingeckoId ? { coinGeckoId: registryToken.coingeckoId } : {}),
      },
    };
  }

  // Fall back to Metaplex on-chain metadata
  const metaplex = await fetchMetaplexMetadata(mintPk).catch(() => null);

  const fallbackName = `Token ${base58.slice(0, 6)}`;
  const fallbackSymbol = base58.slice(0, 6);

  return {
    asset: {
      id: base58,
      name: metaplex?.name || fallbackName,
      symbol: metaplex?.symbol || fallbackSymbol,
      decimals: mint.decimals,
      totalSupply,
    },
  };
}
