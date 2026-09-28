import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { getTradeStats24h } from '@/lib/db/ticks';
import { isSampleStale } from '@/lib/db/config';
import { getQuoteUsdPrice } from '@/lib/quote-prices';
import { parseAddress } from '@/lib/api-validation';

/** GET-only route; a body here is never legitimate. */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * GET /api/pools/[address]/state — indexed on-chain state for one pool.
 *
 * Served from the background indexer's persisted samples: zero live
 * Solana RPC calls per request. State older than STALE_AFTER_MS is
 * returned with stale: true (never "updating…"); the last real values
 * are shown, not blanked or invented. A pool the indexer never
 * successfully sampled returns honest nulls with stale: true.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const state = getPoolState(tracked.poolAddress);
  const stale = !state || isSampleStale(state.sampledAt, Date.now());

  const price = state?.price ?? null;
  const marketCap = state?.marketCap ?? null;
  const quoteUsd = await getQuoteUsdPrice(tracked.quoteMint);

  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    baseSymbol: tracked.baseSymbol,
    baseName: tracked.baseName,
    baseMint: tracked.baseMint,
    quoteMint: tracked.quoteMint,
    quoteSymbol: tracked.quoteSymbol,
    baseDecimals: state?.baseDecimals ?? 9,
    quoteDecimals: state?.quoteDecimals ?? 9,
    imageUrl: tracked.imageUrl ?? null,
    description: tracked.description ?? null,
    creator: tracked.creator,
    createdAt: tracked.createdAt,
    price,
    priceUsd: price !== null && quoteUsd !== null ? price * quoteUsd : null,
    quoteReserve: state?.quoteReserve ?? null,
    baseReserve: state?.baseReserve ?? null,
    progress: state?.progress ?? null,
    graduated: state?.graduated ?? false,
    hasSwap: state?.hasSwap ?? false,
    marketCap,
    marketCapUsd: marketCap !== null && quoteUsd !== null ? marketCap * quoteUsd : null,
    migrationQuoteThreshold: state?.migrationQuoteThreshold ?? null,
    tradeStats24h: getTradeStats24h(tracked.poolAddress),
    /** Accrued creator trading fees in raw integer units (decimal strings). */
    creatorBaseFeeRaw: state?.creatorBaseFeeRaw ?? null,
    creatorQuoteFeeRaw: state?.creatorQuoteFeeRaw ?? null,
    /** Unix ms of the last successful indexer sample; null when never sampled. */
    sampledAt: state?.sampledAt ?? null,
    stale,
  });
}
