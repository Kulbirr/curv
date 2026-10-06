import type { NextApiRequest, NextApiResponse } from 'next';
import { listDuels } from '@/lib/db/duels';

/**
 * GET /api/duels?limit=20
 *
 * Fight card lineup: active duels first, then challenged, then recently
 * settled, then the rest.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_TTL_MS = 120_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(50, rawLimit) : 20;

  const cacheKey = `duels:${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.status(200).json(hit.body);
  }

  const duels = await listDuels(limit);
  const body = { duels };
  cache.set(cacheKey, { at: Date.now(), body });
  return res.status(200).json(body);
}
