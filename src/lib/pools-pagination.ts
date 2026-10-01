/**
 * Pagination for GET /api/pools.
 *
 * The list endpoint serves the full registry; at thousands of pools that
 * body is megabytes (3.1 MB at 5k pools in load tests) and the Discover
 * page polls it every 5s. These helpers add opt-in cursor pagination:
 *
 *   GET /api/pools?limit=50&cursor=<poolAddress>&sort=hot
 *
 * With no pagination params the endpoint returns the full list exactly as
 * before (backward compatible for existing consumers such as Portfolio).
 * The cursor is the poolAddress of the last pool on the previous page; the
 * registry order (created_at DESC) is stable, so pages are coherent. A new
 * registration lands at the front and appears on the next refresh.
 */

export const POOLS_DEFAULT_LIMIT = 50;
export const POOLS_MAX_LIMIT = 500;

export type PoolsSort = 'hot' | 'new' | 'graduation';

export interface PoolsPaginationParams {
  limit: number;
  /** poolAddress of the last pool on the previous page; null for page one. */
  cursor: string | null;
  sort: PoolsSort;
}

export interface PoolsPage<T> {
  pools: T[];
  pagination: {
    /** Page size the server applied. */
    limit: number;
    /** Pass as ?cursor= for the next page; null when this is the last page. */
    cursor: string | null;
    hasMore: boolean;
    /** Total pools in the full (sorted) list, before paging. */
    total: number;
  };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const found = value.find((v): v is string => typeof v === 'string');
    return found;
  }
  return undefined;
}

function parseSort(value: string | undefined): PoolsSort {
  return value === 'new' || value === 'graduation' ? value : 'hot';
}

/**
 * Parse ?limit=, ?cursor=, ?sort= from a Next.js query object.
 * Returns null when none of the three params is present: the caller then
 * serves the full unpaginated list (backward compatibility).
 * A present-but-garbage limit falls back to the default; limits are
 * clamped to [1, POOLS_MAX_LIMIT]. Never throws.
 */
export function parsePoolsPagination(query: {
  limit?: unknown;
  cursor?: unknown;
  sort?: unknown;
}): PoolsPaginationParams | null {
  const rawLimit = firstString(query.limit);
  const rawCursor = firstString(query.cursor);
  const rawSort = firstString(query.sort);
  if (rawLimit === undefined && rawCursor === undefined && rawSort === undefined) {
    return null;
  }
  let limit = POOLS_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed)
      ? Math.min(POOLS_MAX_LIMIT, Math.max(1, parsed))
      : POOLS_DEFAULT_LIMIT;
  }
  return { limit, cursor: rawCursor ?? null, sort: parseSort(rawSort) };
}

export interface SortablePool {
  createdAt: number;
  progress: number | null;
  graduated: boolean;
}

/**
 * Order summaries for pagination. `hot` keeps the registry order
 * (created_at DESC, newest first). `new` is the same order made explicit.
 * `graduation` puts the closest-to-graduation active pools first and trails
 * graduated pools at the end, so nothing is hidden and totals stay truthful.
 */
export function sortPoolSummaries<T extends SortablePool>(
  pools: T[],
  sort: PoolsSort,
): T[] {
  switch (sort) {
    case 'new':
      return [...pools].sort((a, b) => b.createdAt - a.createdAt);
    case 'graduation':
      return [...pools].sort((a, b) => {
        if (a.graduated !== b.graduated) return a.graduated ? 1 : -1;
        return (b.progress ?? -1) - (a.progress ?? -1);
      });
    case 'hot':
    default:
      return pools;
  }
}

/**
 * Slice one page out of an ordered pool list. An unknown cursor (pool
 * removed since the previous page) restarts from the beginning rather
 * than serving a confusing empty page. Never throws.
 */
export function paginatePools<T extends { poolAddress: string }>(
  pools: T[],
  params: PoolsPaginationParams,
): PoolsPage<T> {
  let start = 0;
  if (params.cursor) {
    const idx = pools.findIndex((p) => p.poolAddress === params.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = pools.slice(start, start + params.limit);
  const nextCursor =
    start + params.limit < pools.length && page.length > 0
      ? page[page.length - 1].poolAddress
      : null;
  return {
    pools: page,
    pagination: {
      limit: params.limit,
      cursor: nextCursor,
      hasMore: nextCursor !== null,
      total: pools.length,
    },
  };
}
