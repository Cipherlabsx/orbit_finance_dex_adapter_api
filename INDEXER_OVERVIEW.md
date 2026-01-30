## Overview

This indexer provides **real-time and historical** indexing of **ALL 15 DLMM events** from the Orbit Finance program. The system automatically updates your database to the latest block with **zero latency**, ensuring your website always has up-to-date data.

## Supported Events

The indexer handles all 15 event types from the Orbit Finance IDL:

### Trading Events
1. **SwapExecuted** - Trade execution with price and reserves
   - Event Type: `swap`
   - Includes: maker, pairId, amounts, priceNative, reserves

### Liquidity Events
2. **LiquidityDeposited** - User deposits liquidity
   - Event Type: `liquidityDeposit`
   - Includes: maker, asset amounts, shares minted, price, reserves

3. **LiquidityWithdrawnUser** - User withdraws liquidity
   - Event Type: `liquidityWithdraw`
   - Includes: maker, asset amounts, shares burned, price, reserves

4. **LiquidityWithdrawnAdmin** - Admin emergency withdrawal
   - Event Type: `adminWithdraw`
   - Includes: admin, asset amounts, reserves

5. **LiquidityLocked** - Liquidity lock event
   - Event Type: `liquidityLock`
   - Includes: maker, amount, lockEnd timestamp

### Bin Management Events
6. **BinLiquidityUpdated** - Bin reserves change
   - Event Type: `binLiquidityUpdate`
   - Includes: pairId, binIndex, deltas, reserves

7. **BinArrayCreated** - New bin array created
   - Event Type: `binArrayCreate`
   - Includes: pairId, lowerBinIndex, binArray address

8. **LiquidityBinCreated** - New liquidity bin created
   - Event Type: `liquidityBinCreate`
   - Includes: pairId, binIndex, price bounds, initial shares

### Fee Events
9. **FeesDistributed** - Fee distribution to vaults
   - Event Type: `feesDistributed`
   - Includes: pairId, totalFee, creator/holders/nft fees

10. **FeeConfigUpdated** - Fee configuration change
    - Event Type: `feeConfigUpdate`
    - Includes: pairId, fee parameters in bps/microbps

### Pool Management Events
11. **PoolInitialized** - Pool creation
    - Event Type: `poolInit`
    - Includes: pairId, admin, creator, mints, binStepBps, initial price

12. **AdminUpdated** - Admin key rotation
    - Event Type: `adminUpdate`
    - Includes: pairId, oldAdmin, newAdmin

13. **AuthoritiesUpdated** - Auxiliary authorities update
    - Event Type: `authoritiesUpdate`
    - Includes: pairId, configAuthority, pauseGuardian, feeWithdrawAuthority

14. **PauseUpdated** - Pause state change
    - Event Type: `pauseUpdate`
    - Includes: pairId, admin, paused bitmask

15. **PairRegistered** - Pair registry entry
    - Event Type: `pairRegister`
    - Includes: pairId, asset0, asset1, binStepBps

## Architecture

### Real-Time Indexing

**File:** `src/services/program_ws.ts`

- Uses `connection.onLogs()` to subscribe to program activity
- Fetches transaction details on every program event
- Decodes all Anchor events from logs
- Formats events using Coingecko-compliant formatters
- Writes to database with deterministic ordering
- Broadcasts to WebSocket clients
- Updates pool state and liquidity metrics

**Key Features:**
- Zero latency - events indexed as they occur
- Deterministic `txnIndex` via block signature ordering
- Automatic pool state updates (active bin, price)
- Liquidity tracking on deposit/withdraw events
- Full transaction log preservation

### Historical Backfill

**File:** `src/scripts/backfill_events.ts`

- Scans all historical transactions via `getSignaturesForAddress()`
- Processes transactions in batches with configurable concurrency
- Uses identical formatting logic as real-time indexer
- Writes all events with complete metadata
- Handles pagination and resume from cursor

**Run:**
```bash
tsx src/scripts/backfill_events.ts

# Or with npm script:
npm run backfill:events
```

**Environment Variables:**
- `BACKFILL_PAGE_SIZE=500` - Signatures per page
- `BACKFILL_CONCURRENCY=6` - Parallel transaction fetches
- `BACKFILL_BEFORE_SIGNATURE=<sig>` - Resume cursor
- `BACKFILL_SCAN_ACCOUNTS_MAX=60` - Pool discovery fallback limit

### Event Formatting

**File:** `src/services/event_formatters.ts`

Central module for Coingecko-compliant event formatting:

- `formatEventData()` - Main formatter routing all 15 event types
- `getStandardEventType()` - Maps IDL event names to standard types
- Handles decimal conversion without floating point
- Computes post-transaction reserves from `tx.meta.postTokenBalances`
- Validates data and returns null for malformed events

**Key Functions:**
- `decimalize(atoms, decimals)` - BigInt to decimal string
- `divToDecimalString(num, den)` - Exact decimal division
- `getPostVaultReservesAtoms()` - Extract post-tx vault balances
- Individual formatters for each event type

## Database Schema

### dex_events Table

Stores ALL program events with Coingecko-compliant payloads:

```sql
CREATE TABLE dex_events (
  signature TEXT NOT NULL,
  slot BIGINT,
  block_time BIGINT,
  program_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- standardized type (swap, liquidityDeposit, etc.)
  txn_index INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  event_data JSONB,
  logs TEXT[],
  inserted_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(slot, txn_index, event_index, event_type)
);

CREATE INDEX idx_dex_events_slot ON dex_events(slot, txn_index, event_index);
CREATE INDEX idx_dex_events_type ON dex_events(event_type);
```

### dex_trades Table

Derived swap trades for market data:

```sql
CREATE TABLE dex_trades (
  signature TEXT NOT NULL,
  slot BIGINT,
  block_time BIGINT,
  pool TEXT NOT NULL,
  user_pubkey TEXT,
  in_mint TEXT NOT NULL,
  out_mint TEXT NOT NULL,
  amount_in_raw TEXT NOT NULL,
  amount_out_raw TEXT NOT NULL,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(signature, pool)
);
```

### dex_pools Table

Pool state and configuration:

```sql
CREATE TABLE dex_pools (
  pool TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  base_decimals INTEGER NOT NULL,
  quote_decimals INTEGER NOT NULL,
  base_vault TEXT,
  quote_vault TEXT,
  active_bin INTEGER,
  last_price_quote_per_base NUMERIC,
  liquidity_quote NUMERIC,
  latest_liq_event_slot BIGINT,
  last_update_slot BIGINT,
  last_trade_sig TEXT,
  creator_fee_vault TEXT,
  holders_fee_vault TEXT,
  nft_fee_vault TEXT,
  fees_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## API Endpoints

### GET /api/v1/events

Query all events within a slot range:

```
GET /api/v1/events?fromBlock=12345&toBlock=12350
```

Filter by event types:

```
GET /api/v1/events?fromBlock=12345&toBlock=12350&eventTypes=swap,liquidityDeposit
```

**Response:**
```json
{
  "events": [
    {
      "block": {
        "blockNumber": 12345,
        "blockTimestamp": 1706534567
      },
      "eventType": "swap",
      "txnId": "3a2f...",
      "txnIndex": 42,
      "eventIndex": 0,
      "maker": "HsT7...",
      "pairId": "8vNw...",
      "asset0In": "1.5",
      "asset1Out": "3000.25",
      "priceNative": "2000.1666666666666666666666666666666666666666666666",
      "reserves": {
        "asset0": "12500.5",
        "asset1": "25000000.75"
      }
    },
    {
      "block": {
        "blockNumber": 12346,
        "blockTimestamp": 1706534568
      },
      "eventType": "liquidityDeposit",
      "txnId": "5b3d...",
      "txnIndex": 10,
      "eventIndex": 0,
      "maker": "9xPq...",
      "pairId": "8vNw...",
      "asset0Amount": "10.0",
      "asset1Amount": "20000.0",
      "shares": "1000000000",
      "priceNative": "2000.0",
      "reserves": {
        "asset0": "12510.5",
        "asset1": "25020000.75"
      }
    }
  ]
}
```

### GET /api/v1/latest-block

**Current Solana slot for indexer polling**

```
GET /api/v1/latest-block
```

**Response:**
```json
{
  "block": {
    "blockNumber": 250123456,
    "blockTimestamp": 1706534600
  }
}
```

### Other Endpoints

- `GET /api/v1/pools` - All indexed pools
- `GET /api/v1/pools/:pool` - Single pool with fees + TVL
- `GET /api/v1/trades/:pool` - Recent swaps (limit: 1-200)
- `GET /api/v1/volumes?tf=24h&pools=...` - Trading volume
- `GET /api/v1/candles/:pool?tf=15m` - OHLCV candles
- `GET /api/v1/asset?id=<mint>` - Asset metadata
- `GET /api/v1/pair?id=<pool>` - Pair info
- `GET /api/v1/bins/:pool` - Liquidity bin data

## WebSocket Real-Time Stream

### Connection

1. Get ticket:
```
GET /api/v1/ws-ticket
→ { "ticket": "abc...", "expiresInSec": 30 }
```

2. Connect:
```
WS /api/v1/ws?ticket=abc...
```

### Subscribe to Pool

```json
{
  "type": "subscribe",
  "pool": "8vNw...",
  "limit": 50
}
```

### Messages

**Trade:**
```json
{
  "type": "trade",
  "pool": "8vNw...",
  "data": {
    "signature": "3a2f...",
    "slot": 12345,
    "pool": "8vNw...",
    "inMint": "So11...",
    "outMint": "EPjF...",
    "amountIn": "1500000000",
    "amountOut": "3000250000",
    "user": "HsT7..."
  }
}
```

**Event:**
```json
{
  "type": "event",
  "pool": "8vNw...",
  "data": {
    "signature": "5b3d...",
    "slot": 12346,
    "blockTime": 1706534568,
    "event": {
      "name": "LiquidityDeposited",
      "data": {
        "pairId": "8vNw...",
        "maker": "9xPq...",
        "asset0Amount": "10.0",
        "asset1Amount": "20000.0",
        "shares": "1000000000",
        "priceNative": "2000.0",
        "reserves": {
          "asset0": "12510.5",
          "asset1": "25020000.75"
        }
      }
    }
  }
}
```

## Configuration

### Required Environment Variables

```env
# Solana RPC
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Program ID
ORBIT_PROGRAM_ID=Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM

# Database
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# WebSocket Auth
WS_TOKEN=<32+ character secret>
```

### Optional Configuration

```env
# Server
PORT=8080
LOG_LEVEL=info
DEX_KEY=orbit_finance

# Pool Discovery
DISCOVER_POOLS=true
DISCOVERY_REFRESH_SEC=300
DISCOVERY_LIMIT=2000
POOLS=  # Comma-separated allowlist (optional)

# Indexing
SIGNATURE_LOOKBACK=200
TRADES_POLL_MS=4000

# WebSocket
WS_TTL_SEC=30
WS_SKEW_SEC=5
```

## Event Data Examples

### Swap Event

```json
{
  "maker": "HsT7Pk8TRGBp1CzjwPLwVkNEJC3RJ8LvqK3nBp9pumps",
  "pairId": "8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy",
  "asset0In": "1.5",
  "asset1Out": "3000.25",
  "priceNative": "2000.1666666666666666666666666666666666666666666666",
  "reserves": {
    "asset0": "12500.5",
    "asset1": "25000000.75"
  }
}
```

### Liquidity Deposit Event

```json
{
  "maker": "9xPqRk5LvNm8TRGBp1CzjwPLwVkNEJC3RJ8LvqK3nBp9",
  "pairId": "8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy",
  "eventType": "liquidityDeposit",
  "asset0Amount": "10.0",
  "asset1Amount": "20000.0",
  "shares": "1000000000",
  "priceNative": "2000.0",
  "reserves": {
    "asset0": "12510.5",
    "asset1": "25020000.75"
  }
}
```

### Bin Liquidity Update Event

```json
{
  "pairId": "8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy",
  "eventType": "binLiquidityUpdate",
  "binIndex": "128",
  "deltaBase": "5.25",
  "deltaQuote": "10500.5",
  "reserveBase": "125.75",
  "reserveQuote": "251501.0",
  "reserves": {
    "asset0": "12510.5",
    "asset1": "25020000.75"
  }
}
```

### Fee Distribution Event

```json
{
  "pairId": "8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy",
  "eventType": "feesDistributed",
  "totalFee": "3000000",
  "creatorFee": "1500000",
  "holdersFee": "750000",
  "nftFee": "600000",
  "creatorExtraFee": "150000"
}
```

### Pool Initialization Event

```json
{
  "pairId": "8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy",
  "eventType": "poolInit",
  "admin": "AdminPubkey...",
  "creator": "CreatorPubkey...",
  "asset0": "So11111111111111111111111111111111111111112",
  "asset1": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "binStepBps": "10",
  "initialPrice": "340282366920938463463374607431768211456"
}
```

## Key Features

**Deterministic Ordering**
- Events ordered by `(slot, txn_index, event_index)`
- Unique constraint prevents duplicates
- Consistent results across queries

**Complete Event Coverage**
- All 15 DLMM event types indexed
- Standardized event type names
- Rich metadata for all events

**Accurate Price & Reserves**
- Uses `tx.meta.postTokenBalances` for post-event state
- Exact decimal arithmetic (no floating point)
- Price calculated from actual vault ratios

**Validation & Quality**
- Validates required fields per event type
- Filters malformed events
- Sanity checks on price and reserves

**Real-Time Updates**
- Zero latency event indexing
- WebSocket broadcast to clients
- Automatic pool state updates

### Zero-Latency Operation

1. **Real-Time Stream** - `onLogs()` subscription catches every program event
2. **Immediate Indexing** - Events written to DB as they occur
3. **WebSocket Broadcast** - Clients notified instantly
4. **Pool State Updates** - Price, liquidity, active bin updated automatically
5. **Latest Block Tracking** - `/latest-block` always returns current slot

### Historical Completeness

- Backfill script indexes ALL historical events
- Resume capability with cursor
- Parallel processing for speed
- Same formatting as real-time events
- Deterministic ordering matches live stream

## Usage Examples

### Query Recent Swaps

```bash
curl "http://localhost:8080/api/v1/events?fromBlock=250120000&toBlock=250120100&eventTypes=swap"
```

### Query Liquidity Events

```bash
curl "http://localhost:8080/api/v1/events?fromBlock=250120000&toBlock=250120100&eventTypes=liquidityDeposit,liquidityWithdraw"
```

### Query All Event Types

```bash
curl "http://localhost:8080/api/v1/events?fromBlock=250120000&toBlock=250120100"
```

### Get Latest Block

```bash
curl "http://localhost:8080/api/v1/latest-block"
```

### Get Pool Info

```bash
curl "http://localhost:8080/api/v1/pools/8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy"
```

### WebSocket Subscribe

```javascript
const ws = new WebSocket('ws://localhost:8080/api/v1/ws?ticket=<ticket>');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    pool: '8vNwusLAUB2T2qK3zg9P5xFz8AkZJXaG7qkLKGNmvCRy',
    limit: 50
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'trade') {
    console.log('New trade:', msg.data);
  } else if (msg.type === 'event') {
    console.log('New event:', msg.data.event.name, msg.data.event.data);
  }
};
```

## Testing

### Start the Indexer

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Run the indexer
npm start
```

### Run Backfill

```bash
# Backfill all historical events
npm run backfill:events

# Or with custom settings
BACKFILL_PAGE_SIZE=1000 BACKFILL_CONCURRENCY=10 tsx src/scripts/backfill_events.ts
```

### Test Event API

```bash
# Get latest block
curl http://localhost:8080/api/v1/latest-block

# Query events for last 100 slots
LATEST=$(curl -s http://localhost:8080/api/v1/latest-block | jq -r '.block.blockNumber')
FROM=$((LATEST - 100))
curl "http://localhost:8080/api/v1/events?fromBlock=$FROM&toBlock=$LATEST"

# Query specific event types
curl "http://localhost:8080/api/v1/events?fromBlock=$FROM&toBlock=$LATEST&eventTypes=swap,liquidityDeposit"
```

### Verify Data Quality

```sql
-- Check event type distribution
SELECT event_type, COUNT(*) as count
FROM dex_events
GROUP BY event_type
ORDER BY count DESC;

-- Check recent events
SELECT slot, event_type, event_data->>'pairId' as pool
FROM dex_events
ORDER BY slot DESC, txn_index DESC, event_index DESC
LIMIT 20;

-- Verify swap events have required fields
SELECT COUNT(*) as valid_swaps
FROM dex_events
WHERE event_type = 'swap'
  AND event_data ? 'priceNative'
  AND event_data ? 'reserves'
  AND event_data ? 'pairId';
```

## Monitoring

### Key Metrics

- **Event Throughput**: Monitor `dex_events.inserted_at` for indexing rate
- **Latest Slot**: Compare `dex_events.slot` to chain head
- **Event Types**: Distribution of event types indexed
- **Pool Coverage**: Number of unique pools in `dex_pools`
- **Trade Volume**: Track `dex_trades` for trading activity

### Health Checks

```bash
# API health
curl http://localhost:8080/api/v1/health

# Check latest indexed slot vs chain
INDEXED=$(psql -t -c "SELECT MAX(slot) FROM dex_events")
CHAIN=$(curl -s http://localhost:8080/api/v1/latest-block | jq -r '.block.blockNumber')
echo "Indexed: $INDEXED, Chain: $CHAIN, Lag: $((CHAIN - INDEXED))"
```

## Troubleshooting

### Events Not Indexing

1. Check WebSocket connection is active
2. Verify RPC URL is working: `curl $SOLANA_RPC_URL -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`
3. Check logs for errors: `tail -f logs/app.log`
4. Verify Supabase credentials: `psql "$SUPABASE_URL" -c "SELECT COUNT(*) FROM dex_events"`

### Missing Historical Events

1. Run backfill script: `npm run backfill:events`
2. Check for errors in backfill output
3. Resume from cursor if interrupted: `BACKFILL_BEFORE_SIGNATURE=<last_sig> npm run backfill:events`

### Incorrect Event Data

1. Verify pool decimals are correct in `dex_pools`
2. Check event_data JSONB structure
3. Review event_formatters.ts logic for specific event type
4. Compare with on-chain data using explorer

### Performance Issues

1. Add database indexes (see schema above)
2. Increase `BACKFILL_CONCURRENCY` for faster backfill
3. Use faster RPC endpoint
4. Scale database if needed (connection pooling, read replicas)