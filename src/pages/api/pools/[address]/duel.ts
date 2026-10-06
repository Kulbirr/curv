import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAddress } from '@/lib/api-validation';
import { getActiveDuelForPool } from '@/lib/db/duels';

/**
 * GET /api/pools/[address]/duel
 *
 * The pool's current live duel (challenged or active), or { duel: null }.
 * Powers the token page DuelCard.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'Invalid pool address' });
  const duel = await getActiveDuelForPool(address);
  return res.status(200).json({ duel });
}
