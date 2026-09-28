import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './state';
import { insertPool } from '@/lib/db/pools';
import { recordPoolSample } from '@/lib/db/states';
import { recordTick } from '@/lib/db/ticks';
import { SOL_MINT } from '@/lib/quote-assets';
import { mockReqRes } from '@/test-support/http';
import { randomAddress, useTempDb } from '@/test-support/db';

vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getDbcClient: vi.fn() };
});

let db: ReturnType<typeof useTempDb>;
beforeEach(() => {
  db = useTempDb();
});
afterEach(() => db.cleanup());

function seedPool(overrides: Record<string, unknown> = {}) {
  return insertPool({
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: SOL_MINT,
    creator: randomAddress(),
    baseSymbol: 'SEED',
    baseName: 'Seed Token',
    quoteSymbol: 'SOL',
    verified: true,
    ...overrides,
  });
}

function seedState(addr: string, sampledAt: number) {
  recordPoolSample(
    addr,
    {
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
      creatorBaseFeeRaw: '123456789',
      creatorQuoteFeeRaw: '987654321',
    },
    sampledAt,
  );
}

describe('GET /api/pools/[address]/state', () => {
  it('serves indexed state: 200 with baseMint and fresh flag', async () => {
    const p = seedPool();
    seedState(p.poolAddress, Date.now());
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.poolAddress).toBe(p.poolAddress);
    expect(res.body.baseMint).toBe(p.baseMint);
    expect(res.body.quoteMint).toBe(p.quoteMint);
    expect(res.body.price).toBe(0.001);
    expect(res.body.progress).toBe(12.5);
    expect(res.body.stale).toBe(false);
  });

  it('serves accrued creator fees as raw strings plus the sample timestamp', async () => {
    const p = seedPool();
    const now = Date.now();
    seedState(p.poolAddress, now);
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.creatorBaseFeeRaw).toBe('123456789');
    expect(res.body.creatorQuoteFeeRaw).toBe('987654321');
    expect(res.body.sampledAt).toBe(now);
    expect(res.body.baseDecimals).toBe(9);
    expect(res.body.quoteDecimals).toBe(9);
  });

  it('HONESTY: old samples are served with stale: true, values intact', async () => {
    const p = seedPool();
    seedState(p.poolAddress, Date.now() - 120_000);
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.price).toBe(0.001); // last real values shown, not blanked
  });

  it('HONESTY: never-sampled pools return honest nulls with stale: true', async () => {
    const p = seedPool();
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.price).toBeNull();
    expect(res.body.stale).toBe(true);
    expect(res.body.graduated).toBe(false);
  });

  it('rejects malformed addresses: 400', async () => {
    const { req, res } = mockReqRes('GET', { query: { address: 'nope' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('valid Solana address');
  });

  it('returns 404 for a valid but unregistered address', async () => {
    const { req, res } = mockReqRes('GET', { query: { address: randomAddress() } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('rejects non-GET methods: 405', async () => {
    const { req, res } = mockReqRes('POST', { query: { address: randomAddress() } });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('GET');
  });

  it('includes estimated 24h buy/sell stats from indexed reserve movement', async () => {
    const p = seedPool();
    seedState(p.poolAddress, Date.now());
    const now = Date.now();
    const t0 = now - 2 * 3600_000;
    recordTick(p.poolAddress, t0, 0.001, 100);
    recordTick(p.poolAddress, t0 + 3600_000, 0.0011, 110);
    recordTick(p.poolAddress, t0 + 2 * 3600_000, 0.00105, 105);
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.tradeStats24h).toEqual({ buys: 1, sells: 1, buyVolume: 10, sellVolume: 5 });
  });

  it('HONESTY: tradeStats24h is null when history is too thin to be honest about', async () => {
    const p = seedPool();
    seedState(p.poolAddress, Date.now());
    const { req, res } = mockReqRes('GET', { query: { address: p.poolAddress } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.tradeStats24h).toBeNull();
  });
});
