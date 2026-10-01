/**
 * Pool summary contract served by GET /api/pools.
 *
 * All numeric money values are denominated in QUOTE tokens unless the field
 * name ends in `Usd`. A null value means unknown, the UI must render a dash,
 * never a fabricated number.
 */
export interface PoolSummary {
  poolAddress: string
  baseSymbol: string
  baseName: string
  /** Base token mint, exact-match key for holdings. */
  baseMint: string
  /** Quote token mint. */
  quoteMint: string
  quoteSymbol: string
  imageUrl: string | null
  description: string | null
  /** Wallet that created the pool. */
  creator: string
  /** Price in quote tokens (e.g. SOL per base token). */
  price: number | null
  /** Price in USD. Preferred for display when present. */
  priceUsd: number | null
  /**
   * 24h price change in PERCENT units (e.g. 31.52 renders as "+31.52%").
   * NOTE: unit assumption, confirm against the /api/pools implementation.
   */
  change24h: number | null
  /** Bonding-curve fill, 0-100. */
  progress: number | null
  graduated: boolean
  /** Market cap in quote tokens. */
  marketCap: number | null
  /** Market cap in USD. Preferred for display when present. */
  marketCapUsd: number | null
  /** 24h volume in quote tokens. */
  volume24h: number | null
  /** Pool creation time (epoch; used for sorting only). */
  createdAt: number
  /** True while the backend is still refreshing this pool's numbers. */
  stale: boolean
  /** True when the pool account was verified as a real DBC pool on-chain. */
  verified: boolean
}

export interface PoolsResponse {
  network: 'devnet' | 'mainnet-beta'
  /** True on devnet: USD figures are a mainnet reference, not real value. */
  usdReference: boolean
  pools: PoolSummary[]
  /**
   * Present only when the request used pagination (?limit=/&cursor=/&sort=).
   * Unpaginated requests keep the historical {network, pools} shape.
   */
  pagination?: PoolsPaginationInfo
}

/** Page metadata attached to paginated GET /api/pools responses. */
export interface PoolsPaginationInfo {
  /** Page size the server applied. */
  limit: number
  /** Pass as ?cursor= for the next page; null when this is the last page. */
  cursor: string | null
  hasMore: boolean
  /** Total pools in the full list, before paging. */
  total: number
  /** Graduated pools in the full list, so hero stats stay truthful while paging. */
  graduatedCount: number
}
