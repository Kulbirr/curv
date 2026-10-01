import type { PoolSummary } from './types'

/**
 * Discover text search: one box matches a token by its name, its ticker,
 * its quote asset ticker, or its pool address. Case insensitive, substring.
 */
export function matchesQuery(pool: PoolSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    `${pool.baseSymbol} ${pool.baseName} ${pool.quoteSymbol} ${pool.poolAddress}`
      .toLowerCase()
      .includes(q)
  )
}
