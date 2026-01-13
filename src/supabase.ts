import { createClient } from "@supabase/supabase-js";
import { Trade } from "./services/trades_indexer.js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export async function writeTradeAndVolume(params: {
  trade: Trade;
  quoteMint: string;
  quoteDecimals: number;
  quoteValue: number; // normalized quote units (e.g. USDC)
}) {
  const { trade, quoteMint, quoteDecimals, quoteValue } = params;

  // insert trade (idempotent via unique signature+pool)
  await supabase
    .from("trades")
    .upsert(
      {
        signature: trade.signature,
        pool: trade.pool,
        block_time: trade.blockTime ? new Date(trade.blockTime * 1000).toISOString() : null,
        user_wallet: trade.user ?? null,
        in_mint: trade.inMint ?? null,
        out_mint: trade.outMint ?? null,
        amount_in_raw: trade.amountIn ? trade.amountIn : null,
        amount_out_raw: trade.amountOut ? trade.amountOut : null,
        quote_mint: quoteMint,
        quote_decimals: quoteDecimals,
        quote_value: quoteValue,
      },
      { onConflict: "signature,pool" }
    );

  // increment pool_stats_1d (upsert + manual increment)
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

  // read existing
  const existing = await supabase
    .from("pool_stats_1d")
    .select("volume_quote,trades_count")
    .eq("pool", trade.pool)
    .eq("day", day)
    .maybeSingle();

  const prevVol = Number(existing.data?.volume_quote ?? 0);
  const prevCnt = Number(existing.data?.trades_count ?? 0);

  await supabase
    .from("pool_stats_1d")
    .upsert(
      {
        pool: trade.pool,
        day,
        volume_quote: prevVol + quoteValue,
        trades_count: prevCnt + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "pool,day" }
    );
}