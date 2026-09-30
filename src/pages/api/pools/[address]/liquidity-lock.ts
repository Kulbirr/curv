import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import { platformFeeWallet } from '@/lib/launch';
import { verifyLiquidityLock } from '@/lib/liquidity-lock';

/** GET-only route; a body here is never legitimate. */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * GET /api/pools/[address]/liquidity-lock
 *
 * Verifies the permanent-lock state of a graduated pool's DAMM v2
 * liquidity positions on-chain. The DAMM v2 pool is found by scanning
 * cp-amm Pool accounts for the pool's mint pair (pure PDA derivation is
 * not used: the derivation helper in the installed DBC SDK does not
 * reproduce pool addresses created by the on-chain migration).
 *
 * 404 { graduated: false } when the pool has not graduated.
 * 200 { graduatedPool, positions, allLocked } on success; graduatedPool
 * is null when the DAMM v2 pool could not be found.
 * 502 when the chain lookup itself fails.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address)
    return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const state = await getPoolState(tracked.poolAddress);
  if (!state?.graduated) return res.status(404).json({ graduated: false });

  const cached = cache.get(address);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.status(200).json(cached.body);
  }

  try {
    const result = await verifyLiquidityLock(
      getConnection(),
      tracked.baseMint,
      tracked.quoteMint,
      tracked.creator,
      platformFeeWallet()?.toBase58() ?? null
    );
    const body = result ?? {
      graduatedPool: null,
      positions: [],
      allLocked: false,
    };
    cache.set(address, { at: Date.now(), body });
    return res.status(200).json(body);
  } catch {
    return res.status(502).json({ error: 'Chain lookup failed' });
  }
}
