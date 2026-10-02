import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { creatorRemainderBps } from '@/lib/fee-split-terms';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/pools/[address]/fee-splits
 *
 * The public fee split terms for a pool: who shares the creator
 * trading fee and by how much. Written once at launch, never edited,
 * so anyone can check what was promised before they buy. An empty
 * list means the creator keeps the whole creator fee.
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

  const recipients = await getFeeSplits(tracked.poolAddress);
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    baseMint: tracked.baseMint,
    quoteMint: tracked.quoteMint,
    configAddress: tracked.configAddress,
    creator: tracked.creator,
    recipients,
    creatorRemainderBps: creatorRemainderBps(recipients),
  });
}
