import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { decideWinners, getWinners } from '@/lib/db/trader-rewards';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/pools/[address]/trader-rewards
 *
 * The trader reward rule locked at launch plus the decided winners
 * (once graduated). Winner determination is lazy and idempotent:
 * the first call after graduation computes winners from the trades
 * ledger and stores them; later calls return the stored result.
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
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const reward = tracked.traderReward;
  if (!reward) {
    return res.status(200).json({ poolAddress: tracked.poolAddress, traderReward: null, winners: null });
  }

  // Lazy, idempotent: decides on first call after graduation.
  const winners = (await decideWinners(tracked.poolAddress)) ?? (await getWinners(tracked.poolAddress));

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    traderReward: reward,
    winners,
  });
}
