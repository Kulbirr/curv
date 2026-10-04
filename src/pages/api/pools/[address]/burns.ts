import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getBurns, getBurnStats } from '@/lib/db/buyback';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/pools/[address]/burns
 *
 * The buyback and burn ledger for one pool: every executed burn the
 * keeper has recorded, newest first, plus totals. Powers the burn
 * history on the token page. Burns are immutable once written.
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

  const [burns, stats] = await Promise.all([
    getBurns(tracked.poolAddress),
    getBurnStats(tracked.poolAddress),
  ]);

  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    buybackBps: tracked.buybackBps ?? 0,
    burns,
    stats,
  });
}
