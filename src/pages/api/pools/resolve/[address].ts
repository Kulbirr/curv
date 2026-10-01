import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool, getTrackedPoolByMint } from '@/lib/pool-registry';
import { parseAddress } from '@/lib/api-validation';

/** GET-only route; a body here is never legitimate. */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * GET /api/pools/resolve/[address], for the header search box.
 *
 * A pasted address resolves to the token page when it is either a
 * tracked pool address ({ kind: 'pool' }) or a tracked base token mint
 * ({ kind: 'mint' }). Anything else is a 404 with { kind: 'unknown' },
 * so the UI can say so honestly. Zero live Solana RPC per request.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });

  const pool = await getTrackedPool(address);
  if (pool) {
    return res.status(200).json({ kind: 'pool', poolAddress: pool.poolAddress });
  }
  const byMint = await getTrackedPoolByMint(address);
  if (byMint) {
    return res.status(200).json({ kind: 'mint', poolAddress: byMint.poolAddress });
  }
  return res.status(404).json({ kind: 'unknown', address });
}
