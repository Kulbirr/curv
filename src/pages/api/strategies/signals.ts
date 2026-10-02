import type { NextApiRequest, NextApiResponse } from 'next';
import { parseAddress } from '@/lib/api-validation';
import {
  STRATEGIES_ADMIN_HEADER,
  SUBSCRIPTION_DURATION_MS,
  SUBSCRIPTION_PRICE_LAMPORTS,
  isAdminAuthorized,
  isSubscriptionActive,
  validateSignalInput,
} from '@/lib/strategies';
import {
  getSubscription,
  insertStrategySignal,
  listLiveSignals,
} from '@/lib/db/strategies';

export const config = {
  api: { bodyParser: { sizeLimit: '16kb' } },
};

/**
 * Strategy signal feed.
 *
 * GET /api/strategies/signals?wallet=<address>
 *   Returns live signals (active, not expired, newest first). The feed is
 *   subscriber only: without an active subscription this answers 402 with
 *   the price so the UI can offer the pass. Signals are identical for
 *   every subscriber, so the wallet parameter only gates access.
 *
 * POST /api/strategies/signals
 *   Publish a signal. Operator only: requires the
 *   x-strategies-admin header to match STRATEGIES_ADMIN_SECRET.
 *   Fail closed when the secret is not configured.
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const wallet = parseAddress(req.query.wallet);
  if (!wallet) {
    return res.status(400).json({ error: 'Connect a wallet to view the feed' });
  }
  let sub = null;
  try {
    sub = await getSubscription(wallet);
  } catch {
    return res.status(500).json({ error: 'Could not check the subscription' });
  }
  if (!isSubscriptionActive(sub, Date.now())) {
    return res.status(402).json({
      error: 'This feed needs an active pass',
      pass: {
        priceLamports: SUBSCRIPTION_PRICE_LAMPORTS,
        durationMs: SUBSCRIPTION_DURATION_MS,
      },
    });
  }
  try {
    const signals = await listLiveSignals(Date.now());
    return res.status(200).json({ signals });
  } catch {
    return res.status(500).json({ error: 'Could not load signals' });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.STRATEGIES_ADMIN_SECRET;
  const header = req.headers[STRATEGIES_ADMIN_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!isAdminAuthorized(presented, secret)) {
    return res.status(401).json({ error: 'Not authorized to publish signals' });
  }
  const now = Date.now();
  const validated = validateSignalInput(req.body, now);
  if (validated.ok === false) {
    return res.status(400).json({ error: validated.error });
  }
  try {
    const signal = await insertStrategySignal(validated.input);
    return res.status(201).json({ signal });
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Could not publish the signal',
    });
  }
}
