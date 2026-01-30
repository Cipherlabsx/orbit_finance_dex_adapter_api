import { supabase } from "../supabase.js";
import fs from "fs/promises";
import { z } from "zod";

export type Token = {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string | null;
  description: string | null;
  verified: boolean;
  coingeckoId: string | null;
  twitter: string | null;
  website: string | null;
  telegram: string | null;
  discord: string | null;
  instagram: string | null;
  tiktok: string | null;
  tags: string[] | null;
  priceUsd: number | null;
  lastPriceUpdate: string | null;
};

/** Fetch all tokens from registry */
export async function dbListTokens(): Promise<Token[]> {
  const { data, error } = await supabase.from("token_registry").select("*").order("symbol", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(dbTokenToType);
}

/** Fetch single token by mint */
export async function dbGetToken(mint: string): Promise<Token | null> {
  const { data, error } = await supabase.from("token_registry").select("*").eq("mint", mint).single();
  if (error) {
    if ((error as any).code === "PGRST116") return null;
    throw error;
  }
  return dbTokenToType(data);
}

/** Upsert token (insert or update) - price fields optional */
export async function dbUpsertToken(
  token: Omit<Token, "priceUsd" | "lastPriceUpdate"> & { priceUsd?: number | null; lastPriceUpdate?: string | null }
): Promise<void> {
  const updateData: any = {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    logo_uri: token.logoUri,
    description: token.description,
    verified: token.verified,
    coingecko_id: token.coingeckoId,
    twitter: token.twitter,
    website: token.website,
    telegram: token.telegram,
    discord: token.discord,
    instagram: token.instagram,
    tiktok: token.tiktok,
    tags: token.tags,
    updated_at: new Date().toISOString(),
  };

  if (token.priceUsd !== undefined) updateData.price_usd = token.priceUsd;
  if (token.lastPriceUpdate !== undefined) updateData.last_price_update = token.lastPriceUpdate;

  const { error } = await supabase.from("token_registry").upsert(updateData, { onConflict: "mint" });
  if (error) throw error;
}

/**
 * Load tokens.json once and keep in-memory map
 */
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

let TOKENS_BY_MINT_PROMISE: Promise<Map<string, z.infer<typeof TokenZ>>> | null = null;

async function getTokensByMint(): Promise<Map<string, z.infer<typeof TokenZ>>> {
  if (!TOKENS_BY_MINT_PROMISE) {
    TOKENS_BY_MINT_PROMISE = (async () => {
      // path: src/data/tokens.json relative to this file (src/services/token_registry.ts)
      const filePath = new URL("../data/tokens.json", import.meta.url).pathname;
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = TokensFileZ.parse(JSON.parse(content));
      const m = new Map<string, z.infer<typeof TokenZ>>();
      for (const t of parsed.tokens) m.set(t.mint, t);
      return m;
    })();
  }
  return TOKENS_BY_MINT_PROMISE;
}

/** Update token prices in batch (UPDATE ONLY never creates/clobbers registry rows) */
export async function dbUpdateTokenPrices(
  prices: Array<{ mint: string; priceUsd: number | null }>
): Promise<void> {
  const now = new Date().toISOString();

  // de-dupe by mint (last wins)
  const byMint = new Map<string, number | null>();
  for (const p of prices) {
    if (p?.mint && p.mint.length >= 32) byMint.set(p.mint, p.priceUsd ?? null);
  }
  const uniq = Array.from(byMint.entries()).map(([mint, priceUsd]) => ({ mint, priceUsd }));
  if (uniq.length === 0) return;

  console.log(`dbUpdateTokenPrices: Updating ${uniq.length} token prices (UPDATE ONLY)...`);

  // IMPORTANT: supabase-js has no true "bulk update with different values per row".
  // So we do small sequential updates.
  for (const { mint, priceUsd } of uniq) {
    const { data, error } = await supabase
      .from("token_registry")
      .update({
        price_usd: priceUsd,
        last_price_update: now,
        updated_at: now,
      })
      .eq("mint", mint)
      .select("mint");

    if (error) throw error;

    // If no row updated => mint missing (sync-tokens didn't insert it)
    if (!data || data.length === 0) {
      console.warn(`dbUpdateTokenPrices: mint not found in token_registry (skipping): ${mint}`);
    }
  }
}

function dbTokenToType(row: any): Token {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoUri: row.logo_uri,
    description: row.description,
    verified: row.verified,
    coingeckoId: row.coingecko_id,
    twitter: row.twitter,
    website: row.website,
    telegram: row.telegram,
    discord: row.discord,
    instagram: row.instagram,
    tiktok: row.tiktok,
    tags: row.tags,
    priceUsd: row.price_usd != null ? parseFloat(row.price_usd) : null,
    lastPriceUpdate: row.last_price_update,
  };
}