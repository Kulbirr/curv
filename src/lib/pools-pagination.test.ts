import { describe, expect, it } from 'vitest';
import {
  POOLS_DEFAULT_LIMIT,
  POOLS_MAX_LIMIT,
  paginatePools,
  parsePoolsPagination,
  sortPoolSummaries,
  type PoolsPaginationParams,
} from './pools-pagination';

function makePools(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    poolAddress: `pool${i}`,
    createdAt: 1000 + i,
    progress: i * 10,
    graduated: false,
  }));
}

describe('parsePoolsPagination', () => {
  it('returns null when no pagination params are given (backward compat)', () => {
    expect(parsePoolsPagination({})).toBeNull();
    expect(parsePoolsPagination({ limit: undefined, cursor: undefined })).toBeNull();
  });

  it('parses limit and cursor', () => {
    expect(parsePoolsPagination({ limit: '25', cursor: 'pool7' })).toEqual({
      limit: 25,
      cursor: 'pool7',
      sort: 'hot',
    });
  });

  it('cursor alone implies paginated mode with the default limit', () => {
    expect(parsePoolsPagination({ cursor: 'pool3' })).toEqual({
      limit: POOLS_DEFAULT_LIMIT,
      cursor: 'pool3',
      sort: 'hot',
    });
  });

  it('clamps limits into [1, POOLS_MAX_LIMIT] and defaults garbage', () => {
    expect(parsePoolsPagination({ limit: '0' })?.limit).toBe(1);
    expect(parsePoolsPagination({ limit: '-5' })?.limit).toBe(1);
    expect(parsePoolsPagination({ limit: '99999' })?.limit).toBe(POOLS_MAX_LIMIT);
    expect(parsePoolsPagination({ limit: 'abc' })?.limit).toBe(POOLS_DEFAULT_LIMIT);
    expect(parsePoolsPagination({ limit: '' })?.limit).toBe(POOLS_DEFAULT_LIMIT);
  });

  it('takes the first value of repeated params and parses sort', () => {
    expect(parsePoolsPagination({ limit: ['10', '20'] })?.limit).toBe(10);
    expect(parsePoolsPagination({ sort: 'graduation' })?.sort).toBe('graduation');
    expect(parsePoolsPagination({ sort: 'new' })?.sort).toBe('new');
    expect(parsePoolsPagination({ sort: 'bogus' })?.sort).toBe('hot');
  });
});

describe('paginatePools', () => {
  const pools = makePools(5);

  it('pages through the full list with cursors', () => {
    const params: PoolsPaginationParams = { limit: 2, cursor: null, sort: 'hot' };
    const p1 = paginatePools(pools, params);
    expect(p1.pools.map((p) => p.poolAddress)).toEqual(['pool0', 'pool1']);
    expect(p1.pagination).toMatchObject({ limit: 2, hasMore: true, total: 5 });
    expect(p1.pagination.cursor).toBe('pool1');

    const p2 = paginatePools(pools, { ...params, cursor: p1.pagination.cursor });
    expect(p2.pools.map((p) => p.poolAddress)).toEqual(['pool2', 'pool3']);
    expect(p2.pagination.hasMore).toBe(true);

    const p3 = paginatePools(pools, { ...params, cursor: p2.pagination.cursor });
    expect(p3.pools.map((p) => p.poolAddress)).toEqual(['pool4']);
    expect(p3.pagination).toMatchObject({ hasMore: false, cursor: null, total: 5 });
  });

  it('returns the whole list when the limit exceeds it', () => {
    const p = paginatePools(pools, { limit: 50, cursor: null, sort: 'hot' });
    expect(p.pools).toHaveLength(5);
    expect(p.pagination).toMatchObject({ hasMore: false, cursor: null, total: 5 });
  });

  it('restarts from the beginning on an unknown cursor', () => {
    const p = paginatePools(pools, { limit: 2, cursor: 'gone', sort: 'hot' as const });
    expect(p.pools.map((p) => p.poolAddress)).toEqual(['pool0', 'pool1']);
  });

  it('handles an empty list', () => {
    const p = paginatePools([], { limit: 10, cursor: null, sort: 'hot' });
    expect(p.pools).toEqual([]);
    expect(p.pagination).toMatchObject({ hasMore: false, cursor: null, total: 0 });
  });
});

describe('sortPoolSummaries', () => {
  it('hot keeps registry order', () => {
    const pools = makePools(3);
    expect(sortPoolSummaries(pools, 'hot')).toBe(pools);
  });

  it('new sorts by createdAt descending', () => {
    const pools = makePools(3).reverse();
    expect(sortPoolSummaries(pools, 'new').map((p) => p.poolAddress)).toEqual([
      'pool2',
      'pool1',
      'pool0',
    ]);
  });

  it('graduation puts closest active first and graduated last', () => {
    const pools = [
      { poolAddress: 'a', createdAt: 1, progress: 10, graduated: false },
      { poolAddress: 'b', createdAt: 2, progress: 90, graduated: false },
      { poolAddress: 'c', createdAt: 3, progress: 100, graduated: true },
      { poolAddress: 'd', createdAt: 4, progress: null, graduated: false },
    ];
    expect(
      sortPoolSummaries(pools, 'graduation').map((p) => p.poolAddress),
    ).toEqual(['b', 'a', 'd', 'c']);
  });
});
