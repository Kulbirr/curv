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
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

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
      const [notifications, unread] = await Promise.all([
        listNotifications(wallet),
        countUnreadNotifications(wallet),
      ]);
      return res.status(200).json({ notifications, unread });
    } catch {
      return res.status(500).json({ error: 'Could not load notifications' });
    }
  }
  if (req.method === 'POST') {
    const wallet = parseWallet(req.body?.wallet);
    if (!wallet) return res.status(400).json({ error: 'wallet is not a valid Solana address' });
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : undefined;
    try {
      await markNotificationsRead(wallet, ids);
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not update notifications' });
    }
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
