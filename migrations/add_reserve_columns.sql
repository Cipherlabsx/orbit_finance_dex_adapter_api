-- Add reserve columns to dex_pools for GeckoTerminal/DexScreener compliance
-- Run in Supabase Dashboard → SQL Editor → New Query → Run

ALTER TABLE dex_pools ADD COLUMN IF NOT EXISTS reserve_base_ui NUMERIC;
ALTER TABLE dex_pools ADD COLUMN IF NOT EXISTS reserve_quote_ui NUMERIC;
