import { getDb, transaction } from './index';

/**
 * Pre-ground vanity mint pool.
 *
 * Instant launch works like pump.fun's: the mint keypair is NOT ground at
 * click time. A background grinder (scripts/grind-pool.ts) keeps this
 * table topped up with "...curv" keypairs; the handout endpoint
 * (src/pages/api/vanity-mint.ts) claims one atomically per launch.
 *
 * Exactly-once claim under concurrency: claimVanityMint runs SELECT +
 * UPDATE inside one IMMEDIATE transaction, serialized against every other
 * caller, so two concurrent handouts can never receive the same keypair.
 * The secret is wiped (set to NULL) in the same statement that marks the
 * row consumed — a crash between claim and handout cannot leak it twice.
 *
 * SQL stays in the portable SQLite/Postgres subset (BLOB -> BYTEA).
 */

export interface VanityMintClaim {
  publicKey: string;
  /** Encrypted secret blob (decrypt with vanity-crypto before use). */
  secretEncrypted: Buffer;
}

export interface VanityPoolStats {
  ready: number;
  consumed: number;
}

/** Store a freshly ground mint. The secret must already be encrypted (see vanity-crypto). */
export function storeVanityMint(pubkey: string, secretEncrypted: Buffer, nowMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO vanity_pool (pubkey, secret_encrypted, created_at, consumed)
       VALUES (?, ?, ?, 0)
       ON CONFLICT (pubkey) DO NOTHING`,
    )
    .run(pubkey, secretEncrypted, nowMs);
}

/**
 * Atomically claim one ready keypair: oldest first, marked consumed and
 * its secret wiped in the same transaction. Returns null when the pool
 * is dry — callers must fall back to the client-side grind.
 */
export function claimVanityMint(nowMs: number): VanityMintClaim | null {
  return transaction(() => {
    const d = getDb();
    const row = d
      .prepare(
        `SELECT pubkey, secret_encrypted FROM vanity_pool
         WHERE consumed = 0 ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as { pubkey: string; secret_encrypted: Buffer } | undefined;
    if (!row) return null;
    const updated = d
      .prepare(
        `UPDATE vanity_pool
         SET consumed = 1, consumed_at = ?, secret_encrypted = NULL
         WHERE pubkey = ? AND consumed = 0`,
      )
      .run(nowMs, row.pubkey);
    // Another claimant won the race between our SELECT and UPDATE.
    if (updated.changes !== 1) return null;
    return { publicKey: row.pubkey, secretEncrypted: Buffer.from(row.secret_encrypted) };
  });
}

/** How many keypairs are ready vs already handed out. */
export function vanityPoolStats(): VanityPoolStats {
  const d = getDb();
  const ready = (
    d.prepare('SELECT COUNT(*) AS c FROM vanity_pool WHERE consumed = 0').get() as { c: number }
  ).c;
  const consumed = (
    d.prepare('SELECT COUNT(*) AS c FROM vanity_pool WHERE consumed = 1').get() as { c: number }
  ).c;
  return { ready, consumed };
}

/** Hygiene: drop consumed rows older than the cutoff (secrets are already wiped). */
export function pruneConsumedVanityMints(olderThanMs: number): number {
  const result = getDb()
    .prepare('DELETE FROM vanity_pool WHERE consumed = 1 AND consumed_at < ?')
    .run(olderThanMs);
  return Number(result.changes ?? 0);
}
