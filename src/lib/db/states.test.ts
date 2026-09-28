import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPoolState, getPoolStatesBatch, recordPoolSample, type PoolStateSample } from './states';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

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
  it('stores a successful sample and reads it back', () => {
    const addr = randomAddress();
    recordPoolSample(addr, sample(), 1000);
    const s = getPoolState(addr)!;
    expect(s.price).toBe(0.001);
    expect(s.quoteReserve).toBe(100);
    expect(s.progress).toBe(12.5);
    expect(s.graduated).toBe(false);
    expect(s.hasSwap).toBe(true);
    expect(s.sampledAt).toBe(1000);
    expect(s.lastAttemptAt).toBe(1000);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('overwrites the previous sample on success and resets the failure counter', () => {
    const addr = randomAddress();
    recordPoolSample(addr, sample({ price: 0.001 }), 1000);
    recordPoolSample(addr, null, 2000); // failure
    expect(getPoolState(addr)!.consecutiveFailures).toBe(1);
    recordPoolSample(addr, sample({ price: 0.002 }), 3000);
    const s = getPoolState(addr)!;
    expect(s.price).toBe(0.002);
    expect(s.sampledAt).toBe(3000);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('HONESTY: a failed sample never overwrites the last good values', () => {
    const addr = randomAddress();
    recordPoolSample(addr, sample({ price: 0.001, quoteReserve: 100 }), 1000);
    recordPoolSample(addr, null, 2000);
    recordPoolSample(addr, null, 3000);
    const s = getPoolState(addr)!;
    // Last good values preserved — the API serves these as stale, never blanks.
    expect(s.price).toBe(0.001);
    expect(s.quoteReserve).toBe(100);
    expect(s.sampledAt).toBe(1000); // last SUCCESSFUL sample
    expect(s.lastAttemptAt).toBe(3000); // last attempt advanced
    expect(s.consecutiveFailures).toBe(2);
  });

  it('creates a bookkeeping row when the very first sample fails', () => {
    const addr = randomAddress();
    recordPoolSample(addr, null, 5000);
    const s = getPoolState(addr)!;
    expect(s.price).toBeNull();
    expect(s.sampledAt).toBeNull();
    expect(s.lastAttemptAt).toBe(5000);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('returns null for an address never sampled', () => {
    expect(getPoolState(randomAddress())).toBeNull();
  });
});

describe('getPoolStatesBatch', () => {
  it('matches getPoolState per pool and skips unsampled pools', () => {
    const a = randomAddress();
    const b = randomAddress();
    const c = randomAddress();
    recordPoolSample(a, sample({ price: 0.005 }), 1000);
    recordPoolSample(b, sample({ price: 0.007 }), 2000);
    const batch = getPoolStatesBatch([a, b, c, a]);
    expect(batch.size).toBe(2);
    expect(batch.get(a)).toEqual(getPoolState(a));
    expect(batch.get(b)).toEqual(getPoolState(b));
    expect(batch.has(c)).toBe(false);
  });
});
