import type { NextApiRequest, NextApiResponse } from 'next';
import { parseCookies, verifyXSession, xConfigured } from '@/lib/x-oauth';

/**
 * GET /api/auth/x/session
 * Returns the current X login session, or { user: null } when logged
 * out. The client uses this to render login vs. bound states.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies.x_session ? verifyXSession(cookies.x_session) : null;
  return res.status(200).json({
    configured: xConfigured(),
    user: session ? { xUserId: session.xUserId, username: session.xUsername } : null,
  });
}
