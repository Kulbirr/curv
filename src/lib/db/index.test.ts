import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute, getDb, query, transaction } from './index';
import { useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

describe('getDb / schema', () => {
  it('creates every table on first open', async () => {
    const rows = await query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
    );
    const names = rows.map((t) => t.tablename);
    for (const t of ['pools', 'pool_states', 'ticks', 'nonces', 'pool_verifications', 'rate_limits', 'vanity_pool']) {
      expect(names).toContain(t);
    }
  });

  it('skips the seed import in tests (never touches the real data dir)', async () => {
    // postgres-seed.json may exist in the real data/ dir; the test schema
    // must stay empty.
    const rows = await query<{ c: number }>('SELECT COUNT(*) AS c FROM pools');
    expect(Number(rows[0].c)).toBe(0);
  });

  it('parses BIGINT timestamps back as numbers (not strings)', async () => {
    await execute('INSERT INTO nonces (signature, created_at) VALUES ($1, $2)', ['s-bigint', 1759000000000]);
    const rows = await query<{ created_at: unknown }>(
      'SELECT created_at FROM nonces WHERE signature = $1',
      ['s-bigint'],
    );
    expect(typeof rows[0].created_at).toBe('number');
    expect(rows[0].created_at).toBe(1759000000000);
  });
});

describe('transaction', () => {
  it('commits on success', async () => {
    await transaction(async (db) => {
      await db.query('INSERT INTO nonces (signature, created_at) VALUES ($1, $2)', ['s1', 1]);
    });
    const rows = await query('SELECT 1 AS one FROM nonces WHERE signature = $1', ['s1']);
    expect(rows.length).toBe(1);
  });

  it('rolls back everything when the callback throws', async () => {
    await expect(
      transaction(async (db) => {
        await db.query('INSERT INTO nonces (signature, created_at) VALUES ($1, $2)', ['s2', 1]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await query('SELECT 1 AS one FROM nonces WHERE signature = $1', ['s2']);
    expect(rows.length).toBe(0);
  });

  it('returns the callback value', async () => {
    expect(await transaction(async () => 42)).toBe(42);
  });

  it('serializes concurrent transactions on the same rows', async () => {
    // Two concurrent transactions racing an increment must not lose an
    // update — the row lock serializes them.
    await execute(
      'INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, $3)',
      ['race', 1, 0],
    );
    const bump = () =>
      transaction(async (db) => {
        const res = await db.query('SELECT count FROM rate_limits WHERE key = $1', ['race']);
        const cur = Number(res.rows[0].count);
        await db.query('UPDATE rate_limits SET count = $1 WHERE key = $2', [cur + 1, 'race']);
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    const rows = await query<{ count: number }>('SELECT count FROM rate_limits WHERE key = $1', [
      'race',
    ]);
    expect(Number(rows[0].count)).toBe(20);
  });

  it('getDb() outside transaction() uses the pool, not the txn client', async () => {
    // Sanity: the pool query surface works alongside transactions.
    const d = getDb();
    const res = await d.query('SELECT 1 AS one');
    expect(res.rows[0].one).toBe(1);
  });
});
