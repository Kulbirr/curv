import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { verifyWalletSignature } from '@/lib/signatures';
import {
  buildBountyActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import { countEntries, getBounty, setBountyStatus } from '@/lib/db/bounties';

/**
 * POST /api/bounties/[id]/cancel
 *
 * Creator cancels an active round. Allowed only before any entries
 * exist, or any time before starts_at. Nothing was escrowed (the
 * budget is a cap on the vault balance), so no funds move.
 *
 * Body: { wallet, timestamp, signature }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid bounty id' });
  }
  const bounty = await getBounty(id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });

  const tracked = await getTrackedPool(bounty.poolAddress);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const b = req.body ?? {};
  const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
  const timestamp = Number(b.timestamp);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (wallet.toLowerCase() !== tracked.creator.toLowerCase()) {
    return res.status(403).json({ error: 'Only the pool creator can cancel' });
  }
  if (!isFreshTimestamp(timestamp)) {
    return res.status(400).json({ error: 'Signature expired, sign again' });
  }
  const message = buildBountyActionMessage(tracked.poolAddress, 'cancel', id, timestamp);
  if (!verifyWalletSignature(message, signature, wallet)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  if (bounty.status !== 'active') {
    return res.status(400).json({ error: `Bounty is ${bounty.status}, cannot cancel` });
  }
  const entries = await countEntries(id);
  if (entries > 0 && Date.now() >= bounty.startsAt) {
    return res.status(400).json({ error: 'Cannot cancel a round that already has entries' });
  }

  await setBountyStatus(id, 'cancelled');
  return res.status(200).json({ cancelled: true });
}
