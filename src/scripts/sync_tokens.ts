import "dotenv/config";
import fs from "fs/promises";
import { z } from "zod";
import { dbUpsertToken } from "../services/token_registry.js";

const TokenZ = z.object({
  mint: z.string().min(32).max(44),
  symbol: z.string().min(1),
  name: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
  logoUri: z.string().url().nullish(),
  description: z.string().nullish(),
  verified: z.boolean(),
  coingeckoId: z.string().nullish(),
  twitter: z.string().url().nullish(),
  website: z.string().url().nullish(),
  telegram: z.string().url().nullish(),
  discord: z.string().url().nullish(),
  instagram: z.string().url().nullish(),
  tiktok: z.string().url().nullish(),
  tags: z.array(z.string()).nullish(),
});

const TokensFileZ = z.object({
  version: z.number(),
  lastUpdated: z.string(),
  tokens: z.array(TokenZ),
});

async function main() {
  const filePath = new URL("../data/tokens.json", import.meta.url).pathname;
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = TokensFileZ.parse(JSON.parse(content));

  console.log(`Syncing ${parsed.tokens.length} tokens to database...`);

  for (const token of parsed.tokens) {
    await dbUpsertToken({
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      logoUri: token.logoUri ?? null,
      description: token.description ?? null,
      verified: token.verified,
      coingeckoId: token.coingeckoId ?? null,
      twitter: token.twitter ?? null,
      website: token.website ?? null,
      telegram: token.telegram ?? null,
      discord: token.discord ?? null,
      instagram: token.instagram ?? null,
      tiktok: token.tiktok ?? null,
      tags: token.tags ?? null,
      // Don't include price fields -> preserve existing prices
    });
    console.log(`${token.symbol} (${token.mint})`);
  }

  console.log("Token sync complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Token sync failed:", err);
  process.exit(1);
});
