import { Worker } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_WALLET_LIMIT,
  REGISTRATION_WALLET_WINDOW_MS,
  hitRateLimit,
  pruneRateLimits,
} from './rate-limits';
import { getDb } from './index';
import { useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

/**
 * The exact statement sequence hitRateLimit() executes, run from N real OS
 * threads against the same database file: BEGIN IMMEDIATE serializes the
 * upsert + post-increment read, so each thread observes exactly its own
 * count. At most `limit` threads may ever be admitted (no over-admission)
 * and the first thread always sees count 1 (no under-admission).
 */
const UPSERT_SQL = `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`;

function raceLimit(
  dbPath: string,
  key: string,
  limit: number,
  windowMs: number,
  threads: number,
): Promise<number[]> {
  const workerSrc = `
    const { parentPort, workerData } = require('worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(workerData.dbPath);
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA busy_timeout = 10000;');
    const start = Date.now();
    while (Date.now() - start < 300) {}
    const now = Date.now();
    const windowStart = now - (now % workerData.windowMs);
    let admitted = 0;
    try {
      // Mirror production: the upsert and the read are one IMMEDIATE
      // transaction, so no thread can observe another thread's count.
      d.exec('BEGIN IMMEDIATE');
      d.prepare(workerData.upsert).run(workerData.key, windowStart);
      const row = d.prepare('SELECT count AS count FROM rate_limits WHERE key = ?').get(workerData.key);
      admitted = row.count <= workerData.limit ? 1 : 0;
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch {}
      admitted = -1;
    }
    d.close();
    parentPort.postMessage(admitted);
  `;
  return Promise.all(
    Array.from({ length: threads }, () => {
      return new Promise<number>((resolve, reject) => {
        const w = new Worker(workerSrc, {
          eval: true,
          workerData: { dbPath, key, limit, windowMs, upsert: UPSERT_SQL },
        });
        w.on('message', (m: number) => resolve(m));
        w.on('error', reject);
        w.on('exit', (code) => {
          if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
      });
    }),
  );
}

describe('hitRateLimit', () => {
  it('admits up to the limit, then denies', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const r = hitRateLimit('k', 5, 60_000, now + i);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const denied = hitRateLimit('k', 5, 60_000, now + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(6);
  });

  it('resets the counter when the window rolls over', () => {
    const r1 = hitRateLimit('k', 2, 60_000, 60_000);
    expect(r1).toEqual({ allowed: true, count: 1 });
    hitRateLimit('k', 2, 60_000, 61_000);
    expect(hitRateLimit('k', 2, 60_000, 62_000).allowed).toBe(false);
    // New window: counter restarts at 1.
    const r2 = hitRateLimit('k', 2, 60_000, 120_000);
    expect(r2).toEqual({ allowed: true, count: 1 });
  });

  it('tracks keys independently', () => {
    const now = 5_000_000;
    hitRateLimit('a', 1, 60_000, now);
    expect(hitRateLimit('a', 1, 60_000, now + 1).allowed).toBe(false);
    expect(hitRateLimit('b', 1, 60_000, now + 1).allowed).toBe(true);
  });

  it('REGRESSION: a short-window check never wipes a longer-window counter', () => {
    // Production bug: the 10-minute IP prune deleted the 1-hour wallet
    // row on every request, so the wallet throttle never fired.
    const walletKey = 'reg:wallet:ABC';
    for (let i = 0; i < 5; i++) {
      hitRateLimit(walletKey, 10, REGISTRATION_WALLET_WINDOW_MS, Date.now());
    }
    // Interleave many short-window IP checks, as the route does.
    for (let i = 0; i < 20; i++) {
      hitRateLimit('reg:ip:1.2.3.4', 30, REGISTRATION_IP_WINDOW_MS, Date.now());
    }
    const probe = hitRateLimit(walletKey, 10, REGISTRATION_WALLET_WINDOW_MS, Date.now());
    expect(probe.count).toBe(6); // 5 + this probe: the counter survived
    expect(probe.allowed).toBe(true);
  });

  it('pruneRateLimits expires only windows older than the longest policy window', () => {
    const now = Date.now();
    // A wallet hit right now lives in the current hour window: fresh.
    hitRateLimit('w1', 10, REGISTRATION_WALLET_WINDOW_MS, now);
    // An IP hit from 2 hours ago is long dead (10m window).
    hitRateLimit('ip1', 30, REGISTRATION_IP_WINDOW_MS, now - 2 * REGISTRATION_WALLET_WINDOW_MS);
    pruneRateLimits(now);
    const keys = (
      getDb().prepare('SELECT key FROM rate_limits').all() as { key: string }[]
    ).map((r) => r.key);
    expect(keys).toContain('w1');
    expect(keys).not.toContain('ip1');
  });

  it('prunes stale windows opportunistically', () => {
    hitRateLimit('old', 100, 60_000, 60_000);
    hitRateLimit('fresh', 100, 60_000, 10 * 60_000);
    // The 'old' row's window is long past; the opportunistic delete removed it.
    const r = hitRateLimit('old', 100, 60_000, 10 * 60_000 + 1000);
    expect(r.count).toBe(1);
  });

  it('concurrent hits from 24 threads never over-admit past the limit', async () => {
    const admitted = await raceLimit(db.dbPath, 'race-key', 10, 60_000, 24);
    expect(admitted.every((a) => a === 0 || a === 1)).toBe(true);
    const total = admitted.filter((a) => a === 1).length;
    expect(total).toBeLessThanOrEqual(10);
    expect(total).toBeGreaterThan(0);
    // Every thread incremented exactly once: final count is 24.
    const final = hitRateLimit('race-key', 1000, 60_000, Date.now());
    expect(final.count).toBe(25); // 24 racers + this probe
  }, 30_000);
});

describe('registration throttle policy constants', () => {
  it('documents the intended budgets', () => {
    expect(REGISTRATION_IP_LIMIT).toBe(30);
    expect(REGISTRATION_IP_WINDOW_MS).toBe(10 * 60_000);
    expect(REGISTRATION_WALLET_LIMIT).toBe(10);
    expect(REGISTRATION_WALLET_WINDOW_MS).toBe(60 * 60_000);
  });
});
