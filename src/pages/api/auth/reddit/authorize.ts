import type { NextApiRequest, NextApiResponse } from 'next';
import {
  buildRedditAuthorizeUrl,
  redditConfigured,
} from '@/lib/reddit-oauth';
import {
  newState,
  oauthStateCookie,
} from '@/lib/twitch-oauth';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/auth/reddit/authorize?pool=...&entry=...
 * Starts Reddit verification for a fee split entry. Same pattern as
 * Twitch: state plus target pool/entry in short lived httpOnly
 * cookies, then redirect to Reddit.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!redditConfigured()) {
    return res.status(503).json({ error: 'Reddit verification is not configured yet' });
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
  if (!r?.handle || r.wallet || platform !== 'reddit') {
    return res.status(400).json({ error: 'This entry does not need Reddit verification' });
  }
  const state = newState();
  res.setHeader('Set-Cookie', [
    oauthStateCookie('reddit_oauth_state', state),
    oauthStateCookie('reddit_oauth_pool', tracked.poolAddress),
    oauthStateCookie('reddit_oauth_entry', String(entry)),
  ]);
  res.redirect(302, buildRedditAuthorizeUrl(state));
}
