import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAddress } from '@/lib/api-validation';
import { getPartnerClaimable } from '@/lib/claim-partner-fees';

/**
 * GET /api/claims/partner/claimable?poolAddress=...
 *
 * Read Curv's currently unclaimed trading fees for a pool (raw units).
 * No auth, no secret — read-only.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const poolAddress =
    typeof req.query.poolAddress === 'string' ? parseAddress(req.query.poolAddress) : null;
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress is not a valid Solana address' });

  try {
    const claimable = await getPartnerClaimable(poolAddress);
    return res.status(200).json({ poolAddress, ...claimable });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
