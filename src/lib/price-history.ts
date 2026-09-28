/**
 * Persistent price-tick store for live charts.
 *
 * Consolidated into the database layer (./db/ticks) — this module keeps
 * the old import path working. Every tick is a real on-chain sample
 * written by the background indexer; never synthesized, never
 * interpolated. Gaps in history mean the indexer was not running, and the
 * API reports that honestly via `complete: false`.
 */

export type { PricePoint, HistoryResult } from './db/ticks';
export {
  getHistory,
  getLatestPrice,
  getPrice24hAgo,
  recordTick,
  pruneTicks,
  getVolume24h,
} from './db/ticks';
