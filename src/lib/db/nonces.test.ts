import { Worker } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimNonce, isNonceUsed, pruneNonces } from './nonces';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

/**
 * The exact atomic statement claimNonce() executes, run from N real OS
 * threads against the same database file. This exercises the atomicity
 * the replay protection depends on: the PRIMARY KEY + single INSERT ...
 * ON CONFLICT DO NOTHING must admit exactly one winner no matter how the
 * threads interleave.
 */
const CLAIM_SQL =
  'INSERT INTO nonces (signature, created_at) VALUES (?, ?) ON CONFLICT (signature) DO NOTHING';

function raceClaim(dbPath: string, signature: string, threads: number): Promise<number[]> {
  const workerSrc = `
    const { parentPort, workerData } = require('worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(workerData.dbPath);
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA busy_timeout = 10000;');
    // Spin until every worker is ready so the claims land at once.
    const start = Date.now();
    while (Date.now() - start < 300) {}
    let changes = 0;
    try {
      const r = d.prepare(workerData.sql).run(workerData.signature, Date.now());
      changes = r.changes;
    } catch (e) {
      changes = -1;
    }
    d.close();
    parentPort.postMessage(changes);
  `;
  return Promise.all(
    Array.from({ length: threads }, () => {
      return new Promise<number>((resolve, reject) => {
        const w = new Worker(workerSrc, {
          eval: true,
          workerData: { dbPath, sql: CLAIM_SQL, signature },
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

describe('claimNonce', () => {
  it('first claim wins, second is a replay', () => {
    const sig = randomAddress();
    expect(claimNonce(sig, 1000)).toBe(true);
    expect(claimNonce(sig, 2000)).toBe(false);
    expect(isNonceUsed(sig)).toBe(true);
    expect(isNonceUsed(randomAddress())).toBe(false);
  });

  it('concurrent claims from 16 threads admit exactly one winner', async () => {
    const sig = randomAddress();
    const results = await raceClaim(db.dbPath, sig, 16);
    expect(results.every((c) => c === 0 || c === 1)).toBe(true);
    const winners = results.filter((c) => c === 1).length;
    expect(winners).toBe(1);
    // The TypeScript wrapper agrees with the raw result.
    expect(isNonceUsed(sig)).toBe(true);
    expect(claimNonce(sig, Date.now())).toBe(false);
  }, 30_000);

  it('different signatures do not interfere', () => {
    expect(claimNonce('sig-a', 1000)).toBe(true);
    expect(claimNonce('sig-b', 1000)).toBe(true);
    expect(claimNonce('sig-a', 1000)).toBe(false);
  });
});

describe('pruneNonces', () => {
  it('drops only nonces older than the cutoff', () => {
    claimNonce('old', 1000);
    claimNonce('new', 9000);
    pruneNonces(5000);
    expect(isNonceUsed('old')).toBe(false);
    expect(isNonceUsed('new')).toBe(true);
  });
});
