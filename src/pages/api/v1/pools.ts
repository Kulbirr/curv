import type { NextApiRequest, NextApiResponse } from 'next';
import { buildListBody } from '@/pages/api/pools/index';

/**
 * GET /api/v1/pools
 *
 * The public read API for terminals, bots, and third party tools: the
 * same indexed pool summaries the Discover page renders, under a
 * versioned path with open CORS and a short edge cache. Read only,
 * no key, no wallet. Data can lag the chain by the indexer cadence
 * and is flagged per pool with `stale` when a sample is old.
 *
 * ?limit=N caps the list (default 100, max 500), newest first.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;

  const body = await buildListBody();
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({
    network: body.network,
    usdReference: body.usdReference,
    count: Math.min(limit, body.pools.length),
    pools: body.pools.slice(0, limit),
  });
}
