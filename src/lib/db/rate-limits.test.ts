import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_WALLET_LIMIT,
  REGISTRATION_WALLET_WINDOW_MS,
  hitRateLimit,
  pruneRateLimits,
} from './rate-limits';
import { _testConnectionString, query } from './index';
import { useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

/**
 * The exact statement sequence hitRateLimit() executes, run from N real
 * Postgres connections against the same schema. The upsert is a single
 * atomic statement, and each connection's own write is always visible to
 * its follow-up read — so exactly `limit` connections may ever be
 * admitted (no over-admission), the first always sees count 1, and no
 * increment is lost.
 */
const UPSERT_SQL = `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`;

async function raceLimit(
  schema: string,
  key: string,
  limit: number,
  windowMs: number,
  threads: number,
): Promise<number[]> {
  const runOne = async (): Promise<number> => {
    const c = new Client({
      connectionString: _testConnectionString(),
      ssl: false,
      options: `-c search_path="${schema}"`,
    });
    await c.connect();
    try {
      // Spin until every connection is ready so the hits land at once.
      const start = Date.now();
      while (Date.now() - start < 300) {}
      const now = Date.now();
      const windowStart = now - (now % windowMs);
      // Mirror production: the upsert and the read are one transaction,
      // so each connection observes at least its own increment.
      await c.query('BEGIN');
      await c.query(UPSERT_SQL, [key, windowStart]);
      const r = await c.query('SELECT count AS count FROM rate_limits WHERE key = $1', [key]);
      const count = Number((r.rows[0] as { count: number }).count);
      await c.query('COMMIT');
      return count <= limit ? 1 : 0;
    } catch {
      return -1;
    } finally {
      await c.end();
    }
  };
  return Promise.all(Array.from({ length: threads }, runOne));
}

describe('hitRateLimit', () => {
  it('admits up to the limit, then denies', async () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const r = await hitRateLimit('k', 5, 60_000, now + i);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const denied = await hitRateLimit('k', 5, 60_000, now + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(6);
  });

  it('resets the counter when the window rolls over', async () => {
    const r1 = await hitRateLimit('k', 2, 60_000, 60_000);
    expect(r1).toEqual({ allowed: true, count: 1 });
    await hitRateLimit('k', 2, 60_000, 61_000);
    expect((await hitRateLimit('k', 2, 60_000, 62_000)).allowed).toBe(false);
    // New window: counter restarts at 1.
    const r2 = await hitRateLimit('k', 2, 60_000, 120_000);
    expect(r2).toEqual({ allowed: true, count: 1 });
  });

  it('tracks keys independently', async () => {
    const now = 5_000_000;
    await hitRateLimit('a', 1, 60_000, now);
    expect((await hitRateLimit('a', 1, 60_000, now + 1)).allowed).toBe(false);
    expect((await hitRateLimit('b', 1, 60_000, now + 1)).allowed).toBe(true);
  });

  it('REGRESSION: a short-window check never wipes a longer-window counter', async () => {
    // Production bug: the 10-minute IP prune deleted the 1-hour wallet
    // row on every request, so the wallet throttle never fired.
    const walletKey = 'reg:wallet:ABC';
    for (let i = 0; i < 5; i++) {
      await hitRateLimit(walletKey, 10, REGISTRATION_WALLET_WINDOW_MS, Date.now());
    }
    // Interleave many short-window IP checks, as the route does.
    for (let i = 0; i < 20; i++) {
      await hitRateLimit('reg:ip:1.2.3.4', 30, REGISTRATION_IP_WINDOW_MS, Date.now());
    }
    const probe = await hitRateLimit(walletKey, 10, REGISTRATION_WALLET_WINDOW_MS, Date.now());
    expect(probe.count).toBe(6); // 5 + this probe: the counter survived
    expect(probe.allowed).toBe(true);
  });

  it('pruneRateLimits expires only windows older than the longest policy window', async () => {
    const now = Date.now();
    // A wallet hit right now lives in the current hour window: fresh.
    await hitRateLimit('w1', 10, REGISTRATION_WALLET_WINDOW_MS, now);
    // An IP hit from 2 hours ago is long dead (10m window).
    await hitRateLimit('ip1', 30, REGISTRATION_IP_WINDOW_MS, now - 2 * REGISTRATION_WALLET_WINDOW_MS);
    await pruneRateLimits(now);
    const keys = (await query<{ key: string }>('SELECT key FROM rate_limits')).map((r) => r.key);
    expect(keys).toContain('w1');
    expect(keys).not.toContain('ip1');
  });

  it('prunes stale windows opportunistically', async () => {
    await hitRateLimit('old', 100, 60_000, 60_000);
    await hitRateLimit('fresh', 100, 60_000, 10 * 60_000);
    // The 'old' row's window is long past; the opportunistic delete removed it.
    const r = await hitRateLimit('old', 100, 60_000, 10 * 60_000 + 1000);
    expect(r.count).toBe(1);
  });

  it('concurrent hits from 24 connections never over-admit past the limit', async () => {
    const admitted = await raceLimit(db.schema, 'race-key', 10, 60_000, 24);
    expect(admitted.every((a) => a === 0 || a === 1)).toBe(true);
    const total = admitted.filter((a) => a === 1).length;
    expect(total).toBeLessThanOrEqual(10);
    expect(total).toBeGreaterThan(0);
    // Every thread incremented exactly once: final count is 24.
    const final = await hitRateLimit('race-key', 1000, 60_000, Date.now());
    expect(final.count).toBe(25); // 24 racers + this probe
  }, 30_000);
});

describe('registration throttle policy constants', () => {
  it('documents the intended budgets', async () => {
    expect(REGISTRATION_IP_LIMIT).toBe(30);
    expect(REGISTRATION_IP_WINDOW_MS).toBe(10 * 60_000);
    expect(REGISTRATION_WALLET_LIMIT).toBe(10);
    expect(REGISTRATION_WALLET_WINDOW_MS).toBe(60 * 60_000);
  });
});
