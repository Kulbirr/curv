import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getHistory,
  getLatestPrice,
  getPrice24hAgo,
  getTradeStats24h,
  getVolume24h,
  pruneTicks,
  recordTick,
} from './ticks';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

describe('recordTick / getLatestPrice', () => {
  it('upserts on (pool, ts): a restart never double-counts a tick', () => {
    const addr = randomAddress();
    recordTick(addr, 1000, 0.001, 50);
    recordTick(addr, 1000, 0.002, 60);
    const latest = getLatestPrice(addr)!;
    expect(latest.price).toBe(0.002);
    expect(getHistory(addr, 0, 2000).points).toHaveLength(1);
  });

  it('returns null latest price when there are no ticks', () => {
    expect(getLatestPrice(randomAddress())).toBeNull();
  });
});

describe('getHistory honesty invariants', () => {
  it('HONESTY: empty history returns an honest empty state, never fabricated points', () => {
    const r = getHistory(randomAddress(), 0, 1000);
    expect(r.points).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.earliest).toBeNull();
  });

  it('buckets dense ticks and reports complete', () => {
    const addr = randomAddress();
    // 60 ticks, 1s apart — dense relative to the window.
    for (let i = 0; i < 60; i++) recordTick(addr, i * 1000, 0.001 + i * 1e-6, 50);
    const r = getHistory(addr, 0, 60_000, 300);
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.complete).toBe(true);
    expect(r.earliest).toBe(0);
    // Points are real samples: every returned price matches a recorded tick.
    for (const p of r.points) {
      expect(p.t % 1000).toBe(0);
    }
  });

  it('HONESTY: gaps larger than 5 buckets are reported as incomplete, never interpolated', () => {
    const addr = randomAddress();
    for (let i = 0; i < 10; i++) recordTick(addr, i * 1000, 0.001, 50);
    // A 1-hour hole in the middle.
    for (let i = 0; i < 10; i++) recordTick(addr, 3_600_000 + i * 1000, 0.002, 60);
    const r = getHistory(addr, 0, 3_700_000, 300);
    expect(r.complete).toBe(false);
    // No synthetic point exists inside the hole.
    expect(r.points.some((p) => p.t > 20_000 && p.t < 3_590_000)).toBe(false);
  });

  it('respects the requested window', () => {
    const addr = randomAddress();
    recordTick(addr, 1000, 0.001, 50);
    recordTick(addr, 5000, 0.002, 50);
    const r = getHistory(addr, 4000, 6000);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].price).toBe(0.002);
    // earliest is global, not window-scoped.
    expect(r.earliest).toBe(1000);
  });

  it('caps bucketing at maxPoints', () => {
    const addr = randomAddress();
    for (let i = 0; i < 1000; i++) recordTick(addr, i * 100, 0.001, 50);
    const r = getHistory(addr, 0, 100_000, 50);
    expect(r.points.length).toBeLessThanOrEqual(50);
  });
});

describe('getVolume24h', () => {
  it('HONESTY: returns null when history is too thin to be honest about', () => {
    const addr = randomAddress();
    expect(getVolume24h(addr)).toBeNull();
    const now = Date.now();
    recordTick(addr, now - 30 * 60_000, 0.001, 50); // single tick
    expect(getVolume24h(addr)).toBeNull();
  });

  it('HONESTY: requires at least 1h of coverage before quoting a 24h number', () => {
    const addr = randomAddress();
    const now = Date.now();
    recordTick(addr, now - 30 * 60_000, 0.001, 50);
    recordTick(addr, now, 0.001, 70);
    expect(getVolume24h(addr)).toBeNull();
  });

  it('sums absolute quote-reserve movements (estimated activity)', () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    recordTick(addr, t0, 0.001, 100);
    recordTick(addr, t0 + 3600_000, 0.0011, 150); // +50
    recordTick(addr, t0 + 2 * 3600_000 - 1000, 0.0009, 120); // -30
    expect(getVolume24h(addr)).toBe(80);
  });

  it('ignores ticks without a quote reserve', () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    recordTick(addr, t0, 0.001, null);
    recordTick(addr, t0 + 3600_000, 0.001, null);
    expect(getVolume24h(addr)).toBeNull();
  });
});

describe('getPrice24hAgo', () => {
  it('returns the latest tick at or before the 24h cutoff', () => {
    const addr = randomAddress();
    const now = Date.now();
    recordTick(addr, now - 30 * 3600_000, 0.001, 50);
    recordTick(addr, now - 25 * 3600_000, 0.0015, 55);
    recordTick(addr, now - 3600_000, 0.002, 60);
    expect(getPrice24hAgo(addr)).toBe(0.0015);
  });

  it('returns null when there is no history before the cutoff', () => {
    const addr = randomAddress();
    recordTick(addr, Date.now() - 3600_000, 0.002, 60);
    expect(getPrice24hAgo(addr)).toBeNull();
  });
});

describe('pruneTicks', () => {
  it('drops only ticks older than the cutoff', () => {
    const addr = randomAddress();
    recordTick(addr, 1000, 0.001, 50);
    recordTick(addr, 5000, 0.002, 50);
    pruneTicks(3000);
    const r = getHistory(addr, 0, 10_000);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].t).toBe(5000);
  });
});

describe('getTradeStats24h', () => {
  it('splits positive and negative reserve deltas into buys and sells', () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    // reserves: 100 -> 110 (+10 buy) -> 105 (-5 sell) -> 120 (+15 buy)
    recordTick(addr, t0, 0.001, 100);
    recordTick(addr, t0 + 3600_000, 0.0011, 110);
    recordTick(addr, t0 + 2 * 3600_000, 0.00105, 105);
    recordTick(addr, t0 + 3 * 3600_000, 0.0012, 120);
    const s = getTradeStats24h(addr)!;
    expect(s.buys).toBe(2);
    expect(s.sells).toBe(1);
    expect(s.buyVolume).toBeCloseTo(25, 10);
    expect(s.sellVolume).toBeCloseTo(5, 10);
  });

  it('ignores flat ticks (no direction)', () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    recordTick(addr, t0, 0.001, 100);
    recordTick(addr, t0 + 3600_000, 0.001, 100);
    recordTick(addr, t0 + 2 * 3600_000, 0.001, 110);
    const s = getTradeStats24h(addr)!;
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(0);
    expect(s.sellVolume).toBe(0);
  });

  it('HONESTY: null when history is too thin (under 1h coverage)', () => {
    const addr = randomAddress();
    const now = Date.now();
    recordTick(addr, now - 30 * 60_000, 0.001, 100);
    recordTick(addr, now, 0.0011, 110);
    expect(getTradeStats24h(addr)).toBeNull();
  });

  it('HONESTY: null when there are no ticks at all', () => {
    expect(getTradeStats24h(randomAddress())).toBeNull();
  });

  it('HONESTY: null when fewer than 2 ticks carry a reserve', () => {
    const addr = randomAddress();
    const now = Date.now();
    recordTick(addr, now - 2 * 3600_000, 0.001, 100);
    recordTick(addr, now - 3600_000, 0.001, null);
    expect(getTradeStats24h(addr)).toBeNull();
  });
});
