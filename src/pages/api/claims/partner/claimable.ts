import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import { getPartnerClaimable } from '@/lib/claim-partner-fees';
import { getPool } from '@/lib/db/pools';

/**
 * GET /api/claims/partner/claimable?poolAddress=...
 *
 * Read Curv's currently unclaimed trading fees for a pool, with the quote
 * mint's decimals so clients can format human-readable amounts (never raw
 * units in UI). No auth, no secret — read-only.
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
    // Quote decimals for formatting. Best effort: fall back to 9 (SOL).
    let quoteDecimals = 9;
    try {
      const tracked = await getPool(poolAddress);
      if (tracked?.quoteMint) {
        const supply = await getConnection().getTokenSupply(new PublicKey(tracked.quoteMint));
        quoteDecimals = supply.value.decimals;
      }
    } catch {
      // keep fallback
    }
    return res.status(200).json({ poolAddress, ...claimable, quoteDecimals });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
