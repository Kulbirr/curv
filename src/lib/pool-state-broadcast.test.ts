import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBroadcastState } from './pool-state-broadcast';
import type { TrackedPool } from './db/pools';
import type { PoolStateSample } from './db/states';
import type { TradeStats24h } from '@/components/Pool/types';

vi.mock('./db/ticks', () => ({ getTradeStats24h: vi.fn(async () => null) }));
vi.mock('./quote-prices', () => ({ getQuoteUsdPrice: vi.fn(async () => null) }));

import { getTradeStats24h } from './db/ticks';
import { getQuoteUsdPrice } from './quote-prices';

const mockStats = getTradeStats24h as unknown as ReturnType<typeof vi.fn>;
const mockQuoteUsd = getQuoteUsdPrice as unknown as ReturnType<typeof vi.fn>;

const POOL = 'HGGtnXhcPgX8LdyKuiY4BT7K87XubgzZPzktGF6KttRT';

function trackedPool(): TrackedPool {
  return {
    poolAddress: POOL,
    configAddress: 'Config1111111111111111111111111111111111111',
    baseMint: 'Base11111111111111111111111111111111111111111',
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    quoteSymbol: 'SOL',
    description: 'a test pool',
    imageUrl: 'https://example.com/img.png',
    creator: 'Creator1111111111111111111111111111111111111',
    createdAt: 1700000000000,
    verified: true,
  };
}

function sample(): PoolStateSample {
  return {
    price: 0.25,
    quoteReserve: 500,
    baseReserve: 2000,
    progress: 12.5,
    graduated: false,
    hasSwap: true,
    marketCap: 250000,
    baseDecimals: 6,
    quoteDecimals: 9,
    migrationQuoteThreshold: 4000,
    creatorBaseFeeRaw: '111',
    creatorQuoteFeeRaw: '222',
  };
}

describe('buildBroadcastState', () => {
  beforeEach(() => {
    mockStats.mockReset().mockResolvedValue(null);
    mockQuoteUsd.mockReset().mockResolvedValue(null);
  });

  it('assembles the state API shape from registry plus sample', async () => {
    const stats: TradeStats24h = { buyVolume: 10, sellVolume: 4, buys: 3, sells: 1 };
    mockStats.mockResolvedValue(stats);
    const now = Date.now();
    const out = await buildBroadcastState(trackedPool(), sample(), now);

    // Registry fields
    expect(out.poolAddress).toBe(POOL);
    expect(out.baseSymbol).toBe('TEST');
    expect(out.baseName).toBe('Test Token');
    expect(out.quoteSymbol).toBe('SOL');
    expect(out.imageUrl).toBe('https://example.com/img.png');
    expect(out.description).toBe('a test pool');
    expect(out.creator).toBe('Creator1111111111111111111111111111111111111');
    expect(out.createdAt).toBe(1700000000000);
    // Sample fields
    expect(out.price).toBe(0.25);
    expect(out.quoteReserve).toBe(500);
    expect(out.baseReserve).toBe(2000);
    expect(out.progress).toBe(12.5);
    expect(out.graduated).toBe(false);
    expect(out.hasSwap).toBe(true);
    expect(out.marketCap).toBe(250000);
    expect(out.baseDecimals).toBe(6);
    expect(out.quoteDecimals).toBe(9);
    expect(out.migrationQuoteThreshold).toBe(4000);
    expect(out.creatorBaseFeeRaw).toBe('111');
    expect(out.creatorQuoteFeeRaw).toBe('222');
    // Derived fields
    expect(out.tradeStats24h).toEqual(stats);
    expect(out.sampledAt).toBe(now);
    expect(out.stale).toBe(false);
    // Devnet: no USD conversion
    expect(out.priceUsd).toBeNull();
    expect(out.marketCapUsd).toBeNull();
    expect(mockStats).toHaveBeenCalledWith(POOL);
  });

  it('computes USD fields when a quote price is available', async () => {
    mockQuoteUsd.mockResolvedValue(200);
    const out = await buildBroadcastState(trackedPool(), sample(), Date.now());
    expect(out.priceUsd).toBe(0.25 * 200);
    expect(out.marketCapUsd).toBe(250000 * 200);
  });

  it('marks a fresh sample as not stale', async () => {
    const out = await buildBroadcastState(trackedPool(), sample(), Date.now());
    expect(out.stale).toBe(false);
    expect(typeof out.sampledAt).toBe('number');
  });
});
