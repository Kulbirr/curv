import type { NextApiRequest, NextApiResponse } from 'next';
import { STRATEGIES_ADMIN_HEADER, isAdminAuthorized } from '../strategies';

/**
 * Fail closed admin guard for the strategies pipeline routes. When
 * STRATEGIES_ADMIN_SECRET is not configured, every request is rejected.
 * Returns true when the caller is authorized.
 */
export function requireAdmin(req: NextApiRequest, res: NextApiResponse): boolean {
  const secret = process.env.STRATEGIES_ADMIN_SECRET;
  const header = req.headers[STRATEGIES_ADMIN_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!isAdminAuthorized(presented, secret)) {
    res.status(401).json({ error: 'Not authorized' });
    return false;
  }
  return true;
}
