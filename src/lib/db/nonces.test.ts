import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { claimNonce, isNonceUsed, pruneNonces } from './nonces';
import { _testConnectionString } from './index';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

/**
 * The exact atomic statement claimNonce() executes, run from N real
 * Postgres connections against the same schema. This exercises the
 * atomicity the replay protection depends on: the PRIMARY KEY + single
 * INSERT ... ON CONFLICT DO NOTHING must admit exactly one winner no
 * matter how the connections interleave.
 */
const CLAIM_SQL =
  'INSERT INTO nonces (signature, created_at) VALUES ($1, $2) ON CONFLICT (signature) DO NOTHING';

async function raceClaim(schema: string, signature: string, threads: number): Promise<number[]> {
  const runOne = async (): Promise<number> => {
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
      const r = await c.query(CLAIM_SQL, [signature, Date.now()]);
      return r.rowCount ?? -1;
    } catch {
      return -1;
    } finally {
      await c.end();
    }
  };
  return Promise.all(Array.from({ length: threads }, runOne));
}

describe('claimNonce', () => {
  it('first claim wins, second is a replay', async () => {
    const sig = randomAddress();
    expect(await claimNonce(sig, 1000)).toBe(true);
    expect(await claimNonce(sig, 2000)).toBe(false);
    expect(await isNonceUsed(sig)).toBe(true);
    expect(await isNonceUsed(randomAddress())).toBe(false);
  });

  it('concurrent claims from 16 connections admit exactly one winner', async () => {
    const sig = randomAddress();
    const results = await raceClaim(db.schema, sig, 16);
    expect(results.every((c) => c === 0 || c === 1)).toBe(true);
    const winners = results.filter((c) => c === 1).length;
    expect(winners).toBe(1);
    // The TypeScript wrapper agrees with the raw result.
    expect(await isNonceUsed(sig)).toBe(true);
    expect(await claimNonce(sig, Date.now())).toBe(false);
  }, 30_000);

  it('different signatures do not interfere', async () => {
    expect(await claimNonce('sig-a', 1000)).toBe(true);
    expect(await claimNonce('sig-b', 1000)).toBe(true);
    expect(await claimNonce('sig-a', 1000)).toBe(false);
  });
});

describe('pruneNonces', () => {
  it('drops only nonces older than the cutoff', async () => {
    await claimNonce('old', 1000);
    await claimNonce('new', 9000);
    await pruneNonces(5000);
    expect(await isNonceUsed('old')).toBe(false);
    expect(await isNonceUsed('new')).toBe(true);
  });
});
