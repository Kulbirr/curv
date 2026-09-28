import { getDb } from './index';

/**
 * Latest sampled on-chain state per pool — the read model every user-facing
 * API serves from. Written ONLY by the background indexer
 * (src/indexer.ts), which calls fetchPoolLiveState once per pool per
 * interval. API routes never write here and never read the chain.
 *
 * Failure handling: a failed sample never overwrites the last good one.
 * It only advances last_attempt_at and bumps consecutive_failures, so the
 * API keeps serving the most recent real values with stale: true instead
 * of blanking the pool or inventing numbers.
 */

export interface PoolStateSample {
  /** Quote tokens per 1 base token. Null when unreadable. */
  price: number | null;
  /** Quote reserve in UI units. */
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
   * Accrued creator trading fees in RAW integer units (decimal strings).
   * Kept as strings end-to-end: u64 values can exceed float precision,
   * so they are never converted to numbers until display formatting.
   * Optional for backward compatibility; missing normalizes to null.
   */
  creatorBaseFeeRaw?: string | null;
  /** Accrued creator quote fee in raw integer units (decimal string). */
  creatorQuoteFeeRaw?: string | null;
}

export interface StoredPoolState extends PoolStateSample {
  poolAddress: string;
  /** Unix ms of the last SUCCESSFUL sample; null when never sampled. */
  sampledAt: number | null;
  /** Unix ms of the last attempt (success or failure). */
  lastAttemptAt: number | null;
  consecutiveFailures: number;
}

interface StateRow {
  pool_address: string;
  price: number | null;
  quote_reserve: number | null;
  base_reserve: number | null;
  progress: number | null;
  graduated: number;
  has_swap: number;
  market_cap: number | null;
  base_decimals: number;
  quote_decimals: number;
  migration_quote_threshold: number | null;
  creator_base_fee_raw: string | null;
  creator_quote_fee_raw: string | null;
  sampled_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
}

function rowToState(r: StateRow): StoredPoolState {
  return {
    poolAddress: r.pool_address,
    price: r.price,
    quoteReserve: r.quote_reserve,
    baseReserve: r.base_reserve,
    progress: r.progress,
    graduated: r.graduated === 1,
    hasSwap: r.has_swap === 1,
    marketCap: r.market_cap,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    migrationQuoteThreshold: r.migration_quote_threshold,
    creatorBaseFeeRaw: r.creator_base_fee_raw,
    creatorQuoteFeeRaw: r.creator_quote_fee_raw,
    sampledAt: r.sampled_at,
    lastAttemptAt: r.last_attempt_at,
    consecutiveFailures: r.consecutive_failures,
  };
}

export function getPoolState(poolAddress: string): StoredPoolState | null {
  const row = getDb()
    .prepare('SELECT * FROM pool_states WHERE pool_address = ?')
    .get(poolAddress) as unknown as StateRow | undefined;
  return row ? rowToState(row) : null;
}

/**
 * Record one indexer sample. Pass `sample: null` when the on-chain read
 * failed: the last good values are preserved and only the attempt
 * bookkeeping advances. Portable ON CONFLICT upsert (SQLite + Postgres).
 */
export function recordPoolSample(
  poolAddress: string,
  sample: PoolStateSample | null,
  atMs: number,
): void {
  const d = getDb();
  if (sample) {
    d.prepare(
      `INSERT INTO pool_states
       (pool_address, price, quote_reserve, base_reserve, progress, graduated,
        has_swap, market_cap, base_decimals, quote_decimals,
        migration_quote_threshold, creator_base_fee_raw, creator_quote_fee_raw,
        sampled_at, last_attempt_at, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (pool_address) DO UPDATE SET
         price = excluded.price,
         quote_reserve = excluded.quote_reserve,
         base_reserve = excluded.base_reserve,
         progress = excluded.progress,
         graduated = excluded.graduated,
         has_swap = excluded.has_swap,
         market_cap = excluded.market_cap,
         base_decimals = excluded.base_decimals,
         quote_decimals = excluded.quote_decimals,
         migration_quote_threshold = excluded.migration_quote_threshold,
         creator_base_fee_raw = excluded.creator_base_fee_raw,
         creator_quote_fee_raw = excluded.creator_quote_fee_raw,
         sampled_at = excluded.sampled_at,
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = 0`,
    ).run(
      poolAddress,
      sample.price,
      sample.quoteReserve,
      sample.baseReserve,
      sample.progress,
      sample.graduated ? 1 : 0,
      sample.hasSwap ? 1 : 0,
      sample.marketCap,
      sample.baseDecimals,
      sample.quoteDecimals,
      sample.migrationQuoteThreshold,
      sample.creatorBaseFeeRaw ?? null,
      sample.creatorQuoteFeeRaw ?? null,
      atMs,
      atMs,
    );
  } else {
    d.prepare(
      `INSERT INTO pool_states (pool_address, last_attempt_at, consecutive_failures)
       VALUES (?, ?, 1)
       ON CONFLICT (pool_address) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = pool_states.consecutive_failures + 1`,
    ).run(poolAddress, atMs);
  }
}
