import { getMint } from "@solana/spl-token";
import { connection, pk } from "../solana.js";

/**
 * Standards Asset:
 * - id, name, symbol, decimals (must be non-empty)
 */
export async function readAsset(id: string) {
  const mintPk = pk(id);
  const mint = await getMint(connection, mintPk, "confirmed");

  const base58 = mintPk.toBase58();
  const short = base58.slice(0, 6);

  return {
    asset: {
      id: base58,
      name: `Token ${short}`,
      symbol: short,
      decimals: mint.decimals,
    },
  };
}