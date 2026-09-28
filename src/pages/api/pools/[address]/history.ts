import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getHistory, getVolume24h } from '@/lib/price-history';
import { parseAddress } from '@/lib/api-validation';

/** GET-only route; a body here is never legitimate. */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * GET /api/pools/[address]/history?from=&to=&points=
 * Bucketed real price samples for the live chart. `complete: false` means
 * the indexer was not running for the whole window — the chart should
 * render the gap honestly instead of interpolating.
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

  const now = Date.now();
  const to = Number(req.query.to) || now;
  const from = Number(req.query.from) || now - 24 * 3600 * 1000;
  const points = Math.min(1000, Math.max(10, Number(req.query.points) || 300));

  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 30 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'Invalid time window' });
  }

  const history = getHistory(tracked.poolAddress, from, to, points);
  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    from,
    to,
    ...history,
    volume24h: getVolume24h(tracked.poolAddress),
  });
}
