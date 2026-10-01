/**
 * Graduation progress display math.
 *
 * Single source of truth: the indexer's `progress` field (0-100), computed
 * once per sample from quoteReserve / migrationQuoteThreshold and served by
 * GET /api/pools, GET /api/pools/[address]/state, and the WebSocket push.
 * Every UI surface (pool header badge, bonding curve card, Discover cards)
 * clamps and renders that one value. Nothing recomputes the percent from
 * reserves on the client, so the surfaces can never disagree with each
 * other or with the list.
 */

/** Clamp the indexer's 0-100 progress for display. Null stays null. */
export function displayProgress(
  progress: number | null | undefined,
): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.min(100, Math.max(0, progress));
}
