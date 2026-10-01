import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  TokenDecimal,
  createSqrtPrices,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { fetchPoolLiveState } from './pool-state';
import { fetchDammV2MarketSnapshot } from './damm-v2-state';
import { getConnection, getDbcClient } from '@/lib/solana';
import { getTokenDecimals } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { randomAddress } from '@/test-support/db';
import type { TrackedPool } from './pool-registry';

vi.mock('@/lib/solana', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solana')>();
  return { ...actual, getConnection: vi.fn(), getDbcClient: vi.fn() };
});

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meteora-ag/dynamic-bonding-curve-sdk')>();
  return { ...actual, getTokenDecimals: vi.fn() };
});

vi.mock('./damm-v2-state', () => ({
  fetchDammV2MarketSnapshot: vi.fn(),
}));

const mockGetConnection = getConnection as unknown as ReturnType<typeof vi.fn>;
const mockGetDbcClient = getDbcClient as unknown as ReturnType<typeof vi.fn>;
const mockGetTokenDecimals = getTokenDecimals as unknown as ReturnType<typeof vi.fn>;
const mockFetchDammV2 = vi.mocked(fetchDammV2MarketSnapshot);

function tracked(overrides: Partial<TrackedPool> = {}): TrackedPool {
  return {
    poolAddress: randomAddress(),
    configAddress: randomAddress(),
    baseMint: randomAddress(),
    quoteMint: randomAddress(),
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    quoteSymbol: 'SOL',
    creator: randomAddress(),
    createdAt: 1000,
    verified: true,
    ...overrides,
  };
}

interface FakeSetup {
  price?: number;
  quoteReserveRaw?: BN;
  baseReserveRaw?: BN;
  isMigrated?: number;
  hasSwap?: number;
  migrationThresholdRaw?: BN | null;
  configTokenDecimal?: number;
  supplyUiAmount?: number | null;
  poolNull?: boolean;
  poolThrows?: boolean;
  decimalsThrowFor?: 'base' | 'quote' | 'both';
  creatorBaseFee?: BN | null;
  creatorQuoteFee?: BN | null;
}

function setupChain(t: TrackedPool, s: FakeSetup = {}) {
  const sqrtPrice =
    s.price !== undefined ? createSqrtPrices([s.price], TokenDecimal.NINE, 9)[0] : null;
  const pool = s.poolNull
    ? null
    : {
        poolState: {
          sqrtPrice,
          quoteReserve: s.quoteReserveRaw ?? new BN('100000000000'), // 100 UI (9dp)
          baseReserve: s.baseReserveRaw ?? new BN('50000000000000'),
          isMigrated: s.isMigrated ?? 0,
          hasSwap: s.hasSwap ?? 1,
          creatorBaseFee: s.creatorBaseFee === null ? null : (s.creatorBaseFee ?? new BN('123456789')),
          creatorQuoteFee: s.creatorQuoteFee === null ? null : (s.creatorQuoteFee ?? new BN('987654321')),
        },
      };
  const config = {
    tokenDecimal: s.configTokenDecimal ?? 9,
    migrationQuoteThreshold: s.migrationThresholdRaw === null ? null : (s.migrationThresholdRaw ?? new BN('800000000000')),
  };
  mockGetDbcClient.mockReturnValue({
    state: {
      getPool: s.poolThrows
        ? vi.fn().mockRejectedValue(new Error('RPC down'))
        : vi.fn().mockResolvedValue(pool),
      getPoolConfig: vi.fn().mockResolvedValue(config),
    },
  });
  mockGetConnection.mockReturnValue({
    getTokenSupply: vi.fn().mockResolvedValue({
      value: { uiAmount: s.supplyUiAmount === undefined ? 1_000_000_000 : s.supplyUiAmount },
    }),
  });
  mockGetTokenDecimals.mockImplementation(async (_c: unknown, mint: PublicKey) => {
    const m = mint.toBase58();
    if (s.decimalsThrowFor === 'both' || (s.decimalsThrowFor === 'base' && m === t.baseMint) || (s.decimalsThrowFor === 'quote' && m === t.quoteMint)) {
      throw new Error('mint unreadable');
    }
    return 9;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Graduated pools read the live market from the DAMM v2 pool; default
  // the mock to a healthy snapshot so pre-existing graduation tests keep
  // their intent (graduation detection), and override per test as needed.
  mockFetchDammV2.mockResolvedValue({
    price: 0.004,
    quoteReserve: 50,
    baseReserve: 12500,
  });
});

describe('fetchPoolLiveState', () => {
  it('reads price, reserves, progress and market cap from the chain', async () => {
    const t = tracked();
    setupChain(t, { price: 0.002 });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    expect(s.price).toBeCloseTo(0.002, 6);
    expect(s.quoteReserve).toBeCloseTo(100, 6);
    expect(s.progress).toBeCloseTo((100 / 800) * 100, 6);
    expect(s.hasSwap).toBe(true);
    expect(s.graduated).toBe(false);
    expect(s.marketCap).toBeCloseTo(0.002 * 1_000_000_000, 3);
    expect(s.baseDecimals).toBe(9);
    expect(s.quoteDecimals).toBe(9);
    expect(s.migrationQuoteThreshold).toBeCloseTo(800, 6);
  });

  it('reads accrued creator fees as exact raw strings', async () => {
    const t = tracked();
    setupChain(t, {
      price: 0.002,
      creatorBaseFee: new BN('18446744073709551615'),
      creatorQuoteFee: new BN('42'),
    });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    // Raw decimal strings — u64 max survives without float precision loss.
    expect(s.creatorBaseFeeRaw).toBe('18446744073709551615');
    expect(s.creatorQuoteFeeRaw).toBe('42');
  });

  it('HONESTY: missing creator fee fields read as null, not zero', async () => {
    const t = tracked();
    setupChain(t, { price: 0.002, creatorBaseFee: null, creatorQuoteFee: null });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    expect(s.creatorBaseFeeRaw).toBeNull();
    expect(s.creatorQuoteFeeRaw).toBeNull();
  });

  it('HONESTY: a missing pool account returns the failed shape, never invented numbers', async () => {
    const t = tracked();
    setupChain(t, { poolNull: true });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(true);
    expect(s.price).toBeNull();
    expect(s.quoteReserve).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.marketCap).toBeNull();
  });

  it('HONESTY: an RPC exception returns the failed shape', async () => {
    const t = tracked();
    setupChain(t, { poolThrows: true });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(true);
    expect(s.price).toBeNull();
  });

  it('leaves price null (not stale) when the pool has no sqrt price yet', async () => {
    const t = tracked();
    setupChain(t, {}); // price undefined -> sqrtPrice null
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    expect(s.price).toBeNull();
    expect(s.quoteReserve).toBeCloseTo(100, 6);
    expect(s.marketCap).toBeNull(); // no price -> no market cap, honestly
  });

  it('clamps progress to 0-100 and graduates at 100', async () => {
    const t = tracked();
    setupChain(t, {
      price: 0.001,
      quoteReserveRaw: new BN('900000000000'), // 900 UI > 800 threshold
    });
    const s = await fetchPoolLiveState(t);
    expect(s.progress).toBe(100);
    expect(s.graduated).toBe(true);
  });

  it('marks graduated from the on-chain migrated flag', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, isMigrated: 1 });
    expect((await fetchPoolLiveState(t)).graduated).toBe(true);
  });

  it('maps hasSwap from the on-chain flag', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, hasSwap: 0 });
    expect((await fetchPoolLiveState(t)).hasSwap).toBe(false);
  });

  it('falls back to config tokenDecimal when the base mint is unreadable', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, decimalsThrowFor: 'base', configTokenDecimal: 6 });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    expect(s.baseDecimals).toBe(6);
  });

  it('falls back to 9 quote decimals when the quote mint is unreadable', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, decimalsThrowFor: 'quote' });
    const s = await fetchPoolLiveState(t);
    expect(s.quoteDecimals).toBe(9);
  });

  it('converts reserves with 6-decimal mints', async () => {
    const t = tracked();
    setupChain(t, {
      price: 0.001,
      quoteReserveRaw: new BN('2500000'), // 2.5 UI at 6dp
      decimalsThrowFor: 'both',
      configTokenDecimal: 6,
    });
    // quote mint falls back to 9dp: 2_500_000 raw / 1e9 = 0.0025
    const s = await fetchPoolLiveState(t);
    expect(s.quoteReserve).toBeCloseTo(0.0025, 9);
  });

  it('leaves market cap null when the supply read is missing', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, supplyUiAmount: null });
    const s = await fetchPoolLiveState(t);
    expect(s.price).toBeCloseTo(0.001, 6);
    expect(s.marketCap).toBeNull();
  });

  it('leaves progress null when the migration threshold is unknown', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, migrationThresholdRaw: null });
    const s = await fetchPoolLiveState(t);
    expect(s.progress).toBeNull();
    expect(s.migrationQuoteThreshold).toBeNull();
    expect(s.graduated).toBe(false);
  });

  it('agrees with the SDK spot-price math on a known sqrt price', async () => {
    const t = tracked();
    const sp = createSqrtPrices([0.005], TokenDecimal.NINE, 9)[0];
    const expected = Number(getPriceFromSqrtPrice(sp, TokenDecimal.NINE, 9).toString());
    setupChain(t, { price: 0.005 });
    const s = await fetchPoolLiveState(t);
    expect(s.price).toBeCloseTo(expected, 9);
  });

  it('reads live price and reserves from the DAMM v2 pool after graduation', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, isMigrated: 1 });
    mockFetchDammV2.mockResolvedValue({
      price: 0.004,
      quoteReserve: 50,
      baseReserve: 12500,
    });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(false);
    expect(s.graduated).toBe(true);
    expect(s.progress).toBe(100);
    expect(s.hasSwap).toBe(true);
    // DAMM v2 values replace the frozen DBC curve values.
    expect(s.price).toBeCloseTo(0.004, 9);
    expect(s.quoteReserve).toBeCloseTo(50, 9);
    expect(s.baseReserve).toBeCloseTo(12500, 6);
    expect(s.marketCap).toBeCloseTo(0.004 * 1_000_000_000, 3);
    // Config and fee fields still come from the DBC read.
    expect(s.migrationQuoteThreshold).toBeCloseTo(800, 6);
    expect(s.creatorBaseFeeRaw).toBe('123456789');
    expect(mockFetchDammV2).toHaveBeenCalledWith(
      expect.anything(),
      t.poolAddress,
      t.baseMint,
      t.quoteMint
    );
  });

  it('HONESTY: graduated pool with an unreachable DAMM v2 pool serves stale, never frozen DBC leftovers', async () => {
    const t = tracked();
    setupChain(t, { price: 0.001, isMigrated: 1 });
    mockFetchDammV2.mockResolvedValue({
      price: null,
      quoteReserve: null,
      baseReserve: null,
    });
    const s = await fetchPoolLiveState(t);
    expect(s.stale).toBe(true);
    expect(s.graduated).toBe(true);
    expect(s.price).toBeNull();
    expect(s.quoteReserve).toBeNull();
  });
});
