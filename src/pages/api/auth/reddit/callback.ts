import type { NextApiRequest, NextApiResponse } from 'next';
import {
  exchangeRedditCode,
  fetchRedditMe,
  redditConfigured,
} from '@/lib/reddit-oauth';
import {
  clearOAuthStateCookie,
  oauthSessionCookie,
  parseCookies,
  safeEqual,
  signOAuthSession,
} from '@/lib/twitch-oauth';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/auth/reddit/callback?code=...&state=...
 * Finishes Reddit verification: validates state, exchanges the code
 * with HTTP basic auth, fetches the verified Reddit username, and
 * checks it matches the entry's handle (case-insensitive). On
 * success sets the signed identity cookie and redirects back to the
 * claim page for wallet binding.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!redditConfigured()) {
    return res.status(503).json({ error: 'Reddit verification is not configured yet' });
  }
  const cookies = parseCookies(req.headers.cookie);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const clearState = [
    clearOAuthStateCookie('reddit_oauth_state'),
    clearOAuthStateCookie('reddit_oauth_pool'),
    clearOAuthStateCookie('reddit_oauth_entry'),
  ];
  const fail = (reason: string, pool?: string, entry?: string) => {
    const back =
      pool && entry !== undefined
        ? `/claim/onboard/${pool}/${entry}?oauth=error&reason=${encodeURIComponent(reason)}`
        : '/';
    res.setHeader('Set-Cookie', clearState);
    res.redirect(302, back);
  };

  const savedState = cookies.reddit_oauth_state ?? '';
  const poolParam = cookies.reddit_oauth_pool ?? '';
  const entryParam = cookies.reddit_oauth_entry ?? '';
  const pool = parseAddress(poolParam);
  const entry = Number(entryParam);
  if (!state || !code || !safeEqual(state, savedState) || !pool || !Number.isInteger(entry) || entry < 0) {
    return fail('bad_request');
  }
  const tracked = await getTrackedPool(pool);
  if (!tracked) return fail('bad_request');
  const recipients = await getFeeSplits(tracked.poolAddress);
  const r = recipients[entry];
  const platform = r?.platform ?? 'x';
  if (!r?.handle || r.wallet || platform !== 'reddit') {
    return fail('bad_request', tracked.poolAddress, String(entry));
  }

  const accessToken = await exchangeRedditCode(code);
  if (!accessToken) {
    return fail('token', tracked.poolAddress, String(entry));
  }
  const me = await fetchRedditMe(accessToken);
  if (!me) {
    return fail('profile', tracked.poolAddress, String(entry));
  }
  if (me.name.toLowerCase() !== r.handle.toLowerCase()) {
    return fail('mismatch', tracked.poolAddress, String(entry));
  }

  const session = signOAuthSession({
    platform: 'reddit',
    username: me.name,
    userId: me.id,
    poolAddress: tracked.poolAddress,
    entryIndex: entry,
    issuedAt: Date.now(),
  });
  res.setHeader('Set-Cookie', [...clearState, oauthSessionCookie(session)]);
  res.redirect(302, `/claim/onboard/${tracked.poolAddress}/${entry}?oauth=reddit`);
}
