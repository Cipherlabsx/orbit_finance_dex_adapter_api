/**
 * Liquidity Distribution Module
 * Backend adapter's single source of truth for distribution calculations.
 */

/**
 * Distribution strategy types
 */
export type DistributionStrategy =
  | "uniform"       // Equal weight across all bins
  | "concentrated"  // Bell curve centered around active bin
  | "skew_bid"      // More liquidity on bid (lower price) side
  | "skew_ask"      // More liquidity on ask (higher price) side
  | "bid-ask"       // U-shaped curve (high edges, low center)
  | "curve"         // Wide bell curve
  | "custom";       // User-defined curve

/**
 * Allocation result (in atoms, not UI decimals)
 */
export type BinAllocation = {
  binIndex: number;
  baseAtoms: bigint;
  quoteAtoms: bigint;
};

/**
 * Distribution validation result
 */
export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  deposits: BinAllocation[];  // Filtered (zero-atom bins removed)
};

/**
 * Clamp value between 0 and 1
 */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Sum array of numbers
 */
function sum(arr: number[]): number {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

/**
 * Normalize weights to sum to 1
 */
function normalizeWeights(weights: number[]): number[] {
  const s = sum(weights);
  if (!Number.isFinite(s) || s <= 0) {
    return weights.map(() => 0);
  }
  return weights.map((x) => x / s);
}

// WEIGHT FUNCTIONS (Exact ports from frontend)

/**
 * Generate uniform distribution (equal weight for all bins)
 */
export function weightsUniform(numBins: number): number[] {
  if (numBins <= 0) return [];
  return normalizeWeights(Array.from({ length: numBins }, () => 1));
}

/**
 * Generate Gaussian (bell curve) distribution
 */
function weightsGaussian(
  numBins: number,
  sigma: number,
  shift = 0
): number[] {
  if (numBins <= 1) return [1];

  const mid = (numBins - 1) / 2 + shift;
  const s = Math.max(0.85, sigma);

  const weights = Array.from({ length: numBins }, (_, i) => {
    const x = (i - mid) / s;
    return Math.exp(-0.5 * x * x);
  });

  return normalizeWeights(weights);
}

/**
 * Generate balanced distribution (symmetric bell curve)
 */
export function weightsBalanced(numBins: number): number[] {
  return weightsGaussian(numBins, Math.max(1, numBins / 6), 0);
}

/**
 * Generate concentrated distribution (tight bell curve)
 */
export function weightsConcentrated(
  numBins: number,
  decay: number
): number[] {
  if (numBins <= 1) return [1];

  const center = Math.floor(numBins / 2);
  const weights = Array.from({ length: numBins }, (_, i) => {
    const distance = Math.abs(i - center);
    // Exponential falloff: (1 - decay)^distance
    return Math.pow(1 - clamp01(decay), distance);
  });

  return normalizeWeights(weights);
}

/**
 * Generate skew bid distribution (more weight on left/lower prices)
 */
export function weightsSkewBid(numBins: number, decay: number): number[] {
  if (numBins <= 1) return [1];

  // Start with bell curve shifted left
  const shift = -Math.max(0.6, numBins * 0.06);
  const base = weightsGaussian(numBins, Math.max(1, numBins / 5.4), shift);

  // Apply left bias (more weight to lower indices)
  // Use decay to control skew intensity: higher decay = more aggressive skew
  const p = 1.5 + clamp01(decay) * 1.5; // Range: 1.5 to 3.0
  const weights = base.map((x, i) => {
    const t = numBins <= 1 ? 1 : (numBins - 1 - i) / (numBins - 1);
    const bias = Math.pow(0.35 + 0.65 * t, p);
    return x * bias;
  });

  return normalizeWeights(weights);
}

/**
 * Generate skew ask distribution (more weight on right/higher prices)
 */
export function weightsSkewAsk(numBins: number, decay: number): number[] {
  if (numBins <= 1) return [1];

  // Start with bell curve shifted right
  const shift = Math.max(0.6, numBins * 0.06);
  const base = weightsGaussian(numBins, Math.max(1, numBins / 5.4), shift);

  // Apply right bias (more weight to higher indices)
  // Use decay to control skew intensity: higher decay = more aggressive skew
  const p = 1.5 + clamp01(decay) * 1.5; // Range: 1.5 to 3.0
  const weights = base.map((x, i) => {
    const t = numBins <= 1 ? 1 : i / (numBins - 1);
    const bias = Math.pow(0.35 + 0.65 * t, p);
    return x * bias;
  });

  return normalizeWeights(weights);
}

/**
 * Generate bid-ask distribution (high edges, low center)
 *
 * CRITICAL: Produces 100x more liquidity at edges than center!
 * - Center weight: (0.10 + 0.90 * 0)^2.15 ≈ 0.008
 * - Edge weight: (0.10 + 0.90 * 1)^2.15 = 1.0
 * - Ratio: 100x
 *
 * With small amounts, center bins can round to 0 atoms -> MUST filter!
 */
export function weightsBidAsk(numBins: number): number[] {
  if (numBins <= 2) {
    return normalizeWeights(Array.from({ length: numBins }, () => 1));
  }

  const mid = (numBins - 1) / 2;
  const denom = Math.max(1, mid);
  const p = 2.15;

  const weights = Array.from({ length: numBins }, (_, i) => {
    const d = Math.abs(i - mid) / denom; // 0 at center, 1 at edges
    // Shape: low center, high edges
    const shaped = Math.pow(0.10 + 0.90 * d, p);
    return shaped;
  });

  return normalizeWeights(weights);
}

/**
 * Generate curve distribution (wide bell curve)
 */
export function weightsCurve(numBins: number): number[] {
  return weightsGaussian(numBins, Math.max(1.2, numBins / 4.6), 0);
}

/**
 * Calculate distribution weights based on strategy
 *
 * @param strategy - Distribution strategy name
 * @param numBins - Total number of bins
 * @param decay - Decay factor for curves that use it (0..1)
 * @returns Array of normalized weights (sum = 1)
 */
export function calculateDistributionWeights(
  strategy: string,
  numBins: number,
  decay: number
): number[] {
  switch (strategy) {
    case "uniform":
      return weightsUniform(numBins);
    case "concentrated":
      return weightsConcentrated(numBins, decay);
    case "skew_bid":
      return weightsSkewBid(numBins, decay);
    case "skew_ask":
      return weightsSkewAsk(numBins, decay);
    case "bid-ask":
      return weightsBidAsk(numBins);
    case "curve":
      return weightsCurve(numBins);
    case "custom":
      // Default to concentrated for custom (user can adjust decay)
      return weightsConcentrated(numBins, decay);
    default:
      return weightsUniform(numBins);
  }
}

// ALLOCATION (BigInt-compatible for atoms)

/**
 * Allocate amounts to bins based on distribution weights
 *
 * CRITICAL DIFFERENCES from frontend version:
 * - Works with BigInt atoms (not number decimals)
 * - Does NOT include active bin (deposits to active bin are forbidden)
 * - Handles remainder atoms by distributing to first N bins
 *
 * @param binIndices - Array of bin indices (EXCLUDING active bin)
 * @param weights - Normalized weights (must match binIndices.length)
 * @param baseAtoms - Total base token atoms to distribute
 * @param quoteAtoms - Total quote token atoms to distribute
 * @param activeBin - Active bin index (divides base/quote sides)
 * @returns Array of bin allocations with atom amounts
 *
 * Distribution logic:
 * - Bins < activeBin get QUOTE only (for BaseToQuote swaps)
 * - Bins > activeBin get BASE only (for QuoteToBase swaps)
 * - Active bin is EXCLUDED (deposits forbidden by program)
 */
export function allocateToBins(
  binIndices: number[],
  weights: number[],
  baseAtoms: bigint,
  quoteAtoms: bigint,
  activeBin: number
): BinAllocation[] {
  if (binIndices.length !== weights.length) {
    throw new Error(
      `Bins and weights length mismatch: ${binIndices.length} vs ${weights.length}`
    );
  }

  if (binIndices.length === 0) return [];

  const allocations: BinAllocation[] = [];

  // Separate bins by side of active bin
  const leftBins: Array<{ index: number; weight: number }> = [];
  const rightBins: Array<{ index: number; weight: number }> = [];

  binIndices.forEach((binIndex, i) => {
    const weight = weights[i] || 0;
    if (binIndex < activeBin) {
      leftBins.push({ index: binIndex, weight });
    } else if (binIndex > activeBin) {
      rightBins.push({ index: binIndex, weight });
    }
    // Note: activeBin NOT in binIndices (excluded before calling this function)
  });

  // Normalize weights within each side
  const leftWeights = normalizeWeights(leftBins.map((b) => b.weight));
  const rightWeights = normalizeWeights(rightBins.map((b) => b.weight));

  // Allocate QUOTE to left side (bins < activeBin)
  const quoteAllocations: BinAllocation[] = [];
  if (leftBins.length > 0 && quoteAtoms > 0n) {
    const totalLeftWeight = sum(leftWeights);
    if (totalLeftWeight > 0) {
      leftBins.forEach((bin, i) => {
        const weight = leftWeights[i];
        const quoteAmount = BigInt(Math.floor(Number(quoteAtoms) * weight));

        quoteAllocations.push({
          binIndex: bin.index,
          baseAtoms: 0n,
          quoteAtoms: quoteAmount,
        });
      });

      // Distribute remainder atoms to first N bins (1 atom at a time)
      const totalAllocated = quoteAllocations.reduce((sum, a) => sum + a.quoteAtoms, 0n);
      let remainder = quoteAtoms - totalAllocated;

      let binIdx = 0;
      while (remainder > 0n && binIdx < quoteAllocations.length) {
        quoteAllocations[binIdx].quoteAtoms += 1n;
        remainder -= 1n;
        binIdx++;
      }
    }
  }

  // Allocate BASE to right side (bins > activeBin)
  const baseAllocations: BinAllocation[] = [];
  if (rightBins.length > 0 && baseAtoms > 0n) {
    const totalRightWeight = sum(rightWeights);
    if (totalRightWeight > 0) {
      rightBins.forEach((bin, i) => {
        const weight = rightWeights[i];
        const baseAmount = BigInt(Math.floor(Number(baseAtoms) * weight));

        baseAllocations.push({
          binIndex: bin.index,
          baseAtoms: baseAmount,
          quoteAtoms: 0n,
        });
      });

      // Distribute remainder atoms to first N bins (1 atom at a time)
      const totalAllocated = baseAllocations.reduce((sum, a) => sum + a.baseAtoms, 0n);
      let remainder = baseAtoms - totalAllocated;

      let binIdx = 0;
      while (remainder > 0n && binIdx < baseAllocations.length) {
        baseAllocations[binIdx].baseAtoms += 1n;
        remainder -= 1n;
        binIdx++;
      }
    }
  }

  // Combine allocations
  allocations.push(...quoteAllocations, ...baseAllocations);

  // Sort by bin index
  allocations.sort((a, b) => a.binIndex - b.binIndex);

  return allocations;
}

// VALIDATION

/**
 * Validate distribution and filter zero-atom bins
 *
 * This is the CRITICAL security layer that prevents on-chain errors.
 * Performs 5 checks:
 * 1. No bins with both base AND quote (should be impossible)
 * 2. Filter zero-atom bins (would fail on-chain with InvalidLiquidity)
 * 3. Ensure at least some deposits (can't all be zero)
 * 4. Verify sum equals input (within rounding tolerance)
 * 5. Detect duplicate bins (would violate program constraints)
 *
 * @param allocations - Bin allocations to validate
 * @param expectedBase - Expected total base atoms
 * @param expectedQuote - Expected total quote atoms
 * @returns Validation result with filtered deposits
 */
export function validateDistribution(
  allocations: BinAllocation[],
  expectedBase: bigint,
  expectedQuote: bigint
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // No bins with BOTH base AND quote (impossible)
  const invalidBins = allocations.filter(a => a.baseAtoms > 0n && a.quoteAtoms > 0n);
  if (invalidBins.length > 0) {
    errors.push(`${invalidBins.length} bins have both base and quote (should be impossible)`);
  }

  // Filter out zero-atom bins (is failing on-chain)
  const filteredDeposits = allocations.filter(a => a.baseAtoms > 0n || a.quoteAtoms > 0n);
  const zeroAtomCount = allocations.length - filteredDeposits.length;

  if (zeroAtomCount > 0) {
    warnings.push(
      `Filtered ${zeroAtomCount} bins with zero atoms (rounding effect). ` +
      `Consider using uniform/balanced strategy or larger amounts.`
    );
  }

  // Ensure we have at least SOME deposits
  if (filteredDeposits.length === 0) {
    errors.push("All bins rounded to zero atoms. Amount too small for bin count.");
  }

  // Verify sum equals input (within rounding tolerance)
  const totalBase = filteredDeposits.reduce((sum, d) => sum + d.baseAtoms, 0n);
  const totalQuote = filteredDeposits.reduce((sum, d) => sum + d.quoteAtoms, 0n);

  // Allow small rounding difference (up to 10 atoms per bin)
  const maxTolerance = BigInt(allocations.length * 10);

  const baseDiff = totalBase > expectedBase ? totalBase - expectedBase : expectedBase - totalBase;
  const quoteDiff = totalQuote > expectedQuote ? totalQuote - expectedQuote : expectedQuote - totalQuote;

  if (baseDiff > maxTolerance) {
    errors.push(
      `Base atom sum mismatch: expected ${expectedBase}, got ${totalBase} ` +
      `(diff: ${baseDiff}, tolerance: ${maxTolerance})`
    );
  }

  if (quoteDiff > maxTolerance) {
    errors.push(
      `Quote atom sum mismatch: expected ${expectedQuote}, got ${totalQuote} ` +
      `(diff: ${quoteDiff}, tolerance: ${maxTolerance})`
    );
  }

  // Verify no duplicate bins
  const uniqueBins = new Set(filteredDeposits.map(d => d.binIndex));
  if (uniqueBins.size !== filteredDeposits.length) {
    errors.push("Duplicate bin indices detected");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    deposits: filteredDeposits,
  };
}
