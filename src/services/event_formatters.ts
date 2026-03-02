import type { VersionedTransactionResponse, PublicKey } from "@solana/web3.js";
import type { Trade } from "./trades_indexer.js";

type AccountKeyLike = PublicKey | string | { pubkey: PublicKey };
type TokenBalanceLike = { accountIndex?: number; uiTokenAmount?: { amount?: string } };

type PoolView = {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseVault: string;
  quoteVault: string;
  activeBin: number;
  priceNumber: number | null;
};

/**
 * Decimalize bigint atoms into a decimal string.
 * - No rounding
 * - Trims trailing zeros
 */
function decimalize(atoms: bigint, decimals: number): string {
  const sign = atoms < 0n ? "-" : "";
  const x = atoms < 0n ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = x % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length ? `${sign}${whole.toString()}.${fracStr}` : `${sign}${whole.toString()}`;
}

/**
 * Strict decimal division to string without floating point.
 * Computes (num / den) as a decimal string with up to `scale` fractional digits.
 * Trims trailing zeros.
 */
function divToDecimalString(num: bigint, den: bigint, scale = 50): string | null {
  if (den === 0n) return null;
  if (num === 0n) return "0";

  const sign = (num < 0n) !== (den < 0n) ? "-" : "";
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;

  const whole = n / d;
  let rem = n % d;

  if (rem === 0n) return sign + whole.toString();

  let frac = "";
  for (let i = 0; i < scale && rem !== 0n; i++) {
    rem *= 10n;
    const digit = rem / d;
    rem = rem % d;
    frac += digit.toString();
  }

  frac = frac.replace(/0+$/, "");
  return frac.length ? `${sign}${whole.toString()}.${frac}` : sign + whole.toString();
}

function toText(value: unknown, depth = 0): string | null {
  if (value == null || depth > 3) return null;

  if (typeof value === "string") {
    const s = value.trim();
    return s.length ? s : null;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value !== "object") return null;

  const v = value as Record<string, unknown> & {
    toBase58?: () => string;
    toString?: (...args: any[]) => string;
  };

  if (typeof v.toBase58 === "function") {
    try {
      const s = v.toBase58();
      if (typeof s === "string" && s.trim().length > 0) return s.trim();
    } catch {}
  }

  if (typeof v.toString === "function") {
    try {
      const s = v.toString();
      const t = typeof s === "string" ? s.trim() : "";
      if (t.length > 0 && t !== "[object Object]") return t;
    } catch {}
  }

  if ("value" in v) {
    const nested = toText(v.value, depth + 1);
    if (nested) return nested;
  }

  const nestedKeys = ["pubkey", "publicKey", "key", "pool", "pairId", "poolId"] as const;
  for (const key of nestedKeys) {
    const nested = toText(v[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function toAddress(value: unknown): string | null {
  const s = toText(value);
  return s && s.length >= 32 ? s : null;
}

function parseBigIntString(value: string): bigint | null {
  const s = value.trim();
  if (!s) return null;

  if (/^[+-]?0x[0-9a-fA-F]+$/.test(s)) {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }

  if (/^[+-]?[0-9]+n$/.test(s)) {
    try {
      return BigInt(s.slice(0, -1));
    } catch {
      return null;
    }
  }

  if (/^[+-]?[0-9]+$/.test(s)) {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }

  const bnHex = s.match(/^<BN:\s*([0-9a-fA-F]+)\s*>$/);
  if (bnHex) {
    try {
      return BigInt(`0x${bnHex[1]}`);
    } catch {
      return null;
    }
  }

  return null;
}

function toBigIntValue(value: unknown): bigint | null {
  if (value == null) return null;

  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    return BigInt(value);
  }

  if (typeof value === "string") {
    return parseBigIntString(value);
  }

  if (typeof value !== "object") return null;

  const v = value as Record<string, unknown> & { toString?: (...args: any[]) => string };

  if (typeof v.toString === "function") {
    try {
      const maybeDec = v.toString(10);
      const parsed = typeof maybeDec === "string" ? parseBigIntString(maybeDec) : null;
      if (parsed != null) return parsed;
    } catch {}

    try {
      const maybe = v.toString();
      const parsed = typeof maybe === "string" ? parseBigIntString(maybe) : null;
      if (parsed != null) return parsed;
    } catch {}
  }

  if ("value" in v) {
    return toBigIntValue(v.value);
  }

  return null;
}

function toBigIntString(value: unknown, fallback = "0"): string {
  const n = toBigIntValue(value);
  if (n != null) return n.toString();
  const s = toText(value);
  return s ?? fallback;
}

function poolFromEventData(eventData: any): string | null {
  return toAddress(eventData?.pool) ?? toAddress(eventData?.pairId) ?? toAddress(eventData?.poolId);
}

function keyToString(k: AccountKeyLike | null): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  if ("pubkey" in k) return k.pubkey.toBase58();
  return k.toBase58();
}

function getAllAccountKeys(tx: VersionedTransactionResponse): AccountKeyLike[] {
  const msg = tx.transaction.message;

  // legacy
  if ("accountKeys" in msg) {
    return msg.accountKeys as AccountKeyLike[];
  }

  // v0
  const staticKeys = msg.staticAccountKeys as PublicKey[];
  const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []) as PublicKey[];
  const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []) as PublicKey[];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function findAccountIndex(tx: VersionedTransactionResponse, address: string): number {
  const keys = getAllAccountKeys(tx);
  for (let i = 0; i < keys.length; i++) {
    if (keyToString(keys[i] ?? null) === address) return i;
  }
  return -1;
}

function toAmountMap(balances: readonly TokenBalanceLike[] | null | undefined): Map<number, bigint> {
  const m = new Map<number, bigint>();
  for (const b of balances ?? []) {
    const idx = Number(b.accountIndex);
    const raw = b.uiTokenAmount?.amount;
    if (!Number.isFinite(idx) || typeof raw !== "string") continue;
    try {
      m.set(idx, BigInt(raw));
    } catch {
      /* ignore */
    }
  }
  return m;
}

/**
 * Compute vault reserves AFTER this tx from tx.meta.postTokenBalances.
 */
function getPostVaultReservesAtoms(
  tx: VersionedTransactionResponse,
  poolView: PoolView
): { base: bigint; quote: bigint } | null {
  if (!tx.meta) return null;

  const baseIdx = findAccountIndex(tx, poolView.baseVault);
  const quoteIdx = findAccountIndex(tx, poolView.quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const post = toAmountMap(tx.meta.postTokenBalances as any);

  const basePost = post.get(baseIdx);
  const quotePost = post.get(quoteIdx);
  if (basePost == null || quotePost == null) return null;

  return { base: basePost, quote: quotePost };
}

/**
 * Get pre-transaction vault balances
 */
function getPreVaultReservesAtoms(
  tx: VersionedTransactionResponse,
  poolView: PoolView
): { base: bigint; quote: bigint } | null {
  if (!tx.meta) return null;

  const baseIdx = findAccountIndex(tx, poolView.baseVault);
  const quoteIdx = findAccountIndex(tx, poolView.quoteVault);
  if (baseIdx < 0 || quoteIdx < 0) return null;

  const pre = toAmountMap(tx.meta.preTokenBalances as any);

  const basePre = pre.get(baseIdx);
  const quotePre = pre.get(quoteIdx);
  if (basePre == null || quotePre == null) return null;

  return { base: basePre, quote: quotePre };
}

/**
 * SwapExecuted Event
 */
export function formatSwapExecuted(args: {
  tx: VersionedTransactionResponse;
  trade: Trade;
  poolView: PoolView;
}): any | null {
  const { tx, trade, poolView } = args;

  if (!trade.amountIn || !trade.amountOut || !trade.inMint || !trade.outMint) return null;

  const postRes = getPostVaultReservesAtoms(tx, poolView);
  if (!postRes) return null;

  const reserves = {
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  };

  const inAtoms = BigInt(trade.amountIn);
  const outAtoms = BigInt(trade.amountOut);

  // Base -> Quote swap
  if (trade.inMint === poolView.baseMint && trade.outMint === poolView.quoteMint) {
    const num = outAtoms * 10n ** BigInt(poolView.baseDecimals);
    const den = inAtoms * 10n ** BigInt(poolView.quoteDecimals);
    const priceNative = divToDecimalString(num, den, 50);
    if (!priceNative || priceNative === "0") return null;

    return {
      maker: trade.user ?? "11111111111111111111111111111111",
      pairId: trade.pool,
      asset0In: decimalize(inAtoms, poolView.baseDecimals),
      asset1Out: decimalize(outAtoms, poolView.quoteDecimals),
      priceNative,
      reserves,
    };
  }

  // Quote -> Base swap
  if (trade.inMint === poolView.quoteMint && trade.outMint === poolView.baseMint) {
    const num = inAtoms * 10n ** BigInt(poolView.baseDecimals);
    const den = outAtoms * 10n ** BigInt(poolView.quoteDecimals);
    const priceNative = divToDecimalString(num, den, 50);
    if (!priceNative || priceNative === "0") return null;

    return {
      maker: trade.user ?? "11111111111111111111111111111111",
      pairId: trade.pool,
      asset1In: decimalize(inAtoms, poolView.quoteDecimals),
      asset0Out: decimalize(outAtoms, poolView.baseDecimals),
      priceNative,
      reserves,
    };
  }

  return null;
}

/**
 * LiquidityDeposited Event
 * Emitted when a user deposits liquidity and receives LP shares
 */
export function formatLiquidityDeposited(args: {
  tx: VersionedTransactionResponse;
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { tx, eventData, poolView } = args;

  const pool = poolFromEventData(eventData);
  const user = toAddress(eventData.user);
  const baseAmount = toBigIntValue(eventData.baseAmount);
  const quoteAmount = toBigIntValue(eventData.quoteAmount);
  const sharesMinted = toBigIntString(eventData.sharesMinted);

  if (!pool || baseAmount == null || quoteAmount == null) return null;

  const postRes = getPostVaultReservesAtoms(tx, poolView);
  if (!postRes) return null;

  const reserves = {
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  };

  // Calculate price from post-deposit reserves
  const priceNative = divToDecimalString(
    postRes.quote * 10n ** BigInt(poolView.baseDecimals),
    postRes.base * 10n ** BigInt(poolView.quoteDecimals),
    50
  );

  return {
    maker: user ?? "11111111111111111111111111111111",
    pairId: pool,
    eventType: "liquidityDeposit",
    asset0Amount: decimalize(baseAmount, poolView.baseDecimals),
    asset1Amount: decimalize(quoteAmount, poolView.quoteDecimals),
    shares: sharesMinted,
    priceNative: priceNative ?? "0",
    reserves,
  };
}

/**
 * LiquidityWithdrawnUser Event
 * Emitted when a user withdraws liquidity by burning LP shares
 */
export function formatLiquidityWithdrawnUser(args: {
  tx: VersionedTransactionResponse;
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { tx, eventData, poolView } = args;

  const pool = poolFromEventData(eventData);
  const user = toAddress(eventData.user);
  const sharesBurned = toBigIntString(eventData.sharesBurned);
  const baseAmountOut = toBigIntValue(eventData.baseAmountOut);
  const quoteAmountOut = toBigIntValue(eventData.quoteAmountOut);

  if (!pool || baseAmountOut == null || quoteAmountOut == null) return null;

  const postRes = getPostVaultReservesAtoms(tx, poolView);
  if (!postRes) return null;

  const reserves = {
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  };

  const priceNative = divToDecimalString(
    postRes.quote * 10n ** BigInt(poolView.baseDecimals),
    postRes.base * 10n ** BigInt(poolView.quoteDecimals),
    50
  );

  return {
    maker: user ?? "11111111111111111111111111111111",
    pairId: pool,
    eventType: "liquidityWithdraw",
    asset0Amount: decimalize(baseAmountOut, poolView.baseDecimals),
    asset1Amount: decimalize(quoteAmountOut, poolView.quoteDecimals),
    shares: sharesBurned,
    priceNative: priceNative ?? "0",
    reserves,
  };
}

/**
 * BinLiquidityUpdated Event
 * Emitted whenever a bin's reserves change
 */
export function formatBinLiquidityUpdated(args: {
  tx: VersionedTransactionResponse;
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { tx, eventData, poolView } = args;

  const pool = poolFromEventData(eventData);
  const binIndex = toBigIntString(eventData.binIndex);
  const deltaBase = toBigIntValue(eventData.deltaBase) ?? 0n;
  const deltaQuote = toBigIntValue(eventData.deltaQuote) ?? 0n;
  const reserveBase = toBigIntValue(eventData.reserveBase);
  const reserveQuote = toBigIntValue(eventData.reserveQuote);

  if (!pool || reserveBase == null || reserveQuote == null) return null;

  const postRes = getPostVaultReservesAtoms(tx, poolView);

  const reserves = postRes ? {
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  } : {
    asset0: "0",
    asset1: "0",
  };

  return {
    pairId: pool,
    eventType: "binLiquidityUpdate",
    binIndex,
    deltaBase: decimalize(deltaBase, poolView.baseDecimals),
    deltaQuote: decimalize(deltaQuote, poolView.quoteDecimals),
    reserveBase: decimalize(reserveBase, poolView.baseDecimals),
    reserveQuote: decimalize(reserveQuote, poolView.quoteDecimals),
    reserves,
  };
}

/**
 * FeesDistributed Event
 * Emitted when fees are split to fee vaults during swap
 */
export function formatFeesDistributed(args: {
  tx: VersionedTransactionResponse;
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const totalFee = eventData.totalFee;
  const creatorFee = eventData.creatorFee;
  const holdersFee = eventData.holdersFee;
  const nftFee = eventData.nftFee;
  const creatorExtraFee = eventData.creatorExtraFee;

  if (!pool || totalFee == null) return null;

  return {
    pairId: pool,
    eventType: "feesDistributed",
    totalFee: toBigIntString(totalFee),
    creatorFee: toBigIntString(creatorFee),
    holdersFee: toBigIntString(holdersFee),
    nftFee: toBigIntString(nftFee),
    creatorExtraFee: toBigIntString(creatorExtraFee),
  };
}

/**
 * FeeConfigUpdated Event
 * Emitted whenever the fee configuration is changed
 */
export function formatFeeConfigUpdated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const baseFeeBps = eventData.baseFeeBps;
  const creatorCutBps = eventData.creatorCutBps;
  const splitHoldersMicrobps = eventData.splitHoldersMicrobps;
  const splitNftMicrobps = eventData.splitNftMicrobps;
  const splitCreatorExtraMicrobps = eventData.splitCreatorExtraMicrobps;

  if (!pool) return null;

  return {
    pairId: pool,
    eventType: "feeConfigUpdate",
    baseFeeBps: toBigIntString(baseFeeBps),
    creatorCutBps: toBigIntString(creatorCutBps),
    splitHoldersMicrobps: toBigIntString(splitHoldersMicrobps),
    splitNftMicrobps: toBigIntString(splitNftMicrobps),
    splitCreatorExtraMicrobps: toBigIntString(splitCreatorExtraMicrobps),
  };
}

/**
 * PoolInitialized Event
 * Emitted once when a pool is initialized
 */
export function formatPoolInitialized(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData, poolView } = args;

  const pool = poolFromEventData(eventData);
  const admin = toAddress(eventData.admin);
  const creator = toAddress(eventData.creator);
  const baseMint = toAddress(eventData.baseMint);
  const quoteMint = toAddress(eventData.quoteMint);
  const binStepBps = eventData.binStepBps;
  const initialPriceQ6464 = eventData.initialPriceQ6464;

  if (!pool || !baseMint || !quoteMint) return null;

  return {
    pairId: pool,
    eventType: "poolInit",
    admin: admin ?? "11111111111111111111111111111111",
    creator: creator ?? "11111111111111111111111111111111",
    asset0: baseMint,
    asset1: quoteMint,
    binStepBps: toBigIntString(binStepBps),
    initialPrice: toBigIntString(initialPriceQ6464),
  };
}

/**
 * BinArrayCreated Event
 * Emitted when a new BinArray is created
 */
export function formatBinArrayCreated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const lowerBinIndex = eventData.lowerBinIndex;
  const binArray = toAddress(eventData.binArray) ?? toText(eventData.binArray);

  if (!pool || !binArray) return null;

  return {
    pairId: pool,
    eventType: "binArrayCreate",
    lowerBinIndex: toBigIntString(lowerBinIndex),
    binArray,
  };
}

/**
 * LiquidityBinCreated Event
 * Emitted when a new liquidity bin is created
 */
export function formatLiquidityBinCreated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const binIndex = toBigIntValue(eventData.binIndex);
  const lowerBoundQ6464 = eventData.lowerBoundQ6464;
  const upperBoundQ6464 = eventData.upperBoundQ6464;
  const initialTotalShares = eventData.initialTotalShares;

  if (!pool || binIndex == null) return null;

  return {
    pairId: pool,
    eventType: "liquidityBinCreate",
    binIndex: binIndex.toString(),
    lowerBound: toBigIntString(lowerBoundQ6464),
    upperBound: toBigIntString(upperBoundQ6464),
    initialShares: toBigIntString(initialTotalShares),
  };
}

/**
 * AdminUpdated Event
 * Emitted when the admin rotates to a new key
 */
export function formatAdminUpdated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const oldAdmin = toAddress(eventData.oldAdmin);
  const newAdmin = toAddress(eventData.newAdmin);

  if (!pool || !newAdmin) return null;

  return {
    pairId: pool,
    eventType: "adminUpdate",
    oldAdmin: oldAdmin ?? "11111111111111111111111111111111",
    newAdmin,
  };
}

/**
 * AuthoritiesUpdated Event
 * Emitted when auxiliary authorities are updated
 */
export function formatAuthoritiesUpdated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const configAuthority = toAddress(eventData.configAuthority);
  const pauseGuardian = toAddress(eventData.pauseGuardian);
  const feeWithdrawAuthority = toAddress(eventData.feeWithdrawAuthority);

  if (!pool) return null;

  return {
    pairId: pool,
    eventType: "authoritiesUpdate",
    configAuthority: configAuthority ?? "11111111111111111111111111111111",
    pauseGuardian: pauseGuardian ?? "11111111111111111111111111111111",
    feeWithdrawAuthority: feeWithdrawAuthority ?? "11111111111111111111111111111111",
  };
}

/**
 * PauseUpdated Event
 * Emitted when pause bitmask changes
 */
export function formatPauseUpdated(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const admin = toAddress(eventData.admin);
  const paused = eventData.paused;

  if (!pool) return null;

  return {
    pairId: pool,
    eventType: "pauseUpdate",
    admin: admin ?? "11111111111111111111111111111111",
    paused: toBigIntString(paused),
  };
}

/**
 * PairRegistered Event
 * Emitted when a pair is registered
 */
export function formatPairRegistered(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const baseMint = toAddress(eventData.baseMint);
  const quoteMint = toAddress(eventData.quoteMint);
  const pool = poolFromEventData(eventData);
  const binStepBps = eventData.binStepBps;

  if (!pool || !baseMint || !quoteMint) return null;

  return {
    pairId: pool,
    eventType: "pairRegister",
    asset0: baseMint,
    asset1: quoteMint,
    binStepBps: toBigIntString(binStepBps),
  };
}

/**
 * LiquidityLocked Event
 * Emitted when a user locks liquidity
 */
export function formatLiquidityLocked(args: {
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { eventData } = args;

  const pool = poolFromEventData(eventData);
  const user = toAddress(eventData.user);
  const amount = toBigIntValue(eventData.amount);
  const lockEnd = eventData.lockEnd;

  if (!pool || !user || amount == null) return null;

  return {
    pairId: pool,
    eventType: "liquidityLock",
    maker: user,
    amount: amount.toString(),
    lockEnd: toBigIntString(lockEnd),
  };
}

/**
 * LiquidityWithdrawnAdmin Event
 * Emitted when an admin performs a legacy/admin-only withdrawal
 */
export function formatLiquidityWithdrawnAdmin(args: {
  tx: VersionedTransactionResponse;
  eventData: any;
  poolView: PoolView;
}): any | null {
  const { tx, eventData, poolView } = args;

  const pool = poolFromEventData(eventData);
  const admin = toAddress(eventData.admin);
  const baseAmountOut = toBigIntValue(eventData.baseAmountOut);
  const quoteAmountOut = toBigIntValue(eventData.quoteAmountOut);

  if (!pool || !admin || baseAmountOut == null || quoteAmountOut == null) return null;

  const postRes = getPostVaultReservesAtoms(tx, poolView);
  if (!postRes) return null;

  const reserves = {
    asset0: decimalize(postRes.base, poolView.baseDecimals),
    asset1: decimalize(postRes.quote, poolView.quoteDecimals),
  };

  return {
    pairId: pool,
    eventType: "adminWithdraw",
    admin,
    asset0Amount: decimalize(baseAmountOut, poolView.baseDecimals),
    asset1Amount: decimalize(quoteAmountOut, poolView.quoteDecimals),
    reserves,
  };
}

/**
 * Format any event based on event name
 */
export function formatEventData(args: {
  tx: VersionedTransactionResponse;
  eventName: string;
  eventData: any;
  trade: Trade | null;
  poolView: PoolView;
}): any | null {
  const { tx, eventName, eventData, trade, poolView } = args;

  switch (eventName) {
    case "SwapExecuted":
      return trade ? formatSwapExecuted({ tx, trade, poolView }) : null;

    case "LiquidityDeposited":
    case "LiquidityDepositedUser":
    case "LiquidityAddedUser":
      return formatLiquidityDeposited({ tx, eventData, poolView });

    case "LiquidityWithdrawnUser":
    case "LiquidityRemovedUser":
      return formatLiquidityWithdrawnUser({ tx, eventData, poolView });

    case "BinLiquidityUpdated":
      return formatBinLiquidityUpdated({ tx, eventData, poolView });

    case "FeesDistributed":
      return formatFeesDistributed({ tx, eventData, poolView });

    case "FeeConfigUpdated":
      return formatFeeConfigUpdated({ eventData, poolView });

    case "PoolInitialized":
      return formatPoolInitialized({ eventData, poolView });

    case "BinArrayCreated":
      return formatBinArrayCreated({ eventData, poolView });

    case "LiquidityBinCreated":
      return formatLiquidityBinCreated({ eventData, poolView });

    case "AdminUpdated":
      return formatAdminUpdated({ eventData, poolView });

    case "AuthoritiesUpdated":
      return formatAuthoritiesUpdated({ eventData, poolView });

    case "PauseUpdated":
      return formatPauseUpdated({ eventData, poolView });

    case "PairRegistered":
      return formatPairRegistered({ eventData, poolView });

    case "LiquidityLocked":
      return formatLiquidityLocked({ eventData, poolView });

    case "LiquidityWithdrawnAdmin":
      return formatLiquidityWithdrawnAdmin({ tx, eventData, poolView });

    default:
      // Unknown event, return raw data with minimal structure
      return {
        eventType: eventName,
        ...eventData,
      };
  }
}

/**
 * Get the standard event type name
 */
export function getStandardEventType(eventName: string): string {
  switch (eventName) {
    case "SwapExecuted":
      return "swap";
    case "LiquidityDeposited":
    case "LiquidityDepositedUser":
    case "LiquidityAddedUser":
      return "liquidityDeposit";
    case "LiquidityWithdrawnUser":
    case "LiquidityRemovedUser":
      return "liquidityWithdraw";
    case "BinLiquidityUpdated":
      return "binLiquidityUpdate";
    case "FeesDistributed":
      return "feesDistributed";
    case "FeeConfigUpdated":
      return "feeConfigUpdate";
    case "PoolInitialized":
      return "poolInit";
    case "BinArrayCreated":
      return "binArrayCreate";
    case "LiquidityBinCreated":
      return "liquidityBinCreate";
    case "AdminUpdated":
      return "adminUpdate";
    case "AuthoritiesUpdated":
      return "authoritiesUpdate";
    case "PauseUpdated":
      return "pauseUpdate";
    case "PairRegistered":
      return "pairRegister";
    case "LiquidityLocked":
      return "liquidityLock";
    case "LiquidityWithdrawnAdmin":
      return "adminWithdraw";
    default:
      return eventName.toLowerCase();
  }
}
