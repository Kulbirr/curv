import { query } from './index';
import { chunkArray } from './states';

/**
 * Persistent price-tick store for live charts and derived estimates.
 *
 * Every tick is a real on-chain sample written by the background indexer ,
 * never synthesized, never interpolated. Gaps in history mean the indexer
 * was not running, and the API reports that honestly via `complete: false`.
 *
 * This is the consolidated home of the old price-history.ts logic; the
 * ticks table is shared with (not duplicated by) pool_states, which holds
 * the latest full snapshot per pool for API serving.
 */

export interface PricePoint {
  t: number;
  price: number;
}

export interface HistoryResult {
  points: PricePoint[];
  /** Earliest tick we have for this pool (unix ms), null when no ticks yet. */
  earliest: number | null;
  /** True when ticks cover the requested window without gaps larger than 5x the bucket. */
  complete: boolean;
}

/**
 * Bucket raw ticks into at most `maxPoints` time-weighted samples.
 * Returns the last tick of each bucket (a real sample, not an average).
 */
export async function getHistory(
  poolAddress: string,
  fromMs: number,
  toMs: number,
  maxPoints = 300,
): Promise<HistoryResult> {
  const rows = await query<{ ts: number; price: number }>(
    'SELECT ts, price FROM ticks WHERE pool_address = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC',
    [poolAddress, fromMs, toMs],
  );

  const earliestRows = await query<{ m: number | null }>(
    'SELECT MIN(ts) AS m FROM ticks WHERE pool_address = $1',
    [poolAddress],
  );
  const earliest = earliestRows[0]?.m ?? null;

  if (rows.length === 0) {
    return { points: [], earliest, complete: false };
  }

  const span = Math.max(1, toMs - fromMs);
  const bucketMs = Math.max(1, Math.floor(span / maxPoints));
  const buckets = new Map<number, { t: number; price: number }>();
  for (const r of rows) {
    const b = Math.floor((r.ts - fromMs) / bucketMs);
    buckets.set(b, { t: r.ts, price: r.price });
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);

  // Gap detection: any adjacent samples farther apart than 5 buckets => incomplete.
  let complete = true;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > bucketMs * 5) {
      complete = false;
      break;
    }
  }
  return { points, earliest, complete };
}

export async function getLatestPrice(poolAddress: string): Promise<PricePoint | null> {
  const rows = await query<PricePoint>(
    'SELECT ts AS t, price FROM ticks WHERE pool_address = $1 ORDER BY ts DESC LIMIT 1',
    [poolAddress],
  );
  return rows[0] ?? null;
}

/** 24h-ago price for change %; null when we lack history. */
export async function getPrice24hAgo(poolAddress: string): Promise<number | null> {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = await query<{ price: number }>(
    'SELECT price FROM ticks WHERE pool_address = $1 AND ts <= $2 ORDER BY ts DESC LIMIT 1',
    [poolAddress, cutoff],
  );
  return rows[0]?.price ?? null;
}

/**
 * Batch version of getPrice24hAgo: latest tick at or before the 24h cutoff
 * per pool, in one query per chunk. Window function keeps it portable
 * (SQLite + Postgres); results identical to the per-pool version.
 */
export async function getPrices24hAgoBatch(poolAddresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const chunk of chunkArray([...new Set(poolAddresses)], 500)) {
    const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query<{ pool_address: string; price: number }>(
      `SELECT pool_address, price FROM (
         SELECT pool_address, price,
                ROW_NUMBER() OVER (PARTITION BY pool_address ORDER BY ts DESC) AS rn
         FROM ticks WHERE pool_address IN (${placeholders}) AND ts <= $${chunk.length + 1}
       ) WHERE rn = 1`,
      [...chunk, cutoff],
    );
    for (const row of rows) out.set(row.pool_address, row.price);
  }
  return out;
}

/**
 * Record one sample. quoteReserve is in UI units (not lamports).
 * Portable ON CONFLICT upsert so an indexer restart never double-counts
 * a tick.
 */
export async function recordTick(
  poolAddress: string,
  ts: number,
  price: number,
  quoteReserve: number | null,
): Promise<void> {
  await query(
    `INSERT INTO ticks (pool_address, ts, price, quote_reserve)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pool_address, ts) DO UPDATE SET
       price = excluded.price,
       quote_reserve = excluded.quote_reserve`,
    [poolAddress, ts, price, quoteReserve],
  );
}

/** Drop ticks older than the retention cutoff (called by the indexer). */
export async function pruneTicks(olderThanMs: number): Promise<void> {
  await query('DELETE FROM ticks WHERE ts < $1', [olderThanMs]);
}

export interface TradeStats24h {
  /** Estimated buy-side quote volume (UI units) from positive reserve deltas. */
  buyVolume: number;
  /** Estimated sell-side quote volume (UI units) from negative reserve deltas. */
  sellVolume: number;
  /** Estimated number of buy-side tick moves (positive reserve deltas). */
  buys: number;
  /** Estimated number of sell-side tick moves (negative reserve deltas). */
  sells: number;
}

/**
 * Estimated 24h buy/sell split, derived from real on-chain samples: a
 * positive quote-reserve delta between consecutive ticks means buys
 * outweighed sells in that window, a negative delta the reverse. This is
 * direction inferred from reserve movement, not per-trade data, callers
 * must label it an estimate. Same honesty guardrails as getVolume24h:
 * null when history is too thin (fewer than 2 ticks or under 1 hour of
 * coverage) to say anything meaningful.
 */
export async function getTradeStats24h(poolAddress: string): Promise<TradeStats24h | null> {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = await query<{ ts: number; quote_reserve: number }>(
    'SELECT ts, quote_reserve FROM ticks WHERE pool_address = $1 AND ts >= $2 AND quote_reserve IS NOT NULL ORDER BY ts ASC',
    [poolAddress, cutoff],
  );
  if (rows.length < 2) return null;
  // Require at least 1 hour of coverage before quoting a "24h" number.
  if (rows[rows.length - 1].ts - rows[0].ts < 3600 * 1000) return null;
  let buyVolume = 0;
  let sellVolume = 0;
  let buys = 0;
  let sells = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].quote_reserve - rows[i - 1].quote_reserve;
    if (delta > 0) {
      buyVolume += delta;
      buys += 1;
    } else if (delta < 0) {
      sellVolume += -delta;
      sells += 1;
    }
  }
  return { buyVolume, sellVolume, buys, sells };
}

/**
 * Estimated 24h traded volume in quote UI units, derived from real
 * on-chain samples: the sum of absolute quote-reserve movements between
 * consecutive ticks. Buys push the reserve up, sells pull it down, so the
 * absolute deltas approximate total traded volume (minus fees, which are
 * tracked separately on-chain). Returns null when history is too thin to
 * be honest about. Callers must label this an estimate, never exact volume.
 */
export async function getVolume24h(poolAddress: string): Promise<number | null> {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = await query<{ ts: number; quote_reserve: number }>(
    'SELECT ts, quote_reserve FROM ticks WHERE pool_address = $1 AND ts >= $2 AND quote_reserve IS NOT NULL ORDER BY ts ASC',
    [poolAddress, cutoff],
  );
  if (rows.length < 2) return null;
  // Require at least 1 hour of coverage before quoting a "24h" number.
  if (rows[rows.length - 1].ts - rows[0].ts < 3600 * 1000) return null;
  let vol = 0;
  for (let i = 1; i < rows.length; i++) {
    vol += Math.abs(rows[i].quote_reserve - rows[i - 1].quote_reserve);
  }
  return vol;
}

/**
 * Batch version of getVolume24h: one ordered scan per chunk, aggregated in
 * JS with the exact same rules (2+ ticks, 1h+ coverage). Pools with thin
 * history are absent from the map (caller treats as null).
 */
export async function getVolumes24hBatch(poolAddresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const chunk of chunkArray([...new Set(poolAddresses)], 500)) {
    // LATERAL join: one parameterized index scan per pool on
    // idx_ticks_pool_ts(pool_address, ts). The old
    // `pool_address IN (...500 literals...)` form made the planner
    // seq-scan ticks (~108ms/chunk at 100k ticks); this is ~10x cheaper
    // and stays flat as the table grows.
    const rows = await query<{
      pool_address: string;
      ts: number;
      quote_reserve: number;
    }>(
      `SELECT t.pool_address, t.ts, t.quote_reserve
       FROM unnest($1::text[]) AS p(pool_address)
       JOIN LATERAL (
         SELECT pool_address, ts, quote_reserve FROM ticks
         WHERE pool_address = p.pool_address AND ts >= $2 AND quote_reserve IS NOT NULL
         ORDER BY ts ASC
       ) t ON true
       ORDER BY t.pool_address ASC, t.ts ASC`,
      [chunk, cutoff],
    );
    let cur: string | null = null;
    let firstTs = 0;
    let lastTs = 0;
    let prev = 0;
    let vol = 0;
    let count = 0;
    for (let i = 0; i <= rows.length; i++) {
      const r = rows[i];
      if (r && r.pool_address === cur) {
        vol += Math.abs(r.quote_reserve - prev);
        prev = r.quote_reserve;
        lastTs = r.ts;
        count++;
        continue;
      }
      // Pool boundary (or end): same honesty rules as getVolume24h.
      if (cur !== null && count >= 2 && lastTs - firstTs >= 3600 * 1000) {
        out.set(cur, vol);
      }
      if (!r) break;
      cur = r.pool_address;
      firstTs = r.ts;
      lastTs = r.ts;
      prev = r.quote_reserve;
      vol = 0;
      count = 1;
    }
  }
  return out;
}
