import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, transaction } from './index';
import { useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

describe('getDb / schema', () => {
  it('creates every table on first open', () => {
    const d = getDb();
    const tables = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of ['pools', 'pool_states', 'ticks', 'nonces', 'pool_verifications', 'rate_limits']) {
      expect(names).toContain(t);
    }
  });

  it('uses WAL mode so the indexer and API readers share the file', () => {
    const mode = (getDb().prepare('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode;
    expect(mode.toLowerCase()).toBe('wal');
  });

  it('skips legacy migrations in tests (never touches the real data dir)', () => {
    // pools.json.migrated exists in the real data/ dir; the test DB must
    // stay empty and no rename must be attempted.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pools').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe('transaction', () => {
  it('commits on success', () => {
    transaction(() => {
      getDb().prepare('INSERT INTO nonces (signature, created_at) VALUES (?, ?)').run('s1', 1);
    });
    const row = getDb().prepare('SELECT 1 AS one FROM nonces WHERE signature = ?').get('s1');
    expect(row).toBeTruthy();
  });

  it('rolls back everything when the callback throws', () => {
    expect(() =>
      transaction(() => {
        getDb().prepare('INSERT INTO nonces (signature, created_at) VALUES (?, ?)').run('s2', 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const row = getDb().prepare('SELECT 1 AS one FROM nonces WHERE signature = ?').get('s2');
    expect(row).toBeUndefined();
  });

  it('returns the callback value', () => {
    expect(transaction(() => 42)).toBe(42);
  });
});
