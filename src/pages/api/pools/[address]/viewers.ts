import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getClientIp, parseAddress } from '@/lib/api-validation';
import { hitRateLimit } from '@/lib/db/rate-limits';
import { countViewers, heartbeatViewer, isValidSessionId } from '@/lib/db/viewers';

/** POST-only; a GET here is never legitimate. */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * POST /api/pools/[address]/viewers — anonymous presence heartbeat.
 *
 * Body: { sessionId }. Records the heartbeat and returns the current
 * watcher count: { viewers: number }. A session counts while its last
 * heartbeat is within 45s. No wallet or identity is involved.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });

  const sessionId = (req.body as { sessionId?: unknown } | null)?.sessionId;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId is missing or malformed' });
  }

  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  // Generous: a 15s heartbeat is 240/hour; two tabs double it. The abuse
  // cost of a forged heartbeat is one tiny row, pruned within 2 minutes.
  const hit = await hitRateLimit(`viewers:${getClientIp(req)}`, 1200, 3_600_000, Date.now());
  if (!hit.allowed) {
    // Still answer with the count so the UI degrades to a stale number
    // instead of erroring; just don't record this heartbeat.
    const viewers = await countViewers(tracked.poolAddress, Date.now());
    return res.status(200).json({ viewers, rateLimited: true });
  }

  const viewers = await heartbeatViewer(tracked.poolAddress, sessionId, Date.now());
  return res.status(200).json({ viewers });
}
