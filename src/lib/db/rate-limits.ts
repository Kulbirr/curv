import { getDb, transaction } from './index';

/**
 * DB-backed fixed-window rate limiter.
 *
 * Why this exists: the old registration throttle lived in a process-local
 * Map, so N API instances meant N independent limits (and a restart wiped
 * them). These counters live in the shared database, so every instance
 * enforces the same budget.
 *
 * Correctness under concurrency: the increment and the post-increment read
 * run inside one IMMEDIATE transaction, so they are serialized against
 * every other caller. Each caller observes exactly its own count, which
 * means at most `limit` callers are ever admitted (no over-admission)
 * and the first caller always sees count 1 (no under-admission).
 * A bare upsert followed by a separate SELECT does NOT have this
 * property: concurrent callers can all observe the same final count and
 * every one of them can be denied even though budget remained.
 *
 * Redis swap-in path: replace hitRateLimit with
 *   INCR rl:{key}:{windowStart} + EXPIRE rl:{key}:{windowStart} windowMs/1000
 * and admit when the returned count <= limit. Same semantics, no schema.
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

export function hitRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): RateLimitResult {
  return transaction(() => {
    const d = getDb();
    const windowStart = nowMs - (nowMs % windowMs);
    d.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start`,
    ).run(key, windowStart);
    const row = d.prepare('SELECT count AS count FROM rate_limits WHERE key = ?').get(key) as {
      count: number;
    };
    // Per-key prune only. A global "delete everything older than THIS
    // call's window" would wipe longer-window counters: the 10-minute IP
    // check used to delete the 1-hour wallet row on every request, which
    // silently disabled the wallet throttle (each wallet looked fresh).
    d.prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?').run(
      key,
      nowMs - windowMs,
    );
    return { allowed: row.count <= limit, count: row.count };
  });
}

/**
 * Global prune across all keys. This MUST use the longest window in use:
 * pruning with a shorter window deletes longer-window counters before
 * they expire. Call it wherever the policy windows are known (the
 * registration route does this once per request, next to pruneNonces).
 */
export function pruneRateLimits(nowMs: number): void {
  const longestWindow = Math.max(REGISTRATION_IP_WINDOW_MS, REGISTRATION_WALLET_WINDOW_MS);
  getDb()
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .run(nowMs - longestWindow);
}

/**
 * Registration throttle policy (documented, tunable):
 * - per IP:            30 registrations / 10 minutes  (stops floods)
 * - per creator wallet: 10 registrations / hour       (stops one wallet
 *   spamming the registry; a real launch takes minutes of user effort)
 */
export const REGISTRATION_IP_LIMIT = 30;
export const REGISTRATION_IP_WINDOW_MS = 10 * 60_000;
export const REGISTRATION_WALLET_LIMIT = 10;
export const REGISTRATION_WALLET_WINDOW_MS = 60 * 60_000;
