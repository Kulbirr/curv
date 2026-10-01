import { describe, expect, it } from 'vitest';
import { matchesQuery } from '../search';
import type { PoolSummary } from '../types';

function pool(overrides: Partial<PoolSummary> = {}): PoolSummary {
  return {
    poolAddress: '79NyTpth6aGUePHRMgckCA7pRotpbAPXwfGexoXv167v',
    baseSymbol: 'TEST',
    baseName: 'Devnet Spike Token',
    baseMint: 'BaseMint111111111111111111111111111111111111',
    quoteMint: 'QuoteMint11111111111111111111111111111111111',
    quoteSymbol: 'TQUOTE',
    imageUrl: null,
    description: null,
    creator: 'Creator1111111111111111111111111111111111111',
    price: 0.001,
    priceUsd: null,
    change24h: null,
    progress: 0,
    graduated: false,
    marketCap: null,
    marketCapUsd: null,
    volume24h: null,
    createdAt: 0,
    stale: false,
    verified: false,
    ...overrides,
  } as PoolSummary;
}

describe('matchesQuery', () => {
  it('matches the ticker case-insensitively', () => {
    expect(matchesQuery(pool(), 'test')).toBe(true);
    expect(matchesQuery(pool(), 'TEST')).toBe(true);
    expect(matchesQuery(pool(), 'tes')).toBe(true);
  });

  it('matches the token name', () => {
    expect(matchesQuery(pool(), 'spike')).toBe(true);
    expect(matchesQuery(pool(), 'Devnet Spike')).toBe(true);
  });

  it('matches the quote asset ticker', () => {
    expect(matchesQuery(pool(), 'tquote')).toBe(true);
  });

  it('matches the pool address, full or partial', () => {
    expect(
      matchesQuery(pool(), '79NyTpth6aGUePHRMgckCA7pRotpbAPXwfGexoXv167v'),
    ).toBe(true);
    expect(matchesQuery(pool(), '79NyTpth')).toBe(true);
  });

  it('treats an empty query as a match', () => {
    expect(matchesQuery(pool(), '')).toBe(true);
    expect(matchesQuery(pool(), '   ')).toBe(true);
  });

  it('rejects unrelated text', () => {
    expect(matchesQuery(pool(), 'nope')).toBe(false);
    expect(matchesQuery(pool(), 'SOL')).toBe(false);
  });
});
