import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { insertNotification } from '@/lib/db/notifications';
import { parseAddress } from '@/lib/api-validation';

/**
 * POST /api/notifications/emit
 *
 * Report a fee event so the inbox can notify the right wallets.
 * Called server-side after a binding, and by the creator's client
 * after a confirmed claim-and-split. Notifications are idempotent
 * per event id; this endpoint never moves funds.
 *
 * Body: { kind: 'split_bound' | 'split_paid', poolAddress, ... }
 *  - split_bound: { entryIndex, bps, wallet, handle?, xUsername? }
 *    (emitted by the bindings handler itself; clients should not call)
 *  - split_paid: { payouts: [{ wallet, handle?, bps }], signature }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '16kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const kind = req.body?.kind;
  if (kind === 'split_paid') {
    const poolAddress = parseAddress(req.body?.poolAddress);
    const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
    const payouts = Array.isArray(req.body?.payouts) ? req.body.payouts : [];
    if (!poolAddress || !signature || payouts.length === 0) {
      return res.status(400).json({ error: 'poolAddress, signature and payouts are required' });
    }
    for (const p of payouts) {
      let wallet: string;
      try {
        wallet = new PublicKey(String(p?.wallet ?? '')).toBase58();
      } catch {
        continue;
      }
      const pct = typeof p?.bps === 'number' ? (p.bps / 100).toFixed(2) : '';
      const who = typeof p?.handle === 'string' && p.handle ? `@${p.handle}` : 'your wallet';
      await insertNotification({
        id: `split-paid-${poolAddress}-${wallet}-${signature}`,
        wallet,
        type: 'split_paid',
        title: `Your ${pct}% fee share was paid`,
        body: `The creator claimed fees on ${poolAddress.slice(0, 6)}… and your share was sent to ${who}.`,
        link: `/token/${poolAddress}`,
      });
    }
    return res.status(200).json({ ok: true });
  }
  res.status(400).json({ error: 'Unknown notification kind' });
}
