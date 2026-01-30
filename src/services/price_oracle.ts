import { connection } from "../solana.js";
import { dbUpdateTokenPrices } from "./token_registry.js";

type PriceCache = {
  [mint: string]: {
    priceUsd: number | null;
    priceVsQuote: Record<string, number>; // mint -> price
    lastUpdated: number;
  };
};

const PRICE_CACHE: PriceCache = {};
const CACHE_TTL_MS = 5000; // 5 seconds (shorter than poller interval to force refresh)

type CoinGeckoPriceResponse = {
  [mint: string]: {
    usd?: number;
  };
};

/**
 * Fetch token price from CoinGecko API (free tier, no auth required)
 */
async function fetchCoinGeckoPrice(mint: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mint}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(3000) }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as CoinGeckoPriceResponse;
    const priceData = data[mint.toLowerCase()];

    return priceData?.usd ?? null;
  } catch (err) {
    console.error(`Failed to fetch price for ${mint}:`, err);
    return null;
  }
}

/**
 * Calculate relative price between two tokens
 */
function calculateRelativePrice(
  baseMint: string,
  quoteMint: string,
  baseUsdPrice: number | null,
  quoteUsdPrice: number | null
): number | null {
  if (!baseUsdPrice || !quoteUsdPrice) return null;

  // Price of base in terms of quote
  return baseUsdPrice / quoteUsdPrice;
}

/**
 * Get or fetch cached price for a token
 */
export async function getTokenPrice(mint: string): Promise<{
  priceUsd: number | null;
  lastUpdated: number;
}> {
  const now = Date.now();
  const cached = PRICE_CACHE[mint];

  // Return cached if fresh
  if (cached && now - cached.lastUpdated < CACHE_TTL_MS) {
    return {
      priceUsd: cached.priceUsd,
      lastUpdated: cached.lastUpdated,
    };
  }

  // Fetch fresh price
  const priceUsd = await fetchCoinGeckoPrice(mint);

  PRICE_CACHE[mint] = {
    priceUsd,
    priceVsQuote: {},
    lastUpdated: now,
  };

  return { priceUsd, lastUpdated: now };
}

/**
 * Get price of base token in terms of quote token
 */
export async function getRelativePrice(
  baseMint: string,
  quoteMint: string
): Promise<{
  price: number | null;
  baseUsd: number | null;
  quoteUsd: number | null;
  lastUpdated: number;
}> {
  const now = Date.now();

  // Check cache
  const baseCached = PRICE_CACHE[baseMint];
  const quoteCached = PRICE_CACHE[quoteMint];

  const needsRefresh =
    !baseCached ||
    !quoteCached ||
    now - baseCached.lastUpdated > CACHE_TTL_MS ||
    now - quoteCached.lastUpdated > CACHE_TTL_MS;

  let baseUsd: number | null;
  let quoteUsd: number | null;

  if (needsRefresh) {
    // Fetch both prices in parallel
    const [basePrice, quotePrice] = await Promise.all([
      getTokenPrice(baseMint),
      getTokenPrice(quoteMint),
    ]);

    baseUsd = basePrice.priceUsd;
    quoteUsd = quotePrice.priceUsd;
  } else {
    baseUsd = baseCached.priceUsd;
    quoteUsd = quoteCached.priceUsd;
  }

  const relativePrice = calculateRelativePrice(baseMint, quoteMint, baseUsd, quoteUsd);

  return {
    price: relativePrice,
    baseUsd,
    quoteUsd,
    lastUpdated: now,
  };
}

/**
 * Fetch prices for multiple tokens in batch
 */
export async function getBatchPrices(
  mints: string[]
): Promise<
  Array<{
    mint: string;
    priceUsd: number | null;
    lastUpdated: number;
  }>
> {
  const now = Date.now();
  const results: Array<{
    mint: string;
    priceUsd: number | null;
    lastUpdated: number;
  }> = [];

  const needsFetch: string[] = [];
  const mintMap = new Map<string, { priceUsd: number | null; lastUpdated: number }>();

  // Split cached vs needs fetch
  for (const mint of mints) {
    const cached = PRICE_CACHE[mint];
    if (cached && now - cached.lastUpdated < CACHE_TTL_MS) {
      mintMap.set(mint, {
        priceUsd: cached.priceUsd,
        lastUpdated: cached.lastUpdated,
      });
    } else {
      needsFetch.push(mint);
    }
  }

  // 2Fetch missing prices (CoinGecko free tier: 1 at a time)
  if (needsFetch.length > 0) {
    console.log(`Fetching prices for ${needsFetch.length} tokens from CoinGecko...`);

    const dbUpdates: Array<{ mint: string; priceUsd: number }> = [];

    for (let i = 0; i < needsFetch.length; i++) {
      const mint = needsFetch[i];

      let priceUsd: number | null = null;

      try {
        const response = await fetch(
          `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mint}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(5000) }
        );

        if (response.ok) {
          const data = (await response.json()) as CoinGeckoPriceResponse;
          const priceData = data[mint] || data[mint.toLowerCase()];
          priceUsd = typeof priceData?.usd === "number" ? priceData.usd : null;
        }
      } catch (err) {
        console.warn(`Price fetch failed for ${mint}`, err);
      }

      // Update cache ALWAYS
      PRICE_CACHE[mint] = {
        priceUsd,
        priceVsQuote: {},
        lastUpdated: now,
      };

      mintMap.set(mint, { priceUsd, lastUpdated: now });

      // ONLY persist real prices (never null)
      if (typeof priceUsd === "number" && Number.isFinite(priceUsd)) {
        dbUpdates.push({ mint, priceUsd });
        console.log(`  ${mint}: $${priceUsd}`);
      } else {
        console.log(`  ${mint}: no price (keeping previous DB value)`);
      }

      // CoinGecko free tier pacing
      if (i < needsFetch.length - 1) {
        await new Promise((r) => setTimeout(r, 6500));
      }
    }

    // Write prices to DB (only non-null)
    if (dbUpdates.length > 0) {
      console.log(`Updating database with ${dbUpdates.length} token prices...`);
      dbUpdateTokenPrices(dbUpdates).catch((err) => {
        console.error("Failed to update token prices in database:", err);
      });
    }
  }

  // Build result array in requested order
  for (const mint of mints) {
    const data = mintMap.get(mint);
    if (data) {
      results.push({ mint, ...data });
    }
  }

  return results;
}

/**
 * Clear stale cache entries (run periodically)
 */
export function cleanPriceCache() {
  const now = Date.now();
  const maxAge = CACHE_TTL_MS * 10; // Keep entries for 50 seconds max (5s * 10)

  for (const [mint, data] of Object.entries(PRICE_CACHE)) {
    if (now - data.lastUpdated > maxAge) {
      delete PRICE_CACHE[mint];
    }
  }
}

/**
 * Initialize price cache with common tokens
 */
export async function initPriceCache(mints: string[]) {
  console.log(`Initializing price cache for ${mints.length} tokens...`);
  const results = await getBatchPrices(mints);

  const successCount = results.filter(r => r.priceUsd !== null).length;
  console.log(`Price cache initialized: ${successCount}/${mints.length} tokens have prices`);
}
