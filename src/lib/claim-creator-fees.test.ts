import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  aggregateCreatorEarnings,
  buildClaimCreatorFeesTx,
  buildWithdrawCreatorMigrationFeeTx,
  CREATOR_MIGRATION_FEE_WITHDRAWN_BIT,
  formatFeeRaw,
  getCreatorMigrationFeeWithdrawn,
  hasNoAccruedFees,
  shouldShowCreatorEarnings,
  withdrawCreatorMigrationFeeFlow,
  type EarningsEntry,
} from './claim-creator-fees';
import { getPoolState, recordPoolSample } from './db/states';
import { randomAddress, useTempDb } from '@/test-support/db';

vi.mock('./solana', () => ({
  getDbcClient: vi.fn(),
}));

import { getDbcClient } from './solana';

const mockClaim = vi.fn();
const mockedGetDbcClient = vi.mocked(getDbcClient);

describe('shouldShowCreatorEarnings', () => {
  const creator = randomAddress();
  it('shows only for the connected creator wallet', async () => {
    expect(
      shouldShowCreatorEarnings({ connected: true, walletAddress: creator, creator }),
    ).toBe(true);
  });
  it('hides when disconnected', async () => {
    expect(
      shouldShowCreatorEarnings({ connected: false, walletAddress: creator, creator }),
    ).toBe(false);
  });
  it('hides for a non-creator wallet', async () => {
    expect(
      shouldShowCreatorEarnings({
        connected: true,
        walletAddress: randomAddress(),
        creator,
      }),
    ).toBe(false);
  });
  it('hides when the wallet address is null', async () => {
    expect(
      shouldShowCreatorEarnings({ connected: true, walletAddress: null, creator }),
    ).toBe(false);
  });
});

describe('formatFeeRaw', () => {
  it('formats raw units with decimals', async () => {
    expect(formatFeeRaw('1000000', 6)).toBe('1');
    expect(formatFeeRaw('1500000', 6)).toBe('1.5');
    expect(formatFeeRaw('123456789', 9)).toBe('0.123456789');
  });
  it('returns "0" for zero', async () => {
    expect(formatFeeRaw('0', 9)).toBe('0');
  });
  it('returns null for null/undefined/invalid', async () => {
    expect(formatFeeRaw(null, 9)).toBeNull();
    expect(formatFeeRaw(undefined, 9)).toBeNull();
    expect(formatFeeRaw('not-a-number', 9)).toBeNull();
  });
  it('handles u64-max without precision loss', async () => {
    const formatted = formatFeeRaw('18446744073709551615', 9);
    expect(formatted).toBe('18446744073.709551615');
  });
});

describe('hasNoAccruedFees', () => {
  it('is true only when both balances are present and zero', async () => {
    expect(hasNoAccruedFees('0', '0')).toBe(true);
    expect(hasNoAccruedFees('0', '1')).toBe(false);
    expect(hasNoAccruedFees('1', '0')).toBe(false);
    expect(hasNoAccruedFees(null, '0')).toBe(false);
    expect(hasNoAccruedFees('0', null)).toBe(false);
  });
});

function entry(overrides: Partial<EarningsEntry> = {}): EarningsEntry {
  return {
    poolAddress: randomAddress(),
    baseSymbol: 'SEED',
    quoteSymbol: 'SOL',
    baseMint: 'BaseMint11111111111111111111111111111111111',
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseDecimals: 9,
    quoteDecimals: 9,
    creatorBaseFeeRaw: '1000000000',
    creatorQuoteFeeRaw: '2000000000',
    priceUsd: 2,
    ...overrides,
  };
}

describe('aggregateCreatorEarnings', () => {
  it('sums raw amounts per mint with exact BN math', async () => {
    const agg = aggregateCreatorEarnings([
      entry({ creatorBaseFeeRaw: '1000000000', creatorQuoteFeeRaw: null }),
      entry({ creatorBaseFeeRaw: '2000000000', creatorQuoteFeeRaw: null }),
    ]);
    const base = agg.find((a) => a.mint === entry().baseMint)!;
    expect(base.rawTotal).toBe('3000000000');
    expect(base.symbol).toBe('SEED');
  });
  it('keeps base and quote fees as separate token buckets', async () => {
    const agg = aggregateCreatorEarnings([entry()]);
    expect(agg).toHaveLength(2);
    expect(agg.find((a) => a.symbol === 'SEED')!.rawTotal).toBe('1000000000');
    expect(agg.find((a) => a.symbol === 'SOL')!.rawTotal).toBe('2000000000');
  });
  it('skips zero and null balances', async () => {
    const agg = aggregateCreatorEarnings([
      entry({ creatorBaseFeeRaw: '0', creatorQuoteFeeRaw: null, priceUsd: null }),
    ]);
    expect(agg).toHaveLength(0);
  });
  it('sums fiat only from entries with a real indexed price', async () => {
    const agg = aggregateCreatorEarnings([
      entry({ creatorBaseFeeRaw: '1000000000', creatorQuoteFeeRaw: null, priceUsd: 2 }),
      entry({ creatorBaseFeeRaw: '1000000000', creatorQuoteFeeRaw: null, priceUsd: null }),
    ]);
    const base = agg.find((a) => a.symbol === 'SEED')!;
    // 1 token @ $2 from the priced entry; the unpriced entry adds tokens only.
    expect(base.usdTotal).toBe(2);
    expect(base.fiatComplete).toBe(false);
  });
  it('reports null fiat when no entry has a price', async () => {
    const agg = aggregateCreatorEarnings([
      entry({ creatorBaseFeeRaw: '1000000000', creatorQuoteFeeRaw: null, priceUsd: null }),
    ]);
    const base = agg.find((a) => a.symbol === 'SEED')!;
    expect(base.usdTotal).toBeNull();
    expect(base.fiatComplete).toBe(false);
  });
  it('marks fiat complete when every entry is priced', async () => {
    const agg = aggregateCreatorEarnings([
      entry({ creatorBaseFeeRaw: '1000000000', creatorQuoteFeeRaw: null, priceUsd: 2 }),
    ]);
    expect(agg.find((a) => a.symbol === 'SEED')!.fiatComplete).toBe(true);
  });
  it('never invents fiat for quote fees', async () => {
    const agg = aggregateCreatorEarnings([entry({ creatorBaseFeeRaw: null })]);
    const sol = agg.find((a) => a.symbol === 'SOL')!;
    expect(sol.usdTotal).toBeNull();
  });
});

describe('buildClaimCreatorFeesTx', () => {
  beforeEach(() => {
    mockClaim.mockReset();
    mockedGetDbcClient.mockReturnValue({ creator: { claimCreatorTradingFee: mockClaim } } as never);
  });

  it('calls the SDK creator claim with the creator as creator and payer', async () => {
    const fakeTx = { fake: 'tx' };
    mockClaim.mockResolvedValue(fakeTx);
    const pool = randomAddress();
    const creator = randomAddress();
    const tx = await buildClaimCreatorFeesTx({ poolAddress: pool, creator });
    expect(tx).toBe(fakeTx);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    const params = mockClaim.mock.calls[0][0];
    expect((params.creator as PublicKey).toBase58()).toBe(creator);
    expect((params.payer as PublicKey).toBase58()).toBe(creator);
    expect((params.pool as PublicKey).toBase58()).toBe(pool);
    // Caps claim everything accrued: u64 max for both.
    expect((params.maxBaseAmount as BN).toString()).toBe('18446744073709551615');
    expect((params.maxQuoteAmount as BN).toString()).toBe('18446744073709551615');
    expect(params.receiver).toBeUndefined();
  });
});

describe('buildWithdrawCreatorMigrationFeeTx', () => {
  const mockWithdraw = vi.fn();
  beforeEach(() => {
    mockWithdraw.mockReset();
    mockedGetDbcClient.mockReturnValue({
      creator: { creatorWithdrawMigrationFee: mockWithdraw },
    } as never);
  });

  it('calls the SDK creator migration withdrawal with pool and sender', async () => {
    const fakeTx = { fake: 'tx' };
    mockWithdraw.mockResolvedValue(fakeTx);
    const pool = randomAddress();
    const sender = randomAddress();
    const tx = await buildWithdrawCreatorMigrationFeeTx({ poolAddress: pool, sender });
    expect(tx).toBe(fakeTx);
    expect(mockWithdraw).toHaveBeenCalledTimes(1);
    const params = mockWithdraw.mock.calls[0][0];
    expect((params.pool as PublicKey).toBase58()).toBe(pool);
    expect((params.sender as PublicKey).toBase58()).toBe(sender);
  });
});

describe('getCreatorMigrationFeeWithdrawn', () => {
  const mockGetPool = vi.fn();
  beforeEach(() => {
    mockGetPool.mockReset();
    mockedGetDbcClient.mockReturnValue({ state: { getPool: mockGetPool } } as never);
  });

  it('is true when the creator bit is set', async () => {
    mockGetPool.mockResolvedValue({ migrationFeeWithdrawStatus: 0b010 });
    await expect(
      getCreatorMigrationFeeWithdrawn(randomAddress()),
    ).resolves.toBe(true);
  });

  it('is true when both creator and partner bits are set', async () => {
    mockGetPool.mockResolvedValue({ migrationFeeWithdrawStatus: 0b110 });
    await expect(
      getCreatorMigrationFeeWithdrawn(randomAddress()),
    ).resolves.toBe(true);
  });

  it('is false when only the partner bit is set', async () => {
    mockGetPool.mockResolvedValue({ migrationFeeWithdrawStatus: 0b100 });
    await expect(
      getCreatorMigrationFeeWithdrawn(randomAddress()),
    ).resolves.toBe(false);
  });

  it('is false when nothing was withdrawn', async () => {
    mockGetPool.mockResolvedValue({ migrationFeeWithdrawStatus: 0 });
    await expect(
      getCreatorMigrationFeeWithdrawn(randomAddress()),
    ).resolves.toBe(false);
  });

  it('throws when the pool is not found on-chain', async () => {
    mockGetPool.mockResolvedValue(null);
    await expect(getCreatorMigrationFeeWithdrawn(randomAddress())).rejects.toThrow(
      'Pool not found on-chain',
    );
  });

  it('uses bit 1 (0b010) for the creator', () => {
    expect(CREATOR_MIGRATION_FEE_WITHDRAWN_BIT).toBe(0b010);
  });
});

describe('withdrawCreatorMigrationFeeFlow', () => {
  const mockWithdraw = vi.fn();
  const mockGetPool = vi.fn();
  beforeEach(() => {
    mockWithdraw.mockReset();
    mockedGetDbcClient.mockReturnValue({
      creator: { creatorWithdrawMigrationFee: mockWithdraw },
      state: { getPool: mockGetPool },
    } as never);
  });

  it('builds, signs, sends and confirms, returning the signature', async () => {
    const pool = randomAddress();
    const creator = randomAddress();
    const fakeTx = { serialize: () => Buffer.from('tx-bytes') } as never;
    mockWithdraw.mockResolvedValue(fakeTx);
    const statuses = ['signing', 'sending', 'confirming'] as const;
    const seen: string[] = [];
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'bh123' }),
      sendRawTransaction: vi.fn().mockResolvedValue('sig123'),
      getSignatureStatus: vi
        .fn()
        .mockResolvedValue({ value: { confirmationStatus: 'confirmed', err: null } }),
    } as never;
    const signTransaction = vi.fn().mockImplementation(async (tx: never) => tx);

    const sig = await withdrawCreatorMigrationFeeFlow({
      connection,
      signTransaction,
      poolAddress: pool,
      creator,
      onStatus: (s) => seen.push(s),
    });

    expect(sig).toBe('sig123');
    expect(seen).toEqual([...statuses]);
    const params = mockWithdraw.mock.calls[0][0];
    expect((params.pool as PublicKey).toBase58()).toBe(pool);
    expect((params.sender as PublicKey).toBase58()).toBe(creator);
    // The flow sets the creator as fee payer and a fresh blockhash.
    expect((fakeTx as { feePayer: PublicKey }).feePayer.toBase58()).toBe(creator);
    expect((fakeTx as { recentBlockhash: string }).recentBlockhash).toBe('bh123');
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws when the transaction fails on-chain', async () => {
    const fakeTx = { serialize: () => Buffer.from('tx-bytes') } as never;
    mockWithdraw.mockResolvedValue(fakeTx);
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'bh123' }),
      sendRawTransaction: vi.fn().mockResolvedValue('sigBad'),
      getSignatureStatus: vi
        .fn()
        .mockResolvedValue({ value: { confirmationStatus: 'finalized', err: 'err' } }),
    } as never;
    await expect(
      withdrawCreatorMigrationFeeFlow({
        connection,
        signTransaction: async (tx: Transaction) => tx,
        poolAddress: randomAddress(),
        creator: randomAddress(),
        onStatus: () => {},
      }),
    ).rejects.toThrow('Transaction failed on-chain');
  });
});

describe('creator fee persistence (db/states)', () => {  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => { await db.cleanup(); });

  it('round-trips raw fee strings exactly', async () => {
    const addr = randomAddress();
    await recordPoolSample(
      addr,
      {
        price: 1,
        quoteReserve: 1,
        baseReserve: 1,
        progress: 1,
        graduated: false,
        hasSwap: true,
        marketCap: 1,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 1,
        creatorBaseFeeRaw: '18446744073709551615',
        creatorQuoteFeeRaw: '999',
      },
      1000,
    );
    const s = (await getPoolState(addr))!;
    expect(s.creatorBaseFeeRaw).toBe('18446744073709551615');
    expect(s.creatorQuoteFeeRaw).toBe('999');
  });

  it('upserts fees on resample and preserves them on failed samples', async () => {
    const addr = randomAddress();
    await recordPoolSample(
      addr,
      {
        price: 1,
        quoteReserve: 1,
        baseReserve: 1,
        progress: 1,
        graduated: false,
        hasSwap: true,
        marketCap: 1,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 1,
        creatorBaseFeeRaw: '500',
        creatorQuoteFeeRaw: '600',
      },
      1000,
    );
    await recordPoolSample(addr, null, 2000); // failed sample: last good kept
    expect((await getPoolState(addr))!.creatorBaseFeeRaw).toBe('500');
    await recordPoolSample(
      addr,
      {
        price: 2,
        quoteReserve: 2,
        baseReserve: 2,
        progress: 2,
        graduated: false,
        hasSwap: true,
        marketCap: 2,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 2,
        creatorBaseFeeRaw: '700',
        creatorQuoteFeeRaw: '800',
      },
      3000,
    );
    const s = (await getPoolState(addr))!;
    expect(s.creatorBaseFeeRaw).toBe('700');
    expect(s.creatorQuoteFeeRaw).toBe('800');
  });

  it('normalizes missing fee fields to null', async () => {
    const addr = randomAddress();
    await recordPoolSample(
      addr,
      {
        price: 1,
        quoteReserve: 1,
        baseReserve: 1,
        progress: 1,
        graduated: false,
        hasSwap: true,
        marketCap: 1,
        baseDecimals: 9,
        quoteDecimals: 9,
        migrationQuoteThreshold: 1,
      },
      1000,
    );
    const s = (await getPoolState(addr))!;
    expect(s.creatorBaseFeeRaw).toBeNull();
    expect(s.creatorQuoteFeeRaw).toBeNull();
  });
});
