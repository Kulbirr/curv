import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { Client } from 'pg';
import {
  claimVanityMint,
  pruneConsumedVanityMints,
  storeVanityMint,
  vanityPoolStats,
} from './vanity-pool';
import { VANITY_POOL_KEY_ENV } from '../vanity-crypto';
import { encryptSecret } from '../vanity-crypto';
import { _testConnectionString, execute, query } from './index';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
const TEST_KEY = randomBytes(32).toString('hex');
let savedKey: string | undefined;

beforeEach(async () => {
  savedKey = process.env[VANITY_POOL_KEY_ENV];
  process.env[VANITY_POOL_KEY_ENV] = TEST_KEY;
  db = await useTempDb();
});

afterEach(async () => {
  await db.cleanup();
  if (savedKey === undefined) delete process.env[VANITY_POOL_KEY_ENV];
  else process.env[VANITY_POOL_KEY_ENV] = savedKey;
});

async function storeOne(pubkey = randomAddress()): Promise<string> {
  await storeVanityMint(pubkey, encryptSecret(randomBytes(64)), Date.now());
  return pubkey;
}

describe('vanity pool store/claim', () => {
  it('stores and claims exactly once, wiping the secret', async () => {
    const pubkey = await storeOne();
    expect(await vanityPoolStats()).toEqual({ ready: 1, consumed: 0 });

    const claim = await claimVanityMint(Date.now());
    expect(claim?.publicKey).toBe(pubkey);
    expect(claim?.secretEncrypted.length).toBe(12 + 16 + 64);
    expect(await vanityPoolStats()).toEqual({ ready: 0, consumed: 1 });

    // Secret is wiped at handout — the row keeps only the audit trail.
    const rows = await query<{ secret_encrypted: Buffer | null; consumed: number }>(
      'SELECT secret_encrypted, consumed FROM vanity_pool WHERE pubkey = $1',
      [pubkey],
    );
    const row = rows[0];
    expect(row.consumed).toBe(1);
    expect(row.secret_encrypted).toBeNull();

    // Second claim finds nothing.
    expect(await claimVanityMint(Date.now())).toBeNull();
  });

  it('claims oldest first', async () => {
    const first = await storeOne();
    await storeOne();
    // Make the second row older by rewriting created_at.
    await execute('UPDATE vanity_pool SET created_at = 1 WHERE pubkey != $1', [first]);
    expect((await claimVanityMint(Date.now()))?.publicKey).not.toBe(first);
  });

  it('returns null on an empty pool', async () => {
    expect(await claimVanityMint(Date.now())).toBeNull();
  });

  it('prunes old consumed rows', async () => {
    await storeOne();
    await claimVanityMint(Date.now());
    expect(await pruneConsumedVanityMints(Date.now() + 1)).toBe(1);
    expect(await vanityPoolStats()).toEqual({ ready: 0, consumed: 0 });
  });
});

/**
 * True concurrency race: 20 independent Postgres connections claim from a
 * pool of 10. The SELECT+UPDATE inside one transaction must hand each
 * keypair out exactly once — 10 distinct winners, 10 losers, zero
 * duplicates. (With pg there is no need for worker threads: separate
 * connections ARE the concurrency.)
 */
async function raceClaim(schema: string, threads: number): Promise<(string | null)[]> {
  const runOne = async (): Promise<string | null> => {
    const c = new Client({
      connectionString: _testConnectionString(),
      ssl: false,
      options: `-c search_path="${schema}"`,
    });
    await c.connect();
    try {
      // Spin until every connection is ready so the claims land at once.
      const start = Date.now();
      while (Date.now() - start < 300) {}
      let claimed: string | null = null;
      await c.query('BEGIN');
      try {
        // Mirror production: FOR UPDATE SKIP LOCKED hands each connection
        // a distinct ready row instead of piling onto the same oldest one.
        const r = await c.query(
          'SELECT pubkey FROM vanity_pool WHERE consumed = 0 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
        );
        const row = r.rows[0] as { pubkey: string } | undefined;
        if (row) {
          const u = await c.query(
            'UPDATE vanity_pool SET consumed = 1, consumed_at = $1, secret_encrypted = NULL WHERE pubkey = $2 AND consumed = 0',
            [Date.now(), row.pubkey],
          );
          if (u.rowCount === 1) claimed = row.pubkey;
        }
        await c.query('COMMIT');
      } catch {
        try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      }
      return claimed;
    } finally {
      await c.end();
    }
  };
  return Promise.all(Array.from({ length: threads }, runOne));
}

describe('vanity pool concurrency', () => {
  it('hands each keypair out exactly once under a 20-connection race', async () => {
    for (let i = 0; i < 10; i++) await storeOne();
    const results = await raceClaim(db.schema, 20);
    const winners = results.filter((r): r is string => r !== null);
    expect(winners).toHaveLength(10);
    expect(new Set(winners).size).toBe(10); // no duplicates
    expect(await vanityPoolStats()).toEqual({ ready: 0, consumed: 10 });
  }, 30_000);
});
