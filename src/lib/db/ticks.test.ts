import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getHistory,
  getLatestPrice,
  getPrice24hAgo,
  getPrices24hAgoBatch,
  getTradeStats24h,
  getVolume24h,
  getVolumes24hBatch,
  pruneTicks,
  recordTick,
} from './ticks';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

describe('recordTick / getLatestPrice', () => {
  it('upserts on (pool, ts): a restart never double-counts a tick', async () => {
    const addr = randomAddress();
    await recordTick(addr, 1000, 0.001, 50);
    await recordTick(addr, 1000, 0.002, 60);
    const latest = (await getLatestPrice(addr))!;
    expect(latest.price).toBe(0.002);
    expect((await getHistory(addr, 0, 2000)).points).toHaveLength(1);
  });

  it('returns null latest price when there are no ticks', async () => {
    expect(await getLatestPrice(randomAddress())).toBeNull();
  });
});

describe('getHistory honesty invariants', () => {
  it('HONESTY: empty history returns an honest empty state, never fabricated points', async () => {
    const r = await getHistory(randomAddress(), 0, 1000);
    expect(r.points).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.earliest).toBeNull();
  });

  it('buckets dense ticks and reports complete', async () => {
    const addr = randomAddress();
    // 60 ticks, 1s apart — dense relative to the window.
    for (let i = 0; i < 60; i++) await recordTick(addr, i * 1000, 0.001 + i * 1e-6, 50);
    const r = await getHistory(addr, 0, 60_000, 300);
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.complete).toBe(true);
    expect(r.earliest).toBe(0);
    // Points are real samples: every returned price matches a recorded tick.
    for (const p of r.points) {
      expect(p.t % 1000).toBe(0);
    }
  });

  it('HONESTY: gaps larger than 5 buckets are reported as incomplete, never interpolated', async () => {
    const addr = randomAddress();
    for (let i = 0; i < 10; i++) await recordTick(addr, i * 1000, 0.001, 50);
    // A 1-hour hole in the middle.
    for (let i = 0; i < 10; i++) await recordTick(addr, 3_600_000 + i * 1000, 0.002, 60);
    const r = await getHistory(addr, 0, 3_700_000, 300);
    expect(r.complete).toBe(false);
    // No synthetic point exists inside the hole.
    expect(r.points.some((p) => p.t > 20_000 && p.t < 3_590_000)).toBe(false);
  });

  it('respects the requested window', async () => {
    const addr = randomAddress();
    await recordTick(addr, 1000, 0.001, 50);
    await recordTick(addr, 5000, 0.002, 50);
    const r = await getHistory(addr, 4000, 6000);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].price).toBe(0.002);
    // earliest is global, not window-scoped.
    expect(r.earliest).toBe(1000);
  });

  it('caps bucketing at maxPoints', async () => {
    const addr = randomAddress();
    for (let i = 0; i < 1000; i++) await recordTick(addr, i * 100, 0.001, 50);
    const r = await getHistory(addr, 0, 100_000, 50);
    expect(r.points.length).toBeLessThanOrEqual(50);
  });
});

describe('getVolume24h', () => {
  it('HONESTY: returns null when history is too thin to be honest about', async () => {
    const addr = randomAddress();
    expect(await getVolume24h(addr)).toBeNull();
    const now = Date.now();
    await recordTick(addr, now - 30 * 60_000, 0.001, 50); // single tick
    expect(await getVolume24h(addr)).toBeNull();
  });

  it('HONESTY: requires at least 1h of coverage before quoting a 24h number', async () => {
    const addr = randomAddress();
    const now = Date.now();
    await recordTick(addr, now - 30 * 60_000, 0.001, 50);
    await recordTick(addr, now, 0.001, 70);
    expect(await getVolume24h(addr)).toBeNull();
  });

  it('sums absolute quote-reserve movements (estimated activity)', async () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    await recordTick(addr, t0, 0.001, 100);
    await recordTick(addr, t0 + 3600_000, 0.0011, 150); // +50
    await recordTick(addr, t0 + 2 * 3600_000 - 1000, 0.0009, 120); // -30
    expect(await getVolume24h(addr)).toBe(80);
  });

  it('ignores ticks without a quote reserve', async () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    await recordTick(addr, t0, 0.001, null);
    await recordTick(addr, t0 + 3600_000, 0.001, null);
    expect(await getVolume24h(addr)).toBeNull();
  });
});

describe('getPrice24hAgo', () => {
  it('returns the latest tick at or before the 24h cutoff', async () => {
    const addr = randomAddress();
    const now = Date.now();
    await recordTick(addr, now - 30 * 3600_000, 0.001, 50);
    await recordTick(addr, now - 25 * 3600_000, 0.0015, 55);
    await recordTick(addr, now - 3600_000, 0.002, 60);
    expect(await getPrice24hAgo(addr)).toBe(0.0015);
  });

  it('returns null when there is no history before the cutoff', async () => {
    const addr = randomAddress();
    await recordTick(addr, Date.now() - 3600_000, 0.002, 60);
    expect(await getPrice24hAgo(addr)).toBeNull();
  });
});

describe('pruneTicks', () => {
  it('drops only ticks older than the cutoff', async () => {
    const addr = randomAddress();
    await recordTick(addr, 1000, 0.001, 50);
    await recordTick(addr, 5000, 0.002, 50);
    await pruneTicks(3000);
    const r = await getHistory(addr, 0, 10_000);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].t).toBe(5000);
  });
});

describe('getTradeStats24h', () => {
  it('splits positive and negative reserve deltas into buys and sells', async () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    // reserves: 100 -> 110 (+10 buy) -> 105 (-5 sell) -> 120 (+15 buy)
    await recordTick(addr, t0, 0.001, 100);
    await recordTick(addr, t0 + 3600_000, 0.0011, 110);
    await recordTick(addr, t0 + 2 * 3600_000, 0.00105, 105);
    await recordTick(addr, t0 + 3 * 3600_000, 0.0012, 120);
    const s = (await getTradeStats24h(addr))!;
    expect(s.buys).toBe(2);
    expect(s.sells).toBe(1);
    expect(s.buyVolume).toBeCloseTo(25, 10);
    expect(s.sellVolume).toBeCloseTo(5, 10);
  });

  it('ignores flat ticks (no direction)', async () => {
    const addr = randomAddress();
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    await recordTick(addr, t0, 0.001, 100);
    await recordTick(addr, t0 + 3600_000, 0.001, 100);
    await recordTick(addr, t0 + 2 * 3600_000, 0.001, 110);
    const s = (await getTradeStats24h(addr))!;
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(0);
    expect(s.sellVolume).toBe(0);
  });

  it('HONESTY: null when history is too thin (under 1h coverage)', async () => {
    const addr = randomAddress();
    const now = Date.now();
    await recordTick(addr, now - 30 * 60_000, 0.001, 100);
    await recordTick(addr, now, 0.0011, 110);
    expect(await getTradeStats24h(addr)).toBeNull();
  });

  it('HONESTY: null when there are no ticks at all', async () => {
    expect(await getTradeStats24h(randomAddress())).toBeNull();
  });

  it('HONESTY: null when fewer than 2 ticks carry a reserve', async () => {
    const addr = randomAddress();
    const now = Date.now();
    await recordTick(addr, now - 2 * 3600_000, 0.001, 100);
    await recordTick(addr, now - 3600_000, 0.001, null);
    expect(await getTradeStats24h(addr)).toBeNull();
  });
});

describe('batch reads (parity with per-pool versions)', () => {
  it('getPrices24hAgoBatch matches getPrice24hAgo per pool', async () => {
    const now = Date.now();
    const addrs = [randomAddress(), randomAddress(), randomAddress()];
    // Pool 0: ticks straddling the cutoff; pool 1: only recent ticks;
    // pool 2: no ticks at all.
    await recordTick(addrs[0], now - 25 * 3600_000, 0.001, 100);
    await recordTick(addrs[0], now - 23 * 3600_000, 0.002, 110);
    await recordTick(addrs[0], now - 1 * 3600_000, 0.003, 120);
    await recordTick(addrs[1], now - 1 * 3600_000, 0.005, 200);
    const batch = await getPrices24hAgoBatch(addrs);
    expect(batch.get(addrs[0])).toBe(await getPrice24hAgo(addrs[0]));
    expect(batch.get(addrs[0])).toBe(0.001);
    expect(batch.has(addrs[1])).toBe(await getPrice24hAgo(addrs[1]) !== null);
    expect(batch.has(addrs[2])).toBe(false);
  });

  it('getVolumes24hBatch matches getVolume24h per pool', async () => {
    const now = Date.now();
    const addrs = [randomAddress(), randomAddress(), randomAddress()];
    // Pool 0: 2h of ticks with reserve movement.
    for (let i = 0; i <= 12; i++) {
      await recordTick(addrs[0], now - 2 * 3600_000 + i * 600_000, 0.001, 100 + i * 5);
    }
    // Pool 1: under 1h coverage -> null in both.
    await recordTick(addrs[1], now - 30 * 60_000, 0.001, 100);
    await recordTick(addrs[1], now, 0.0011, 110);
    const batch = await getVolumes24hBatch(addrs);
    expect(batch.get(addrs[0])).toBe(await getVolume24h(addrs[0]));
    expect(batch.get(addrs[0])).toBe(60);
    expect(batch.has(addrs[1])).toBe(false);
    expect(await getVolume24h(addrs[1])).toBeNull();
    expect(batch.has(addrs[2])).toBe(false);
  });

  it('batch reads handle >500 pools (chunking)', async () => {
    const addrs = Array.from({ length: 1200 }, () => randomAddress());
    const now = Date.now();
    for (const a of addrs) {
      await recordTick(a, now - 25 * 3600_000, 0.001, 100);
      await recordTick(a, now - 3600_000, 0.002, 150);
    }
    const batch = await getPrices24hAgoBatch(addrs);
    expect(batch.size).toBe(1200);
    for (const a of addrs) expect(batch.get(a)).toBe(0.001);
  });
});
