import type { NextApiRequest, NextApiResponse } from 'next';
import {
  engagementScore,
  getBounty,
  recordSnapshot,
  upsertEntry,
} from '@/lib/db/bounties';
import {
  extractTweetId,
  fetchTweetEngagement,
  fetchVerifiedTweet,
} from '@/lib/tweet-verify';
import { tweetHasHashtag } from '@/lib/db/bounties';
import { hitRateLimit } from '@/lib/db/rate-limits';

/**
 * POST /api/bounties/[id]/entries
 *
 * Submit a tweet to a bounty round. No wallet signature needed:
 * X authorship is the authentication, and the payout handle is the
 * server-verified tweet author, so you cannot submit someone else's
 * tweet and get paid.
 *
 * Body: { tweetUrl }
 *
 * Checks: public tweet, contains #hashtag (+ keyword when set),
 * posted after the round started. One entry per handle: a second
 * tweet replaces the first. An immediate engagement snapshot is
 * taken so the entry appears on the leaderboard instantly.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const SUBMIT_IP_LIMIT = 10;
const SUBMIT_IP_WINDOW_MS = 60 * 60_000;

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
  if (bounty.status !== 'active') {
    return res.status(400).json({ error: 'This bounty round is not accepting entries' });
  }
  const now = Date.now();
  if (now < bounty.startsAt) {
    return res.status(400).json({ error: 'This bounty round has not started yet' });
  }
  if (now >= bounty.endsAt) {
    return res.status(400).json({ error: 'This bounty round has ended' });
  }

  const ip = clientIp(req);
  const hit = await hitRateLimit(`bounty-entry:${id}:${ip}`, SUBMIT_IP_LIMIT, SUBMIT_IP_WINDOW_MS, now);
  if (!hit.allowed) {
    return res.status(429).json({ error: 'Too many submissions, try again later' });
  }

  const tweetUrl = typeof req.body?.tweetUrl === 'string' ? req.body.tweetUrl : '';
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return res.status(400).json({ error: 'That does not look like an X post link' });
  }

  const tweet = await fetchVerifiedTweet(tweetId);
  if (!tweet) {
    return res.status(422).json({ error: 'Could not read that post. It must be public and not deleted.' });
  }
  if (!tweetHasHashtag(tweet.text, bounty.hashtag)) {
    return res.status(422).json({ error: `That post does not contain #${bounty.hashtag}` });
  }
  if (bounty.keyword && !tweet.text.toLowerCase().includes(bounty.keyword.toLowerCase())) {
    return res.status(422).json({ error: `That post does not mention "${bounty.keyword}"` });
  }

  const entry = await upsertEntry(id, {
    tweetId,
    authorHandle: tweet.authorHandle,
    authorHandleDisplay: tweet.authorHandle,
    tweetText: tweet.text,
  });

  // Immediate snapshot so the leaderboard shows the entry right away.
  try {
    const eng = await fetchTweetEngagement(tweetId);
    if (eng) {
      await recordSnapshot(entry.id, eng, engagementScore(eng, bounty.weights));
    }
  } catch {
    // Snapshot failures never fail the submission; the keeper retries.
  }

  return res.status(201).json({
    entry: {
      entryId: entry.id,
      handle: entry.authorHandleDisplay,
      submittedAt: entry.submittedAt,
    },
  });
}

function clientIp(req: NextApiRequest): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.split(',')[0].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

