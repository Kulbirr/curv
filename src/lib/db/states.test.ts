import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPoolState, getPoolStatesBatch, recordPoolSample, type PoolStateSample } from './states';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

function sample(overrides: Partial<PoolStateSample> = {}): PoolStateSample {
  return {
    price: 0.001,
    quoteReserve: 100,
    baseReserve: 100000,
    progress: 12.5,
    graduated: false,
    hasSwap: true,
    marketCap: 1000,
    baseDecimals: 9,
    quoteDecimals: 9,
    migrationQuoteThreshold: 800,
    ...overrides,
  };
}

describe('recordPoolSample', () => {
  it('stores a successful sample and reads it back', async () => {
    const addr = randomAddress();
    await recordPoolSample(addr, sample(), 1000);
    const s = (await getPoolState(addr))!;
    expect(s.price).toBe(0.001);
    expect(s.quoteReserve).toBe(100);
    expect(s.progress).toBe(12.5);
    expect(s.graduated).toBe(false);
    expect(s.hasSwap).toBe(true);
    expect(s.sampledAt).toBe(1000);
    expect(s.lastAttemptAt).toBe(1000);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('overwrites the previous sample on success and resets the failure counter', async () => {
    const addr = randomAddress();
    await recordPoolSample(addr, sample({ price: 0.001 }), 1000);
    await recordPoolSample(addr, null, 2000); // failure
    expect((await getPoolState(addr))!.consecutiveFailures).toBe(1);
    await recordPoolSample(addr, sample({ price: 0.002 }), 3000);
    const s = (await getPoolState(addr))!;
    expect(s.price).toBe(0.002);
    expect(s.sampledAt).toBe(3000);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('HONESTY: a failed sample never overwrites the last good values', async () => {
    const addr = randomAddress();
    await recordPoolSample(addr, sample({ price: 0.001, quoteReserve: 100 }), 1000);
    await recordPoolSample(addr, null, 2000);
    await recordPoolSample(addr, null, 3000);
    const s = (await getPoolState(addr))!;
    // Last good values preserved — the API serves these as stale, never blanks.
    expect(s.price).toBe(0.001);
    expect(s.quoteReserve).toBe(100);
    expect(s.sampledAt).toBe(1000); // last SUCCESSFUL sample
    expect(s.lastAttemptAt).toBe(3000); // last attempt advanced
    expect(s.consecutiveFailures).toBe(2);
  });

  it('creates a bookkeeping row when the very first sample fails', async () => {
    const addr = randomAddress();
    await recordPoolSample(addr, null, 5000);
    const s = (await getPoolState(addr))!;
    expect(s.price).toBeNull();
    expect(s.sampledAt).toBeNull();
    expect(s.lastAttemptAt).toBe(5000);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('returns null for an address never sampled', async () => {
    expect(await getPoolState(randomAddress())).toBeNull();
  });
});

describe('getPoolStatesBatch', () => {
  it('matches getPoolState per pool and skips unsampled pools', async () => {
    const a = randomAddress();
    const b = randomAddress();
    const c = randomAddress();
    await recordPoolSample(a, sample({ price: 0.005 }), 1000);
    await recordPoolSample(b, sample({ price: 0.007 }), 2000);
    const batch = await getPoolStatesBatch([a, b, c, a]);
    expect(batch.size).toBe(2);
    expect(batch.get(a)).toEqual(await getPoolState(a));
    expect(batch.get(b)).toEqual(await getPoolState(b));
    expect(batch.has(c)).toBe(false);
  });
});
