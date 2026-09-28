import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import PoolCard from './PoolCard'
import LiveIndicator from '@/components/LiveIndicator'
import { deriveLiveStatus, useNow } from '@/hooks/useLiveStatus'
import { DASH } from '@/lib/format/number'
import type { PoolSummary, PoolsResponse } from './types'

type QuoteFilter = 'all' | 'SOL' | 'USDC' | 'stocks'
type SortMode = 'hot' | 'new' | 'graduation'

const QUOTE_FILTERS: Array<{ id: QuoteFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'SOL', label: 'SOL' },
  { id: 'USDC', label: 'USDC' },
  { id: 'stocks', label: 'Stocks' },
]

const SORT_MODES: Array<{ id: SortMode; label: string }> = [
  { id: 'hot', label: 'Hot' },
  { id: 'new', label: 'New' },
  { id: 'graduation', label: 'Near graduation' },
]

async function fetchPools(): Promise<PoolsResponse> {
  const res = await fetch('/api/pools', { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`Failed to load pools (HTTP ${res.status})`)
  }
  const json = (await res.json()) as PoolsResponse
  if (!json || !Array.isArray(json.pools)) {
    throw new Error('Malformed pools response')
  }
  return json
}

function matchesFilter(pool: PoolSummary, filter: QuoteFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'SOL':
      return pool.quoteSymbol === 'SOL'
    case 'USDC':
      return pool.quoteSymbol === 'USDC'
    case 'stocks':
      return pool.quoteSymbol.endsWith('x')
  }
}

function matchesQuery(pool: PoolSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${pool.baseSymbol} ${pool.baseName} ${pool.quoteSymbol}`
    .toLowerCase()
    .includes(q)
}

function sortPools(pools: PoolSummary[], sort: SortMode): PoolSummary[] {
  switch (sort) {
    case 'hot':
      return pools // API order
    case 'new':
      return [...pools].sort((a, b) => b.createdAt - a.createdAt)
    case 'graduation':
      return [...pools]
        .filter((pool) => !pool.graduated)
        .sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1))
  }
}

function CardSkeleton() {
  return (
    <div className="sc-token-card" aria-hidden="true">
      <div className="animate-pulse">
        <div className="sc-token-card-top">
          <div className="h-[38px] w-[38px] rounded-lg bg-neutral-800" />
          <div className="sc-token-identity">
            <div className="h-3 w-24 rounded bg-neutral-800" />
            <div className="mt-1 h-2.5 w-16 rounded bg-neutral-800" />
          </div>
        </div>
        <div className="sc-token-price-row">
          <div className="h-5 w-28 rounded bg-neutral-800" />
          <div className="h-3 w-14 rounded bg-neutral-800" />
        </div>
        <div className="sc-discover-progress-head">
          <div className="h-2 w-20 rounded bg-neutral-800" />
          <div className="h-2 w-8 rounded bg-neutral-800" />
        </div>
        <div className="sc-progress" />
        <div className="sc-token-card-foot">
          <div className="h-2 w-28 rounded bg-neutral-800" />
        </div>
      </div>
    </div>
  )
}

export default function Discover() {
  const [quoteFilter, setQuoteFilter] = useState<QuoteFilter>('all')
  const [sort, setSort] = useState<SortMode>('hot')
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } =
    useQuery({
      queryKey: ['discover-pools'],
      queryFn: fetchPools,
      refetchInterval: 5000,
      keepPreviousData: true,
    })
  const now = useNow(5000)
  const liveStatus = deriveLiveStatus({
    dataUpdatedAt,
    isFetching,
    isError,
    now,
  })

  const pools = useMemo(() => data?.pools ?? [], [data])
  const graduatedCount = useMemo(
    () => pools.filter((pool) => pool.graduated).length,
    [pools]
  )
  const networkName =
    data?.network === 'mainnet-beta'
      ? 'SOLANA MAINNET'
      : data?.network === 'devnet'
        ? 'SOLANA DEVNET'
        : '···'

  const visiblePools = useMemo(() => {
    const filtered = pools.filter(
      (pool) => matchesFilter(pool, quoteFilter) && matchesQuery(pool, search)
    )
    return sortPools(filtered, sort)
  }, [pools, quoteFilter, search, sort])

  const clearAll = () => {
    setQuoteFilter('all')
    setSort('hot')
    setSearch('')
  }

  return (
    <main className="sc-discover-page">
      {/* Hero */}
      <section className="sc-discover-hero">
        <div className="sc-discover-intro">
          <span className="sc-mainnet-label">
            <i /> MARKET PREVIEW · {networkName}
          </span>
          <h1>
            Launch a token on a curve <em>you design</em>
          </h1>
          <p>
            Bonding curve launches for memecoins and tokenized stock style
            assets. No presale and no team allocation, just fair curves that
            graduate to DEX liquidity.
          </p>
          <div className="sc-discover-ctas">
            <Link
              href="/create-pool"
              className="sc-button sc-button-primary"
            >
              <span aria-hidden="true">↗</span> Launch token
            </Link>
            <Link href="/presets" className="sc-button sc-button-secondary">
              View presets
            </Link>
          </div>
        </div>
        <div
          className="sc-platform-stats"
          style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
        >
          <div>
            <span>Tokens launched</span>
            <strong className="sc-number">
              {isLoading ? DASH : pools.length.toLocaleString('en-US')}
            </strong>
          </div>
          <div>
            <span>Graduated to DEX</span>
            <strong className="sc-number">
              {isLoading ? DASH : graduatedCount.toLocaleString('en-US')}
            </strong>
          </div>
        </div>
      </section>

      {/* Market */}
      <section className="sc-discover-market" aria-label="Discover tokens">
        <div className="sc-market-head">
          <div className="sc-market-title">
            <LiveIndicator status={liveStatus} />
            <span>Live market</span>
            <span className="sc-market-count">
              {isLoading
                ? '…'
                : `${pools.length} token${pools.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <label className="sc-search">
            <span className="sc-search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tokens or tickers"
              aria-label="Search tokens or tickers"
            />
          </label>
        </div>

        <div className="sc-market-tools">
          <div className="sc-filter-group" aria-label="Quote pair filters">
            {QUOTE_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={quoteFilter === filter.id}
                className={quoteFilter === filter.id ? 'selected' : ''}
                onClick={() => setQuoteFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="sc-hot-sort">
            <span>Sort:</span>
            <select
              value={sort}
              aria-label="Sort tokens"
              onChange={(event) =>
                setSort(event.target.value as SortMode)
              }
            >
              {SORT_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isLoading ? (
          <div className="sc-token-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : isError ? (
          <div className="sc-empty-market">
            <span>Could not load pools</span>
            <span>
              The market data could not be reached. Check your connection and
              try again.
            </span>
            <button type="button" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        ) : pools.length === 0 ? (
          <div className="sc-empty-market">
            <span>No tokens launched yet</span>
            <span>Be the first to launch a token on a curve you design.</span>
            <Link href="/create-pool" className="sc-button sc-button-primary">
              Launch a token
            </Link>
          </div>
        ) : visiblePools.length === 0 ? (
          <div className="sc-empty-market">
            <span>No tokens match those filters.</span>
            <button type="button" onClick={clearAll}>
              Clear filters
            </button>
          </div>
        ) : (
          <div className="sc-token-grid">
            {visiblePools.map((pool) => (
              <PoolCard key={pool.poolAddress} pool={pool} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
