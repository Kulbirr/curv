import type { NextApiRequest, NextApiResponse } from 'next';
import { getBounty, getLeaderboard, getWinners, countEntries, bountyCodeFor } from '@/lib/db/bounties';

/**
 * GET /api/bounties/[id]
 *
 * Round detail plus the leaderboard (entries ordered by latest
 * engagement score). Public, no auth. Paginate with ?page= (50/page).
 */
export const config = {
  api: { bodyParser: { sizeLimit: '4kb' } },
};

const PAGE_SIZE = 50;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid bounty id' });
  }
  const bounty = await getBounty(id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });

  const page = Math.max(0, Number(req.query.page) || 0);
  const [leaderboard, total, winners] = await Promise.all([
    getLeaderboard(id, PAGE_SIZE, page * PAGE_SIZE),
    countEntries(id),
    bounty.status === 'finalized' ? getWinners(id) : Promise.resolve([]),
  ]);

  return res.status(200).json({
    bounty: {
      id: bounty.id,
      poolAddress: bounty.poolAddress,
      title: bounty.title,
      description: bounty.description,
      hashtag: bounty.hashtag,
      keyword: bounty.keyword,
      prizeBudgetRaw: bounty.prizeBudgetRaw,
      prizeMint: bounty.prizeMint,
      winnerCount: bounty.winnerCount,
      prizeSplits: bounty.prizeSplits,
      weights: bounty.weights,
      startsAt: bounty.startsAt,
      endsAt: bounty.endsAt,
      status: bounty.status,
      createdAt: bounty.createdAt,
      finalizedAt: bounty.finalizedAt,
    },
    leaderboard: leaderboard.map((row) => ({
      entryId: row.entry.id,
      tweetId: row.entry.tweetId,
      handle: row.entry.authorHandleDisplay,
      tweetText: row.entry.tweetText,
      submittedAt: row.entry.submittedAt,
      likes: row.likes,
      retweets: row.retweets,
      replies: row.replies,
      views: row.views,
      score: row.score,
      takenAt: row.takenAt,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    winners: winners.map((w) => ({
      id: w.id,
      rank: w.rank,
      authorHandle: w.authorHandle,
      tweetId: w.tweetId,
      score: w.score,
      prizeRaw: w.prizeRaw,
      prizeMint: w.prizeMint,
      bound: !!w.boundWallet,
      claimed: !!w.claimedAt,
      payoutTx: w.payoutTx,
      claimCode: bountyCodeFor(bounty.id, w.id),
    })),
  });
}
