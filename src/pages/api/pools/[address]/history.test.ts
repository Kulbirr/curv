import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import handler from './history';
import { insertPool } from '@/lib/db/pools';
import { recordTick } from '@/lib/db/ticks';
import { SOL_MINT } from '@/lib/quote-assets';
import { mockReqRes } from '@/test-support/http';
import { randomAddress, useTempDb } from '@/test-support/db';

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
});
afterEach(async () => { await db.cleanup(); });

async function seedPool() {
  return await insertPool({
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: SOL_MINT,
    creator: randomAddress(),
    baseSymbol: 'SEED',
    baseName: 'Seed Token',
    quoteSymbol: 'SOL',
    verified: true,
  });
}

describe('GET /api/pools/[address]/history', () => {
  it('serves bucketed real samples: 200', async () => {
    const p = await seedPool();
    const now = Date.now();
    for (let i = 0; i < 20; i++) await recordTick(p.poolAddress, now - i * 60_000, 0.001 + i * 1e-6, 100);
    const { req, res } = mockReqRes('GET', {
      query: { address: p.poolAddress, from: String(now - 3_600_000), to: String(now) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.poolAddress).toBe(p.poolAddress);
    expect(res.body.points.length).toBeGreaterThan(0);
    expect(res.body.complete).toBe(true);
    expect(res.body.earliest).toBeLessThanOrEqual(now - 19 * 60_000);
  });

  it('HONESTY: empty history returns an honest empty state, never invented points', async () => {
    const p = await seedPool();
    const now = Date.now();
    const { req, res } = mockReqRes('GET', {
      query: { address: p.poolAddress, from: String(now - 3_600_000), to: String(now) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.complete).toBe(false);
    expect(res.body.volume24h).toBeNull();
  });

  it('HONESTY: gaps surface as complete: false so the chart renders them honestly', async () => {
    const p = await seedPool();
    const now = Date.now();
    for (let i = 0; i < 5; i++) await recordTick(p.poolAddress, now - 3_600_000 + i * 1000, 0.001, 100);
    for (let i = 0; i < 5; i++) await recordTick(p.poolAddress, now - i * 1000, 0.002, 100);
    const { req, res } = mockReqRes('GET', {
      query: { address: p.poolAddress, from: String(now - 3_600_000), to: String(now) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.complete).toBe(false);
  });

  it('rejects invalid time windows: 400', async () => {
    const p = await seedPool();
    const now = Date.now();
    const bad = mockReqRes('GET', {
      query: { address: p.poolAddress, from: String(now), to: String(now - 1000) },
    });
    await handler(bad.req, bad.res);
    expect(bad.res.statusCode).toBe(400);

    const wide = mockReqRes('GET', {
      query: { address: p.poolAddress, from: String(now - 40 * 24 * 3600_000), to: String(now) },
    });
    await handler(wide.req, wide.res);
    expect(wide.res.statusCode).toBe(400);
  });

  it('rejects malformed addresses: 400 and unknown pools: 404', async () => {
    const bad = mockReqRes('GET', { query: { address: 'nope' } });
    await handler(bad.req, bad.res);
    expect(bad.res.statusCode).toBe(400);

    const unknown = mockReqRes('GET', { query: { address: randomAddress() } });
    await handler(unknown.req, unknown.res);
    expect(unknown.res.statusCode).toBe(404);
  });

  it('rejects non-GET methods: 405', async () => {
    const { req, res } = mockReqRes('DELETE', { query: { address: randomAddress() } });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
