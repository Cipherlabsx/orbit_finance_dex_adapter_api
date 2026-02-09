import { readPoolComplete } from "./src/services/pool_reader.js";

const pool = "59NxyZGTbjvHjobBu9LYdtt6SomA1gWdN1BYsVXmfqst";

readPoolComplete(pool)
  .then(data => {
    console.log("Pool data:");
    console.log("  priceNumber:", data.priceNumber);
    console.log("  priceQ6464:", data.priceQ6464);
    console.log("  lpMint:", data.lpMint);
    console.log("  liquidityQuote:", data.liquidityQuote);
    console.log("  lpSupplyRaw:", data.lpSupplyRaw);
  })
  .catch(err => console.error("Error:", err.message));
