import type { NextApiRequest, NextApiResponse } from 'next';
import {
  exchangeCode,
  fetchXMe,
  parseCookies,
  sessionCookie,
  signXSession,
  xConfigured,
} from '@/lib/x-oauth';

/**
 * GET /api/auth/x/callback?code=...&state=...
 * Finishes Login with X: verifies state, exchanges the code with the
 * PKCE verifier, fetches the verified user, and sets the signed
 * session cookie. Then redirects back to where the login started.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!xConfigured()) {
    return res.status(503).json({ error: 'X login is not configured yet' });
  }
  const cookies = parseCookies(req.headers.cookie);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || !code || state !== cookies.x_oauth_state || !cookies.x_oauth_verifier) {
    return res.status(400).json({ error: 'Invalid login session, please try again' });
  }
  const tokens = await exchangeCode(code, cookies.x_oauth_verifier);
  if (!tokens) {
    return res.status(502).json({ error: 'Could not complete X login, please try again' });
  }
  const me = await fetchXMe(tokens.access_token);
  if (!me) {
    return res.status(502).json({ error: 'Could not read your X profile, please try again' });
  }
  const session = signXSession({ xUserId: me.id, xUsername: me.username, issuedAt: Date.now() });
  const next =
    cookies.x_oauth_next && cookies.x_oauth_next.startsWith('/')
      ? decodeURIComponent(cookies.x_oauth_next)
      : '/';
  res.setHeader('Set-Cookie', [
    sessionCookie(session),
    'x_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    'x_oauth_verifier=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    'x_oauth_next=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
  ]);
  res.redirect(302, next);
}
