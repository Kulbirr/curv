import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { verifyWalletSignature } from '@/lib/signatures';
import {
  buildBountyActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import {
  finalizeBounty,
  getBounty,
  getBountyBalance,
  getWinners,
} from '@/lib/db/bounties';
import { fetchTweetEngagement } from '@/lib/tweet-verify';
import { insertNotification } from '@/lib/db/notifications';

/**
 * POST /api/bounties/[id]/finalize
 *
 * Close the round and rank entries. Creator-signed (the creator may
 * finalize early), or the keeper runs it once ends_at passes. The
 * snapshot pass, disqualification, ranking, and prize computation all
 * happen in one transaction; the call is idempotent.
 *
 * Body: { wallet, timestamp, signature } — required unless the caller
 * is the keeper (BOUNTY_KEEPER_SECRET bearer, keeper-only).
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

  // Keeper path: shared secret bearer, only at/after ends_at.
  const keeperSecret = process.env.BOUNTY_KEEPER_SECRET?.trim();
  const bearer = String(req.headers['x-keeper-secret'] ?? '').trim();
  const isKeeper = !!keeperSecret && bearer === keeperSecret;
  if (isKeeper && Date.now() < bounty.endsAt) {
    return res.status(400).json({ error: 'Bounty has not ended yet' });
  }

  if (!isKeeper) {
    const b = req.body ?? {};
    const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
    const timestamp = Number(b.timestamp);
    const signature = typeof b.signature === 'string' ? b.signature : '';
    if (wallet.toLowerCase() !== tracked.creator.toLowerCase()) {
      return res.status(403).json({ error: 'Only the pool creator can finalize' });
    }
    if (!isFreshTimestamp(timestamp)) {
      return res.status(400).json({ error: 'Signature expired, sign again' });
    }
    const message = buildBountyActionMessage(tracked.poolAddress, 'finalize', id, timestamp);
    if (!verifyWalletSignature(message, signature, wallet)) {
      return res.status(401).json({ error: 'Invalid wallet signature' });
    }
  }

  if (bounty.status === 'finalized') {
    const winners = await getWinners(id);
    return res.status(200).json({ finalized: true, winners: winners.length });
  }
  if (bounty.status !== 'active') {
    return res.status(400).json({ error: `Bounty is ${bounty.status}, cannot finalize` });
  }

  const balance = await getBountyBalance(tracked.poolAddress);
  const winners = await finalizeBounty(
    bounty,
    async (entry) => fetchTweetEngagement(entry.tweetId),
    balance,
  );

  // Notify winners (handle-based; the claim page picks these up).
  for (const w of winners) {
    try {
      await insertNotification({
        id: `bounty-won-${id}-${w.id}`,
        wallet: w.authorHandle,
        type: 'bounty_won',
        title: `You won #${w.rank} in "${bounty.title}"`,
        body: `Bind a wallet to claim your prize.`,
        link: `/bounties/${id}`,
      });
    } catch {
      // Best effort.
    }
  }

  return res.status(200).json({
    finalized: true,
    winners: winners.map((w) => ({ rank: w.rank, handle: w.authorHandle, prizeRaw: w.prizeRaw })),
  });
}
