import { Worker } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import {
  claimVanityMint,
  pruneConsumedVanityMints,
  storeVanityMint,
  vanityPoolStats,
} from './vanity-pool';
import { VANITY_POOL_KEY_ENV } from '../vanity-crypto';
import { encryptSecret } from '../vanity-crypto';
import { getDb } from './index';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
const TEST_KEY = randomBytes(32).toString('hex');
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[VANITY_POOL_KEY_ENV];
  process.env[VANITY_POOL_KEY_ENV] = TEST_KEY;
  db = useTempDb();
});

afterEach(() => {
  db.cleanup();
  if (savedKey === undefined) delete process.env[VANITY_POOL_KEY_ENV];
  else process.env[VANITY_POOL_KEY_ENV] = savedKey;
});

function storeOne(pubkey = randomAddress()): string {
  storeVanityMint(pubkey, encryptSecret(randomBytes(64)), Date.now());
  return pubkey;
}

describe('vanity pool store/claim', () => {
  it('stores and claims exactly once, wiping the secret', () => {
    const pubkey = storeOne();
    expect(vanityPoolStats()).toEqual({ ready: 1, consumed: 0 });

    const claim = claimVanityMint(Date.now());
    expect(claim?.publicKey).toBe(pubkey);
    expect(claim?.secretEncrypted.length).toBe(12 + 16 + 64);
    expect(vanityPoolStats()).toEqual({ ready: 0, consumed: 1 });

    // Secret is wiped at handout — the row keeps only the audit trail.
    const row = getDb()
      .prepare('SELECT secret_encrypted, consumed FROM vanity_pool WHERE pubkey = ?')
      .get(pubkey) as { secret_encrypted: Buffer | null; consumed: number };
    expect(row.consumed).toBe(1);
    expect(row.secret_encrypted).toBeNull();

    // Second claim finds nothing.
    expect(claimVanityMint(Date.now())).toBeNull();
  });

  it('claims oldest first', () => {
    const first = storeOne();
    storeOne();
    // Make the second row older by rewriting created_at.
    getDb().prepare('UPDATE vanity_pool SET created_at = 1 WHERE pubkey != ?').run(first);
    expect(claimVanityMint(Date.now())?.publicKey).not.toBe(first);
  });

  it('returns null on an empty pool', () => {
    expect(claimVanityMint(Date.now())).toBeNull();
  });

  it('prunes old consumed rows', () => {
    storeOne();
    claimVanityMint(Date.now());
    expect(pruneConsumedVanityMints(Date.now() + 1)).toBe(1);
    expect(vanityPoolStats()).toEqual({ ready: 0, consumed: 0 });
  });
});

/**
 * True OS-thread race: 20 workers claim from a pool of 10. The
 * SELECT+UPDATE inside one IMMEDIATE transaction must hand each keypair
 * out exactly once — 10 distinct winners, 10 losers, zero duplicates.
 */
const RACE_WORKER_SRC = `
  const { parentPort, workerData } = require('worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(workerData.dbPath);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA busy_timeout = 10000;');
  const start = Date.now();
  while (Date.now() - start < 300) {}
  let claimed = null;
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = d.prepare(
      'SELECT pubkey FROM vanity_pool WHERE consumed = 0 ORDER BY created_at ASC LIMIT 1'
    ).get();
    if (row) {
      const u = d.prepare(
        'UPDATE vanity_pool SET consumed = 1, consumed_at = ?, secret_encrypted = NULL WHERE pubkey = ? AND consumed = 0'
      ).run(Date.now(), row.pubkey);
      if (u.changes === 1) claimed = row.pubkey;
    }
    d.exec('COMMIT');
  } catch {
    try { d.exec('ROLLBACK'); } catch {}
  }
  d.close();
  parentPort.postMessage(claimed);
`;

function raceClaim(dbPath: string, threads: number): Promise<(string | null)[]> {
  return Promise.all(
    Array.from({ length: threads }, () => {
      return new Promise<string | null>((resolve, reject) => {
        const w = new Worker(RACE_WORKER_SRC, { eval: true, workerData: { dbPath } });
        w.on('message', (m: string | null) => resolve(m));
        w.on('error', reject);
        w.on('exit', (code) => {
          if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
      });
    }),
  );
}

describe('vanity pool concurrency', () => {
  it('hands each keypair out exactly once under a 20-thread race', async () => {
    for (let i = 0; i < 10; i++) storeOne();
    const results = await raceClaim(db.dbPath, 20);
    const winners = results.filter((r): r is string => r !== null);
    expect(winners).toHaveLength(10);
    expect(new Set(winners).size).toBe(10); // no duplicates
    expect(vanityPoolStats()).toEqual({ ready: 0, consumed: 10 });
  }, 30_000);
});
