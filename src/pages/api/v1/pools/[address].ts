import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { getTradeStats24h } from '@/lib/db/ticks';
import { isSampleStale } from '@/lib/db/config';
import { getQuoteUsdPrice, isUsdReferencePrice } from '@/lib/quote-prices';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/v1/pools/[address]
 *
 * Public single pool state for terminals and bots: the indexed view of
 * one pool (price, reserves, market cap, graduation progress, accrued
 * creator fees) with open CORS and a short edge cache. Served from the
 * indexer's persisted samples, zero live RPC per request. `stale` is
 * true when the latest sample is old; values are then the last real
 * ones, never invented.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const state = await getPoolState(tracked.poolAddress);
  const stale = !state || isSampleStale(state.sampledAt, Date.now());
  const quoteUsd = await getQuoteUsdPrice(tracked.quoteMint);
  const price = state?.price ?? null;
  const marketCap = state?.marketCap ?? null;

  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    baseMint: tracked.baseMint,
    baseSymbol: tracked.baseSymbol,
    baseName: tracked.baseName,
    quoteMint: tracked.quoteMint,
    quoteSymbol: tracked.quoteSymbol,
    imageUrl: tracked.imageUrl ?? null,
    creator: tracked.creator,
    createdAt: tracked.createdAt,
    verified: tracked.verified === true,
    price,
    priceUsd: price !== null && quoteUsd !== null ? price * quoteUsd : null,
    quoteReserve: state?.quoteReserve ?? null,
    baseReserve: state?.baseReserve ?? null,
    progress: state?.progress ?? null,
    graduated: state?.graduated ?? false,
    marketCap,
    marketCapUsd: marketCap !== null && quoteUsd !== null ? marketCap * quoteUsd : null,
    usdReference: isUsdReferencePrice(),
    tradeStats24h: await getTradeStats24h(tracked.poolAddress),
    creatorBaseFeeRaw: state?.creatorBaseFeeRaw ?? null,
    creatorQuoteFeeRaw: state?.creatorQuoteFeeRaw ?? null,
    sampledAt: state?.sampledAt ?? null,
    stale,
  });
}
