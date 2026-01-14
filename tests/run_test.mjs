import path from "node:path";
import process from "node:process";

const testName = process.argv[2];
if (!testName) {
  console.error("Usage: npm run test <test_name>");
  process.exit(1);
}

const file = path.resolve(`tests/${testName}.mjs`);

try {
  await import(file);
} catch (err) {
  console.error("Test failed:", err);
  process.exit(1);
}