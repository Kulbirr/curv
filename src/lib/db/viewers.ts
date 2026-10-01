import { query } from './index';

/**
 * Anonymous per-pool viewer presence.
 *
 * The token page heartbeats every ~15s while visible; a session counts as
 * "watching" if its last heartbeat is within VIEWER_TTL_MS. No wallet,
 * no identity: session_id is a random per-tab UUID kept in sessionStorage.
 * Stale rows are pruned lazily on each heartbeat so the table stays tiny.
 *
 * Queries stay sequential: the pg pool is small (max 5, shared across warm
 * serverless instances) and parallel reads in one request starve it.
 */

/** A viewer counts as watching if seen within this window. */
export const VIEWER_TTL_MS = 45_000;

/** Rows older than this are deleted on heartbeat. */
export const VIEWER_PRUNE_MS = 120_000;

/** Session IDs are UUIDs minted client-side; bound the shape server-side. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Record a heartbeat and return the current watcher count for the pool.
 * Sequential: upsert, prune, count.
 */
export async function heartbeatViewer(
  poolAddress: string,
  sessionId: string,
  nowMs: number,
): Promise<number> {
  await query(
    `INSERT INTO pool_viewers (pool_address, session_id, last_seen)
     VALUES ($1, $2, $3)
     ON CONFLICT (pool_address, session_id)
     DO UPDATE SET last_seen = excluded.last_seen`,
    [poolAddress, sessionId, nowMs],
  );
  await query('DELETE FROM pool_viewers WHERE last_seen < $1', [nowMs - VIEWER_PRUNE_MS]);
  return countViewers(poolAddress, nowMs);
}

export async function countViewers(poolAddress: string, nowMs: number): Promise<number> {
  const rows = await query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM pool_viewers WHERE pool_address = $1 AND last_seen > $2',
    [poolAddress, nowMs - VIEWER_TTL_MS],
  );
  return Number(rows[0]?.c ?? 0);
}
