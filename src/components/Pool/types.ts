/** API shapes for the pool detail page. */

export interface TradeStats24h {
  /** Estimated buy-side quote volume (UI units), from positive reserve deltas. */
  buyVolume: number;
  /** Estimated sell-side quote volume (UI units), from negative reserve deltas. */
  sellVolume: number;
  /** Estimated count of buy-side tick moves. */
  buys: number;
  /** Estimated count of sell-side tick moves. */
  sells: number;
}

export interface PoolStateResponse {
  poolAddress: string;
  baseSymbol: string;
  baseName: string;
  /** Base token mint, from the pool registry (no RPC needed). */
  baseMint: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  imageUrl: string | null;
  description: string | null;
  /** Canonical https://x.com/<handle> link, null when the coin has none linked. */
  twitter: string | null;
  creator: string;
  createdAt: number;
  price: number | null;
  priceUsd: number | null;
  quoteReserve: number | null;
  baseReserve: number | null;
  progress: number | null;
  graduated: boolean;
  hasSwap: boolean;
  marketCap: number | null;
  marketCapUsd: number | null;
  migrationQuoteThreshold: number | null;
  /** Estimated 24h buy/sell split from reserve movement; null when history is too thin. */
  tradeStats24h: TradeStats24h | null;
  /**
   * Accrued creator trading fees in raw integer units (decimal strings,
   * never floats). Null when the indexer never sampled them.
   */
  creatorBaseFeeRaw: string | null;
  creatorQuoteFeeRaw: string | null;
  /** Unix ms of the last successful indexer sample; null when never sampled. */
  sampledAt: number | null;
  stale: boolean;
}

export interface HistoryPoint {
  t: number;
  price: number;
}

export interface HistoryResponse {
  poolAddress: string;
  from: number;
  to: number;
  points: HistoryPoint[];
  earliest: number | null;
  complete: boolean;
  volume24h: number | null;
}

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
