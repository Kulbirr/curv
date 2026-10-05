import type { NextApiRequest, NextApiResponse } from 'next';
import {
  bindWinnerWallet,
  bountyCodeFor,
  getBounty,
  getWinnerById,
} from '@/lib/db/bounties';
import { verifyTweetForEntry } from '@/lib/tweet-verify';
import { insertNotification } from '@/lib/db/notifications';

/**
 * POST /api/bounties/[id]/winners/bind
 *
 * A bounty winner proves X handle ownership the same way fee split
 * recipients do: post a public tweet from the winning handle with
 * their winner code AND the Solana wallet that should receive the
 * prize, then submit the tweet URL. The server verifies authorship,
 * the code, and the wallet through X's free embed infrastructure,
 * then records the binding. First valid verification wins, immutable.
 *
 * No wallet signature is required. X authorship is the
 * authentication: only the handle owner can author the tweet, so a
 * copied link cannot redirect the payout.
 *
 * Body: { winnerId, tweetUrl }
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
  if (bounty.status !== 'finalized') {
    return res.status(400).json({ error: 'This bounty is not finalized yet' });
  }

  const { winnerId, tweetUrl } = req.body ?? {};
  if (!Number.isInteger(winnerId) || winnerId <= 0) {
    return res.status(400).json({ error: 'winnerId must be a positive integer' });
  }
  if (typeof tweetUrl !== 'string' || tweetUrl.length === 0) {
    return res.status(400).json({ error: 'tweetUrl is required' });
  }

  const winner = await getWinnerById(winnerId);
  if (!winner || winner.bountyId !== id) {
    return res.status(404).json({ error: 'Winner not found' });
  }
  if (winner.boundWallet) {
    return res.status(409).json({ error: 'This prize already has a bound wallet' });
  }

  const code = bountyCodeFor(id, winnerId);
  const check = await verifyTweetForEntry(tweetUrl, winner.authorHandle, code);
  if (!check.ok || !check.wallet) {
    return res.status(422).json({ error: check.reason || 'Tweet verification failed' });
  }

  const bound = await bindWinnerWallet(winnerId, check.wallet);
  if (!bound) {
    return res.status(409).json({ error: 'This prize already has a bound wallet' });
  }

  await insertNotification({
    id: `bounty-bound-${id}-${winnerId}-${check.wallet}`,
    wallet: bounty.creatorWallet,
    type: 'bounty_bound',
    title: `@${check.tweet?.authorHandle ?? winner.authorHandle} bound their bounty prize`,
    body: `Rank #${winner.rank} in "${bounty.title}" will be paid on the next keeper run.`,
    link: `/bounties/${id}`,
  });

  return res.status(200).json({
    ok: true,
    bountyId: id,
    winnerId,
    wallet: check.wallet,
    handle: check.tweet?.authorHandle ?? winner.authorHandle,
  });
}
