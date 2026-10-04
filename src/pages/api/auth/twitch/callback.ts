import type { NextApiRequest, NextApiResponse } from 'next';
import {
  clearOAuthStateCookie,
  exchangeTwitchCode,
  fetchTwitchMe,
  oauthSessionCookie,
  parseCookies,
  safeEqual,
  signOAuthSession,
  twitchConfigured,
} from '@/lib/twitch-oauth';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/auth/twitch/callback?code=...&state=...
 * Finishes Twitch verification: validates state, exchanges the code,
 * fetches the verified Twitch username, and checks it matches the
 * fee split entry's handle (case-insensitive). On success sets the
 * signed identity cookie and redirects back to the claim page, where
 * the recipient connects a wallet and signs the binding message.
 * On mismatch, redirects back with an error flag; the handle owner
 * check is the whole security of this flow.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!twitchConfigured()) {
    return res.status(503).json({ error: 'Twitch verification is not configured yet' });
  }
  const cookies = parseCookies(req.headers.cookie);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const clearState = [
    clearOAuthStateCookie('twitch_oauth_state'),
    clearOAuthStateCookie('twitch_oauth_pool'),
    clearOAuthStateCookie('twitch_oauth_entry'),
  ];
  const fail = (reason: string, pool?: string, entry?: string) => {
    const back =
      pool && entry !== undefined
        ? `/claim/onboard/${pool}/${entry}?oauth=error&reason=${encodeURIComponent(reason)}`
        : '/';
    res.setHeader('Set-Cookie', clearState);
    res.redirect(302, back);
  };

  const savedState = cookies.twitch_oauth_state ?? '';
  const poolParam = cookies.twitch_oauth_pool ?? '';
  const entryParam = cookies.twitch_oauth_entry ?? '';
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
  if (!r?.handle || r.wallet || platform !== 'twitch') {
    return fail('bad_request', tracked.poolAddress, String(entry));
  }

  const accessToken = await exchangeTwitchCode(code);
  if (!accessToken) {
    return fail('token', tracked.poolAddress, String(entry));
  }
  const me = await fetchTwitchMe(accessToken);
  if (!me) {
    return fail('profile', tracked.poolAddress, String(entry));
  }
  // The author check is the real security: Twitch asserts the login
  // server-side, so an attacker cannot forge it. Case-insensitive:
  // Twitch logins are lowercase canonical.
  if (me.login.toLowerCase() !== r.handle.toLowerCase()) {
    return fail('mismatch', tracked.poolAddress, String(entry));
  }

  const session = signOAuthSession({
    platform: 'twitch',
    username: me.login,
    userId: me.id,
    poolAddress: tracked.poolAddress,
    entryIndex: entry,
    issuedAt: Date.now(),
  });
  res.setHeader('Set-Cookie', [...clearState, oauthSessionCookie(session)]);
  res.redirect(302, `/claim/onboard/${tracked.poolAddress}/${entry}?oauth=twitch`);
}
