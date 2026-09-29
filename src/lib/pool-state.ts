import { PublicKey } from '@solana/web3.js';
import {
  getPriceFromSqrtPrice,
  getTokenDecimals as sdkGetTokenDecimals,
  TokenDecimal,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getConnection, getDbcClient } from './solana';
import type { TrackedPool } from './pool-registry';

/**
 * Live on-chain state for a DBC pool.
 *
 * Everything here is read from the chain at request time:
 * - price is computed from the pool's sqrtPrice via the SDK's curve math
 * - progress = quoteReserve / migrationQuoteThreshold (real graduation gauge)
 * - marketCap = price x base mint total supply
 *
 * Nothing is estimated from mocks. When the RPC read fails the result is
 * marked `stale` so the UI can say so instead of showing a fake number.
 */

export interface PoolLiveState {
  /** Quote tokens per 1 base token, e.g. SOL per token. Null when unreadable. */
  price: number | null;
  /** Quote reserve in UI units (not lamports). */
  quoteReserve: number | null;
  /** Base reserve in UI units. */
  baseReserve: number | null;
  /** 0-100 progress toward the migration (graduation) threshold. */
  progress: number | null;
  graduated: boolean;
  hasSwap: boolean;
  /** Market cap denominated in quote tokens. */
  marketCap: number | null;
  baseDecimals: number;
  quoteDecimals: number;
  /** Migration threshold in quote UI units. */
  migrationQuoteThreshold: number | null;
  /**
   * Accrued creator trading fees in RAW integer units (decimal string, never
   * floats, u64 values can exceed float precision). Null when unreadable.
   * Base fee accrues in base tokens, quote fee in quote tokens.
   */
  creatorBaseFeeRaw: string | null;
  /** Accrued creator quote fee in raw integer units (decimal string). */
  creatorQuoteFeeRaw: string | null;
  /** True when the on-chain read failed; values may be partial. */
  stale: boolean;
}

const decimalsCache = new Map<string, number>();

/**
 * Reads mint decimals from chain and caches the result (decimals are
 * immutable). Fallbacks are never cached: a temporary RPC failure must not
 * poison price math for the rest of the process lifetime.
 */
async function getMintDecimals(mint: string): Promise<number> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const d = await sdkGetTokenDecimals(getConnection(), new PublicKey(mint));
  decimalsCache.set(mint, d);
  return d;
}

function toTokenDecimalEnum(decimals: number): TokenDecimal {
  if (decimals <= 6) return TokenDecimal.SIX;
  if (decimals === 7) return TokenDecimal.SEVEN;
  if (decimals === 8) return TokenDecimal.EIGHT;
  return TokenDecimal.NINE;
}

function bnToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  try {
    // BN instances stringify exactly; numbers pass through.
    const s = typeof v === 'object' ? (v as { toString(): string }).toString() : String(v);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function bnToRawString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  try {
    // BN instances stringify exactly; plain numbers pass through.
    // Raw strings only, never floats, so u64 precision is preserved.
    const s = typeof v === 'object' ? (v as { toString(radix?: number): string }).toString(10) : String(v);
    return /^\d+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

export async function fetchPoolLiveState(tracked: TrackedPool): Promise<PoolLiveState> {
  const failed: PoolLiveState = {
    price: null,
    quoteReserve: null,
    baseReserve: null,
    progress: null,
    graduated: false,
    hasSwap: false,
    marketCap: null,
    baseDecimals: 9,
    quoteDecimals: 9,
    migrationQuoteThreshold: null,
    creatorBaseFeeRaw: null,
    creatorQuoteFeeRaw: null,
    stale: true,
  };

  try {
    const client = getDbcClient();
    const poolAddress = new PublicKey(tracked.poolAddress);

    // Wave 1: independent reads in parallel (one shared 8s abort budget each).
    const [pool, config, supplyRes] = await Promise.all([
      client.state.getPool(poolAddress),
      client.state.getPoolConfig(new PublicKey(tracked.configAddress)),
      getConnection().getTokenSupply(new PublicKey(tracked.baseMint)),
    ]);
    if (!pool) throw new Error('Pool account not found');

    // The IDL wraps the struct: { poolState: { ... } }. Handle both shapes.
    const ps = ((pool as unknown as { poolState?: unknown }).poolState ?? pool) as Record<string, unknown>;

    // Wave 2: decimals. The config's tokenDecimal is the fallback for the
    // base mint when its mint account is unreadable.
    const configTokenDecimal =
      typeof config?.tokenDecimal === 'number' ? config.tokenDecimal : undefined;
    const [baseDecimals, quoteDecimals] = await Promise.all([
      getMintDecimals(tracked.baseMint).catch(() => configTokenDecimal ?? 9),
      getMintDecimals(tracked.quoteMint).catch(() => 9),
    ]);

    const sqrtPrice = ps['sqrtPrice'] as unknown;
    let price: number | null = null;
    if (sqrtPrice) {
      try {
        const p = getPriceFromSqrtPrice(sqrtPrice as never, toTokenDecimalEnum(baseDecimals), quoteDecimals);
        const n = Number(p.toString());
        price = Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        price = null;
      }
    }

    const quoteReserveRaw = bnToNumber(ps['quoteReserve']);
    const baseReserveRaw = bnToNumber(ps['baseReserve']);
    const quoteReserve = quoteReserveRaw === null ? null : quoteReserveRaw / 10 ** quoteDecimals;
    const baseReserve = baseReserveRaw === null ? null : baseReserveRaw / 10 ** baseDecimals;

    const migrationThresholdRaw = config ? bnToNumber((config as unknown as Record<string, unknown>)['migrationQuoteThreshold']) : null;
    const migrationQuoteThreshold =
      migrationThresholdRaw === null ? null : migrationThresholdRaw / 10 ** quoteDecimals;

    const progress =
      quoteReserve !== null && migrationQuoteThreshold !== null && migrationQuoteThreshold > 0
        ? Math.min(100, Math.max(0, (quoteReserve / migrationQuoteThreshold) * 100))
        : null;

    const graduated = Number(ps['isMigrated'] ?? 0) === 1 || (progress !== null && progress >= 100);
    const hasSwap = Number(ps['hasSwap'] ?? 0) === 1;

    // Market cap = live price x total base supply (from the mint account,
    // fetched in wave 1 so this costs no extra RPC round trip).
    let marketCap: number | null = null;
    if (price !== null) {
      const uiAmount = supplyRes?.value?.uiAmount;
      if (typeof uiAmount === 'number' && Number.isFinite(uiAmount)) {
        marketCap = price * uiAmount;
      }
    }

    return {
      price,
      quoteReserve,
      baseReserve,
      progress,
      graduated,
      hasSwap,
      marketCap,
      baseDecimals,
      quoteDecimals,
      migrationQuoteThreshold,
      creatorBaseFeeRaw: bnToRawString(ps['creatorBaseFee']),
      creatorQuoteFeeRaw: bnToRawString(ps['creatorQuoteFee']),
      stale: false,
    };
  } catch {
    return failed;
  }
}
