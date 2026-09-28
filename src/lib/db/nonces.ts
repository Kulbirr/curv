import { execute, query } from './index';

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
export async function claimNonce(signature: string, nowMs: number): Promise<boolean> {
  const changes = await execute(
    'INSERT INTO nonces (signature, created_at) VALUES ($1, $2) ON CONFLICT (signature) DO NOTHING',
    [signature, nowMs],
  );
  return changes === 1;
}

/** True when the signature was already claimed (without claiming it). */
export async function isNonceUsed(signature: string): Promise<boolean> {
  const rows = await query<{ one: number }>('SELECT 1 AS one FROM nonces WHERE signature = $1', [
    signature,
  ]);
  return rows.length > 0;
}

/** Drop nonces older than the cutoff so the table cannot grow without bound. */
export async function pruneNonces(olderThanMs: number): Promise<void> {
  await execute('DELETE FROM nonces WHERE created_at < $1', [olderThanMs]);
}
