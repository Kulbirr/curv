import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleAllPools } from '@/indexer';
import { fetchPoolLiveState, type PoolLiveState } from '@/lib/pool-state';
import { execute, query } from '@/lib/db';
import { insertPool } from '@/lib/db/pools';
import { getPoolState } from '@/lib/db/states';
import { getHistory, getLatestPrice } from '@/lib/db/ticks';
import { SOL_MINT } from '@/lib/quote-assets';
import { randomAddress, useTempDb } from '@/test-support/db';

vi.mock('@/lib/pool-state', () => ({ fetchPoolLiveState: vi.fn() }));

const mockFetch = fetchPoolLiveState as unknown as ReturnType<typeof vi.fn>;

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
  vi.clearAllMocks();
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

function fullState(price: number): PoolLiveState {
  return {
    stale: false,
    price,
    quoteReserve: 100,
    baseReserve: 100000,
    progress: 10,
    graduated: false,
    hasSwap: true,
    marketCap: price * 1e9,
    baseDecimals: 9,
    quoteDecimals: 9,
    migrationQuoteThreshold: 1000,
    creatorBaseFeeRaw: '12345',
    creatorQuoteFeeRaw: '67890',
  };
}

const failedState: PoolLiveState = {
  stale: true,
  price: null,
  quoteReserve: null,
  baseReserve: null,
  progress: null,
  graduated: false,
  hasSwap: false,
  marketCap: null,
  baseDecimals: 9,
  quoteDecimals: 9,
  migrationQuoteThreshold: null,
  creatorBaseFeeRaw: null,
  creatorQuoteFeeRaw: null,
};

describe('sampleAllPools', () => {
  it('does nothing (and fetches nothing) with an empty registry', async () => {
    await sampleAllPools();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('persists a successful sample to pool_states and one tick', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue(fullState(0.002));
    await sampleAllPools();
    expect(mockFetch).toHaveBeenCalledWith(p);
    const latest = (await getPoolState(p.poolAddress))!;
    expect(latest.price).toBe(0.002);
    expect(latest.consecutiveFailures).toBe(0);
    const ticks = (await getHistory(p.poolAddress, 0, Date.now())).points;
    expect(ticks).toHaveLength(1);
    expect(ticks[0].price).toBe(0.002);
  });

  it('records a null-price sample but writes no tick', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue({ ...fullState(0), price: null });
    await sampleAllPools();
    expect(await getPoolState(p.poolAddress)).not.toBeNull();
    expect((await getHistory(p.poolAddress, 0, Date.now())).points).toHaveLength(0);
  });

  it('preserves the last good values and increments failures when the chain goes stale', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue(fullState(0.005));
    await sampleAllPools();
    mockFetch.mockResolvedValue(failedState);
    await sampleAllPools();
    const latest = (await getPoolState(p.poolAddress))!;
    expect(latest.price).toBe(0.005); // last good price preserved
    expect(latest.consecutiveFailures).toBe(1);
    expect((await getPoolState(p.poolAddress))!.price).toBe(0.005);
    // No new tick from a failed sample.
    expect((await getHistory(p.poolAddress, 0, Date.now())).points).toHaveLength(1);
  });

  it('survives a thrown fetch without aborting the whole pass', async () => {
    const a = await seedPool();
    const b = await seedPool();
    mockFetch.mockImplementation(async (tracked: { poolAddress: string }) => {
      if (tracked.poolAddress === a.poolAddress) throw new Error('RPC exploded');
      return fullState(0.001);
    });
    await sampleAllPools();
    const la = (await getPoolState(a.poolAddress))!;
    expect(la.consecutiveFailures).toBe(1);
    expect(la.price).toBeNull(); // no prior good sample: honest null
    expect((await getPoolState(b.poolAddress))!.price).toBe(0.001); // b still sampled
  });

  it('prunes ticks older than the retention window', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue(fullState(0.001));
    const ancient = Date.now() - 10 * 24 * 3600_000;
    await execute('INSERT INTO ticks (pool_address, ts, price, quote_reserve) VALUES ($1, $2, $3, $4)', [p.poolAddress, ancient, 0.0005, 50]);
    await sampleAllPools();
    const rows = await query<{ ts: number }>('SELECT ts FROM ticks WHERE pool_address = $1', [p.poolAddress]);
    expect(rows.every((r) => r.ts > ancient)).toBe(true);
    expect(rows).toHaveLength(1); // only the fresh tick survives
  });
});
