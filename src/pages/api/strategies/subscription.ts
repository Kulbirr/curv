import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAddress } from '@/lib/api-validation';
import { isSubscriptionActive } from '@/lib/strategies';
import { getSubscription } from '@/lib/db/strategies';

/**
 * GET /api/strategies/subscription?wallet=<address>
 * Subscription status for the strategies feed. Public: a wallet address
 * is not sensitive, and the feed content is identical for subscribers.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const wallet = parseAddress(req.query.wallet);
  if (!wallet) {
    return res.status(400).json({ error: 'A wallet address is required' });
  }
  try {
    const sub = await getSubscription(wallet);
    return res.status(200).json({
      active: isSubscriptionActive(sub, Date.now()),
      expiresAt: sub?.expiresAt ?? null,
    });
  } catch {
    return res.status(500).json({ error: 'Could not check the subscription' });
  }
}
