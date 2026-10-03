import type { NextApiRequest, NextApiResponse } from 'next';
import {
  buildAuthorizeUrl,
  codeChallenge,
  newCodeVerifier,
  newState,
  xConfigured,
} from '@/lib/x-oauth';

/**
 * GET /api/auth/x/login
 * Starts Login with X: stores the PKCE verifier and state in short
 * lived httpOnly cookies, then redirects to X. Fails closed when the
 * X app is not configured.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!xConfigured()) {
    return res.status(503).json({ error: 'X login is not configured yet' });
  }
  const state = newState();
  const verifier = newCodeVerifier();
  const challenge = codeChallenge(verifier);
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
  res.setHeader('Set-Cookie', [
    `x_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    `x_oauth_verifier=${verifier}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    `x_oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
  ]);
  res.redirect(302, buildAuthorizeUrl(state, challenge));
}
