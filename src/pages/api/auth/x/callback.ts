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
  if (me.ok === false) {
    // Do not strand the user on raw JSON. Render a plain error page with
    // a way back. A 403 here specifically means the X developer app's
    // permissions do not include read access, which is fixed in the
    // X developer portal, not in code.
    const detail =
      me.reason === 'http-403'
        ? 'X refused to share your profile. The Curv app needs Read permission in the X developer portal (User authentication settings).'
        : me.reason === 'http-401'
          ? 'The X session expired before we could read your profile.'
          : 'X did not respond in time.';
    res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8').send(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>X login failed</title></head>` +
        `<body style="background:#0a0a0a;color:#e5e5e5;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box">` +
        `<div style="max-width:420px;text-align:center">` +
        `<h1 style="font-size:20px;margin:0 0 12px">X login failed</h1>` +
        `<p style="color:#a3a3a3;font-size:15px;line-height:1.6;margin:0 0 24px">${detail} Please try again.</p>` +
        `<a href="/api/auth/x/login${cookies.x_oauth_next ? `?next=${encodeURIComponent(cookies.x_oauth_next)}` : ''}" style="display:inline-block;background:#22c55e;color:#052e16;font-weight:600;font-size:15px;padding:12px 28px;border-radius:999px;text-decoration:none">Try again</a>` +
        `</div></body></html>`,
    );
    return;
  }
  const session = signXSession({ xUserId: me.user.id, xUsername: me.user.username, issuedAt: Date.now() });
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
