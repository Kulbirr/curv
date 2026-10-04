import { execute, query, transaction } from './index';

/**
 * Pre-ground vanity mint pool.
 *
 * Instant launch: the mint keypair is NOT ground at
 * click time. A background grinder (scripts/grind-pool.ts) keeps this
 * table topped up with "...curv" keypairs; the handout endpoint
 * (src/pages/api/vanity-mint.ts) claims one atomically per launch.
 *
 * Exactly-once claim under concurrency: claimVanityMint runs
 * SELECT ... FOR UPDATE SKIP LOCKED + UPDATE inside one transaction, so
 * concurrent claimants each lock a distinct ready keypair, two handouts
 * can never receive the same keypair. The secret is wiped (set to NULL)
 * in the same statement that marks the row consumed, a crash between
 * claim and handout cannot leak it twice.
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
export async function storeVanityMint(
  pubkey: string,
  secretEncrypted: Buffer,
  nowMs: number,
): Promise<void> {
  await execute(
    `INSERT INTO vanity_pool (pubkey, secret_encrypted, created_at, consumed)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (pubkey) DO NOTHING`,
    [pubkey, secretEncrypted, nowMs],
  );
}

/**
 * Atomically claim one ready keypair: oldest first, marked consumed and
 * its secret wiped in the same transaction. Returns null when the pool
 * is dry, callers must fall back to the client-side grind.
 *
 * Concurrency: SELECT ... FOR UPDATE SKIP LOCKED means concurrent
 * claimants each lock a distinct ready row instead of piling onto the
 * same oldest one (the old SQLite build serialized this with
 * BEGIN IMMEDIATE; SKIP LOCKED is the Postgres idiom for a claim queue).
 */
export async function claimVanityMint(nowMs: number): Promise<VanityMintClaim | null> {
  return transaction(async (db) => {
    const res = await db.query(
      `SELECT pubkey, secret_encrypted FROM vanity_pool
       WHERE consumed = 0 ORDER BY created_at ASC LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const row = res.rows[0] as { pubkey: string; secret_encrypted: Buffer } | undefined;
    if (!row) return null;
    const updated = await db.query(
      `UPDATE vanity_pool
       SET consumed = 1, consumed_at = $1, secret_encrypted = NULL
       WHERE pubkey = $2 AND consumed = 0`,
      [nowMs, row.pubkey],
    );
    // Defensive: we hold the row lock, so this should always be 1.
    if ((updated.rowCount ?? 0) !== 1) return null;
    return { publicKey: row.pubkey, secretEncrypted: Buffer.from(row.secret_encrypted) };
  });
}

/** How many keypairs are ready vs already handed out. */
export async function vanityPoolStats(): Promise<VanityPoolStats> {
  const readyRows = await query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM vanity_pool WHERE consumed = 0',
  );
  const consumedRows = await query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM vanity_pool WHERE consumed = 1',
  );
  return { ready: Number(readyRows[0]?.c ?? 0), consumed: Number(consumedRows[0]?.c ?? 0) };
}

/** Hygiene: drop consumed rows older than the cutoff (secrets are already wiped). */
export async function pruneConsumedVanityMints(olderThanMs: number): Promise<number> {
  return execute('DELETE FROM vanity_pool WHERE consumed = 1 AND consumed_at < $1', [
    olderThanMs,
  ]);
}
