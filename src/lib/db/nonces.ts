import { getDb } from './index';

/**
 * Single-use registration signatures (replay protection).
 *
 * Wired into POST /api/pools: the signature is claimed (atomically)
 * after the wallet signature verifies, before the pool registers. The
 * PRIMARY KEY + ON CONFLICT DO NOTHING makes the check-and-set a single
 * atomic statement, so concurrent replays — even across API instances —
 * cannot both succeed.
 *
 * SQL stays in the portable SQLite/Postgres subset (no INSERT OR IGNORE).
 *
 * Redis swap-in path: replace claimNonce with
 *   SET signature 1 NX PX <REGISTRATION_TTL_MS>
 * and treat "not set" as a replay. pruneNonces becomes unnecessary
 * (Redis expiry handles it).
 */

/**
 * Atomically claim a signature. Returns true when this is the first use
 * (claim recorded), false when the signature was already seen — i.e. a
 * replay. Safe under concurrency: the PRIMARY KEY + ON CONFLICT makes the
 * check-and-set a single atomic statement.
 */
export function claimNonce(signature: string, nowMs: number): boolean {
  const result = getDb()
    .prepare(
      'INSERT INTO nonces (signature, created_at) VALUES (?, ?) ON CONFLICT (signature) DO NOTHING',
    )
    .run(signature, nowMs) as { changes: number };
  return result.changes === 1;
}

/** True when the signature was already claimed (without claiming it). */
export function isNonceUsed(signature: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS one FROM nonces WHERE signature = ?')
    .get(signature) as { one: number } | undefined;
  return row !== undefined;
}

/** Drop nonces older than the cutoff so the table cannot grow without bound. */
export function pruneNonces(olderThanMs: number): void {
  getDb().prepare('DELETE FROM nonces WHERE created_at < ?').run(olderThanMs);
}
