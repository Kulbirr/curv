import type { PoolStateResponse } from '@/components/Pool/types';
import { isSampleStale } from './db/config';
import type { TrackedPool } from './db/pools';
import type { PoolStateSample } from './db/states';
import { getTradeStats24h } from './db/ticks';
import { getQuoteUsdPrice, isUsdReferencePrice } from './quote-prices';

/**
 * Assemble the exact JSON shape GET /api/pools/[address]/state returns,
 * from a registry record plus a fresh indexer sample.
 *
 * The indexer's WebSocket push broadcasts this so pushed states are
 * interchangeable with REST responses in the browser's react-query cache.
 * Field mapping mirrors src/pages/api/pools/[address]/state.ts; keep the
 * two in sync when the API shape changes.
 */
export async function buildBroadcastState(
  pool: TrackedPool,
  sample: PoolStateSample,
  atMs: number,
): Promise<PoolStateResponse> {
  const quoteUsd = await getQuoteUsdPrice(pool.quoteMint);
  const price = sample.price;
  const marketCap = sample.marketCap;
  return {
    poolAddress: pool.poolAddress,
    baseSymbol: pool.baseSymbol,
    baseName: pool.baseName,
    baseMint: pool.baseMint,
    quoteSymbol: pool.quoteSymbol,
    baseDecimals: sample.baseDecimals,
    quoteDecimals: sample.quoteDecimals,
    imageUrl: pool.imageUrl ?? null,
    description: pool.description ?? null,
    twitter:
      pool.twitter && pool.twitter.startsWith('https://') ? pool.twitter : null,
    creator: pool.creator,
    createdAt: pool.createdAt,
    price,
    priceUsd: price !== null && quoteUsd !== null ? price * quoteUsd : null,
    quoteReserve: sample.quoteReserve,
    baseReserve: sample.baseReserve,
    progress: sample.progress,
    graduated: sample.graduated,
    hasSwap: sample.hasSwap,
    marketCap,
    marketCapUsd: marketCap !== null && quoteUsd !== null ? marketCap * quoteUsd : null,
    usdReference: isUsdReferencePrice(),
    migrationQuoteThreshold: sample.migrationQuoteThreshold,
    tradeStats24h: await getTradeStats24h(pool.poolAddress),
    creatorBaseFeeRaw: sample.creatorBaseFeeRaw,
    creatorQuoteFeeRaw: sample.creatorQuoteFeeRaw,
    sampledAt: atMs,
    stale: isSampleStale(atMs, Date.now()),
  };
}
