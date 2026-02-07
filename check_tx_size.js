// Quick script to check transaction sizes
// Run: node check_tx_size.js

// Rough estimation:
// Base overhead: 100 bytes
// Compute budget (2 instructions): 50 bytes
// Memo: 50-100 bytes
// Each instruction: ~150-200 bytes

console.log("Transaction Size Estimates:");
console.log("---");

// init_pool (1 pool + 8 vaults + registry)
const initPoolSize = 100 + 50 + 100 + (10 * 150);
console.log(`init_pool: ~${initPoolSize} bytes (${initPoolSize > 1232 ? '❌ TOO LARGE' : '✅ OK'})`);

// create_bin_arrays (5 arrays)
const createBinArrays = 100 + 50 + 100 + (5 * 150);
console.log(`create_bin_arrays (5): ~${createBinArrays} bytes (${createBinArrays > 1232 ? '❌ TOO LARGE' : '✅ OK'})`);

// init_position_bins (5 bins)
const initPositionBins = 100 + 50 + 100 + (5 * 150);
console.log(`init_position_bins (5): ~${initPositionBins} bytes (${initPositionBins > 1232 ? '❌ TOO LARGE' : '✅ OK'})`);

// add_liquidity (4 deposits + remaining accounts)
// Each deposit needs 2 accounts (BinArray + PositionBin)
const addLiquidity = 100 + 50 + 100 + 200 + (4 * 2 * 32);
console.log(`add_liquidity (4 deposits): ~${addLiquidity} bytes (${addLiquidity > 1232 ? '❌ TOO LARGE' : '✅ OK'})`);

console.log("---");
console.log("Limit: 1232 bytes");
console.log("");
console.log("If any transaction > 1232 bytes:");
console.log("  → Reduce batch size in adapter API");
console.log("  → BIN_ARRAY_BATCH_SIZE: 5 → 4");
console.log("  → INIT_BIN_BATCH_SIZE: 5 → 4");
console.log("  → LIQUIDITY_BATCH_SIZE: 4 → 3");
