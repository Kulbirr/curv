import type { NextApiRequest, NextApiResponse } from 'next';
import {
  buildTwitchAuthorizeUrl,
  newState,
  oauthStateCookie,
  twitchConfigured,
} from '@/lib/twitch-oauth';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/auth/twitch/authorize?pool=...&entry=...
 * Starts Twitch verification for a fee split entry: stores the OAuth
 * state plus the target pool/entry in short lived httpOnly cookies,
 * then redirects to Twitch. Fails closed when Twitch is not
 * configured or the entry is not a Twitch handle entry.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!twitchConfigured()) {
    return res.status(503).json({ error: 'Twitch verification is not configured yet' });
  }
  const pool = parseAddress(req.query.pool);
  const entry = Number(req.query.entry);
  if (!pool || !Number.isInteger(entry) || entry < 0) {
    return res.status(400).json({ error: 'pool and entry are required' });
  }
  const tracked = await getTrackedPool(pool);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });
  const recipients = await getFeeSplits(tracked.poolAddress);
  const r = recipients[entry];
  const platform = r?.platform ?? 'x';
  if (!r?.handle || r.wallet || platform !== 'twitch') {
    return res.status(400).json({ error: 'This entry does not need Twitch verification' });
  }
  const state = newState();
  res.setHeader('Set-Cookie', [
    oauthStateCookie('twitch_oauth_state', state),
    oauthStateCookie('twitch_oauth_pool', tracked.poolAddress),
    oauthStateCookie('twitch_oauth_entry', String(entry)),
  ]);
  res.redirect(302, buildTwitchAuthorizeUrl(state));
}
