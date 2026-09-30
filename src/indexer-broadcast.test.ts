import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleAllPools, setStateBroadcaster } from '@/indexer';
import { fetchPoolLiveState, type PoolLiveState } from '@/lib/pool-state';
import { insertPool } from '@/lib/db/pools';
import type { PoolStateBroadcaster } from '@/indexer-ws';
import { SOL_MINT } from '@/lib/quote-assets';
import { randomAddress, useTempDb } from '@/test-support/db';

vi.mock('@/lib/pool-state', () => ({ fetchPoolLiveState: vi.fn() }));

const mockFetch = fetchPoolLiveState as unknown as ReturnType<typeof vi.fn>;

let db: Awaited<ReturnType<typeof useTempDb>>;
beforeEach(async () => {
  db = await useTempDb();
  vi.clearAllMocks();
  setStateBroadcaster(null);
});
afterEach(async () => {
  setStateBroadcaster(null);
  await db.cleanup();
});

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

function fakeBroadcaster() {
  const calls: Array<{ poolAddress: string; state: unknown }> = [];
  const fake = {
    broadcast: vi.fn((poolAddress: string, state: unknown) => {
      calls.push({ poolAddress, state });
    }),
  };
  return { fake, calls };
}

describe('indexer push broadcast wiring', () => {
  it('broadcasts the fresh state for each sampled pool when attached', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue(fullState(2));
    const { fake, calls } = fakeBroadcaster();
    setStateBroadcaster(fake as unknown as PoolStateBroadcaster);

    await sampleAllPools();

    expect(fake.broadcast).toHaveBeenCalledTimes(1);
    expect(calls[0].poolAddress).toBe(p.poolAddress);
    const st = calls[0].state as Record<string, unknown>;
    expect(st.price).toBe(2);
    expect(st.stale).toBe(false);
    expect(typeof st.sampledAt).toBe('number');
    expect(st.baseSymbol).toBe('SEED');
  });

  it('does not broadcast failed samples', async () => {
    await seedPool();
    mockFetch.mockResolvedValue(failedState);
    const { fake } = fakeBroadcaster();
    setStateBroadcaster(fake as unknown as PoolStateBroadcaster);

    await sampleAllPools();

    expect(fake.broadcast).not.toHaveBeenCalled();
  });

  it('samples normally with no broadcaster attached (push disabled)', async () => {
    const p = await seedPool();
    mockFetch.mockResolvedValue(fullState(0.002));
    // No setStateBroadcaster call: INDEXER_WS_PORT unset path.
    await expect(sampleAllPools()).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(p);
  });
});
