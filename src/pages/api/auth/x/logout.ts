import type { NextApiRequest, NextApiResponse } from 'next';
import { clearSessionCookie } from '@/lib/x-oauth';

/**
 * POST /api/auth/x/logout — clears the X session cookie.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(200).json({ ok: true });
}
