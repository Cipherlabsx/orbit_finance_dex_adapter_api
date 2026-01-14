-- Extensions (uuid + useful crypto)
create extension if not exists pgcrypto;

-- TABLE: dex_pools
create table if not exists public.dex_pools (
  pool text primary key,
  program_id text,
  base_mint text not null,
  quote_mint text not null,
  base_decimals int not null,
  quote_decimals int not null,
  -- quote per 1 base (optional helper for UI)
  last_price_quote_per_base numeric,
  updated_at timestamptz not null default now()
);

create index if not exists dex_pools_base_mint_idx on public.dex_pools(base_mint);
create index if not exists dex_pools_quote_mint_idx on public.dex_pools(quote_mint);

-- TABLE: dex_trades (raw event store)
create table if not exists public.dex_trades (
  signature text primary key,
  slot bigint,
  block_time bigint not null,           -- unix seconds
  pool text not null references public.dex_pools(pool) on delete cascade,
  user_pubkey text,
  in_mint text not null,
  out_mint text not null,
  amount_in_raw numeric not null,       -- raw integer as numeric
  amount_out_raw numeric not null,      -- raw integer as numeric
  inserted_at timestamptz not null default now()
);

create index if not exists dex_trades_pool_time_idx on public.dex_trades(pool, block_time desc);
create index if not exists dex_trades_time_idx on public.dex_trades(block_time desc);

-- OPTIONAL: 24h volume materialized view
create materialized view if not exists public.dex_pool_volume_24h as
select
  t.pool,
  sum(
    case
      when t.in_mint = p.quote_mint
        then t.amount_in_raw / power(10, p.quote_decimals)
      when t.in_mint = p.base_mint
        then (t.amount_in_raw / power(10, p.base_decimals))
             * coalesce(p.last_price_quote_per_base, 0)
      else 0
    end
  ) as volume_24h_quote
from public.dex_trades t
join public.dex_pools p on p.pool = t.pool
where t.block_time >= extract(epoch from now())::bigint - 86400
group by t.pool;

create unique index if not exists dex_pool_volume_24h_pool_idx
  on public.dex_pool_volume_24h(pool);

-- RLS: lock everything
alter table public.dex_pools enable row level security;
alter table public.dex_trades enable row level security;

-- No public access (anon/auth) at all:
revoke all on table public.dex_pools from anon, authenticated;
revoke all on table public.dex_trades from anon, authenticated;

-- Also lock the materialized view:
revoke all on table public.dex_pool_volume_24h from anon, authenticated;

-- (Service role bypasses RLS automatically. we will only use that server-side)

## second:

create table if not exists public.dex_events (
  id bigserial primary key,
  signature text not null,
  slot bigint null,
  block_time bigint null,
  program_id text not null,

  -- "tx" if no Anchor event decoded, else the Anchor event name (e.g. SwapExecuted, AddLiquidity, etc.)
  event_type text not null,

  -- stable ordering per tx
  event_index integer not null default 0,

  -- decoded Anchor event payload (json) OR null for event_type="tx"
  event_data jsonb null,

  -- full log lines from getTransaction meta.logMessages
  logs jsonb null,

  inserted_at timestamptz not null default now()
);

create unique index if not exists dex_events_sig_event_idx
  on public.dex_events (signature, event_index, event_type);

create index if not exists dex_events_time_idx
  on public.dex_events (block_time desc);

create index if not exists dex_events_slot_idx
  on public.dex_events (slot desc);

alter table public.dex_trades drop constraint if exists dex_trades_pkey;
alter table public.dex_trades add constraint dex_trades_pkey primary key (signature, pool);

alter table public.dex_events enable row level security;
alter table public.dex_trades enable row level security;
alter table public.dex_pools  enable row level security;