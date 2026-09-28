/**
 * StockCurve indexer configuration.
 *
 * Single source of truth for the background indexer's cadence and for how
 * API routes decide indexed state is too old to present as fresh.
 */

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How often the indexer samples every registered pool (default 10s). */
export const INDEXER_POLL_MS = numEnv('INDEXER_POLL_MS', 10_000);

/**
 * Indexed state older than this is served with `stale: true` (default 30s,
 * i.e. 3 missed poll intervals). The UI must label it stale, never
 * "updating…".
 */
export const STALE_AFTER_MS = numEnv('INDEXER_STALE_AFTER_MS', 30_000);

/** Price-tick retention for charts (default 7 days). */
export const TICK_RETENTION_MS = numEnv('INDEXER_TICK_RETENTION_MS', 7 * 24 * 3600 * 1000);

/** True when the last successful sample is too old to present as fresh. */
export function isSampleStale(sampledAt: number | null | undefined, nowMs: number): boolean {
  if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt)) return true;
  return nowMs - sampledAt > STALE_AFTER_MS;
}
