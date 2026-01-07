# Orbit Finance DEX Adapter

A **read-only DEX adapter API** for **Orbit Finance (Solana)**.

This service exposes **on-chain pool, price, and swap data**.

It **does not custody keys**, **does not sign transactions**, and **does not mutate state**.
The adapter reads directly from Solana RPC using the official Orbit Finance Anchor IDL.

---

- Read-only Solana RPC indexer
- Anchor + IDL based
- Deterministic, stateless API

---

## Supported Features

### Pools
- Read pool configuration and vaults
- Current price (Q64.64 -> float for display)
- Active bin & initial bin
- Base / quote mint addresses

### Trades
- Recent swaps via transaction log inspection
- Direction, amounts, price after swap
- Timestamped, deterministic

### Security
- No private keys required
- No signing capability
- RPC-only permissions
- Rate limiting & headers enabled

---

## API Endpoints

### `GET /api/v1/pools`
Returns all configured pools (from config or registry source).

```json
[
  {
    "id": "FhZeGvu7oqJWGYGRkHzzFv1typcWzTJkeLP4XF74s8UQ",
    "baseMint": "...",
    "quoteMint": "...",
    "price": 0.006355
  }
]
```

## GET /api/v1/pools/:pool
Returns live on-chain state for a single pool.

```json
{
  "id": "FhZeGvu7oqJWGYGRkHzzFv1typcWzTJkeLP4XF74s8UQ",
  "programId": "Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM",

  "baseMint": "Ciphern9cCXtms66s8Mm6wCFC27b2JProRQLYmiLMH3N",
  "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  "priceQ6464": "117229058588424",
  "price": 0.006355,

  "baseVault": "...",
  "quoteVault": "...",

  "creatorFeeVault": "...",
  "holdersFeeVault": "...",
  "nftFeeVault": "...",

  "activeBin": 0,
  "initialBin": 0
}
```

## GET /api/v1/trades/:pool
Returns recent swaps for a pool (best-effort).

```json
[
  {
    "signature": "...",
    "side": "buy",
    "amountIn": "15000000",
    "amountOut": "2350000",
    "priceAfter": 0.00636,
    "ts": 1704628123
  }
]
```

## .env.example

```
PORT=8080
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
ORBIT_PROGRAM_ID=Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM
DEX_KEY=orbit_finance
```

# Run locally

1. Install dependencies
```bash
npm install
```
2. Start dev server
```bash
npm run dev
```
3. Production build
```bash
npm run build
npm start
```
4. The server now runs on http://localhost:8080

## Deploy to Fly.io

Prerequisites
 - A Fly.io account
 - Fly CLI installed
 - Your app builds locally (npm run build)

1. Install Fly CLI (macOS):
```bash
brew install flyctl
```

2. login
```bash
fly auth login
```

3. Create the Fly app (generates fly.toml) -> From the repo root:
```bash
fly launch --no-deploy
```

4. Configure Fly to serve port 8080
Ensure your fly.toml contains this (adjust app and primary_region as needed):

```toml
app = "orbit-dex-adapter-api [or your app name]"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

5. Set production secrets (DO NOT commit .env as in .gitignore and .dockerignore)
Fly uses secrets instead of .env files. Set required secrets:

```bash
fly secrets set \
  SOLANA_RPC_URL="https://YOUR_RPC_ENDPOINT" \
  ORBIT_PROGRAM_ID="Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM" \
  DEX_KEY="orbit_finance"
```

**Optional (recommended for production stability):**
```bash
fly secrets set \
  DISCOVER_POOLS="true" \
  DISCOVERY_REFRESH_SEC="300" \
  DISCOVERY_LIMIT="2000" \
  SIGNATURE_LOOKBACK="200" \
  TRADES_POLL_MS="4000" \
  LOG_LEVEL="info"
```

***Important: do not use https://api.mainnet-beta.solana.com for production. Use a dedicated RPC (Helius / Triton / QuickNode / Alchemy) to avoid timeouts and rate limits.***

6. Deploy your app

```bash
fly deploy
fly logs
```

You should see something like:
 - pools discovered
 - Server listening at http://0.0.0.0:8080
 - orbit dex adapter api started

Verify your deployment and test endpoints
Get your app URL:

```bash
fly info
```

curl https://YOUR-FLY-APP.fly.dev/health
curl https://YOUR-FLY-APP.fly.dev/api/v1/pools
curl https://YOUR-FLY-APP.fly.dev/latest-block

## License

MIT © 2026 CipherLabsX C Corp

This project is open-source and free to use, modify, and distribute under the MIT License.


