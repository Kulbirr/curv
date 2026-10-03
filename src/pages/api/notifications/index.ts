import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import {
  countUnreadNotifications,
  listNotifications,
  markNotificationsRead,
} from '@/lib/db/notifications';

/**
 * /api/notifications?wallet=<address>
 *
 * GET: the wallet's notification inbox, newest first, plus unread count.
 * POST: mark notifications read. Body: { wallet, ids?: string[] };
 * omitting ids marks all read.
 *
 * Database failures degrade to a structured 503 (retryable) rather than a
 * bare 500, so the UI can show a retry state instead of a dead inbox.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/** Retryable 503 for transient database failures. Logged server-side. */
function dbUnavailable(res: NextApiResponse, err: unknown, action: string) {
  console.error(`[api/notifications] database unavailable during ${action}:`, err);
  return res.status(503).json({
    error: 'Notifications are temporarily unavailable. Please try again.',
    retryable: true,
  });
}

/** Run a DB read with one retry after a short pause, for transient blips. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await new Promise((r) => setTimeout(r, 2500));
    return await fn();
  }
}

function parseWallet(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    return new PublicKey(v).toBase58();
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const wallet = parseWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: 'wallet is not a valid Solana address' });
    try {
      const [notifications, unread] = await withRetry(() =>
        Promise.all([listNotifications(wallet), countUnreadNotifications(wallet)]),
      );
      return res.status(200).json({ notifications, unread });
    } catch (err) {
      return dbUnavailable(res, err, 'GET inbox');
    }
  }
  if (req.method === 'POST') {
    const wallet = parseWallet(req.body?.wallet);
    if (!wallet) return res.status(400).json({ error: 'wallet is not a valid Solana address' });
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : undefined;
    try {
      await withRetry(() => markNotificationsRead(wallet, ids));
      return res.status(200).json({ ok: true });
    } catch (err) {
      return dbUnavailable(res, err, 'POST mark-read');
    }
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
