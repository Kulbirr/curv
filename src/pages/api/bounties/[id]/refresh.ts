import type { NextApiRequest, NextApiResponse } from 'next';
import {
  engagementScore,
  getBounty,
  listEntries,
  recordSnapshot,
} from '@/lib/db/bounties';
import { fetchTweetEngagement } from '@/lib/tweet-verify';
import { hitRateLimit } from '@/lib/db/rate-limits';

/**
 * POST /api/bounties/[id]/refresh
 *
 * Manual engagement refresh for a bounty: takes a fresh snapshot for
 * every non-disqualified entry. Rate-limited to 1/hour per bounty for
 * any caller (the keeper runs its own cadence separately).
 */
export const config = {
  api: { bodyParser: { sizeLimit: '4kb' } },
};

const REFRESH_WINDOW_MS = 60 * 60_000;

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
    return res.status(400).json({ error: 'Only active bounties can be refreshed' });
  }

  const now = Date.now();
  const hit = await hitRateLimit(`bounty-refresh:${id}`, 1, REFRESH_WINDOW_MS, now);
  if (!hit.allowed) {
    return res.status(429).json({ error: 'Refresh is rate-limited to once per hour for this bounty' });
  }

  const entries = await listEntries(id);
  let refreshed = 0;
  for (const entry of entries) {
    if (entry.disqualified) continue;
    try {
      const eng = await fetchTweetEngagement(entry.tweetId);
      if (!eng) continue;
      await recordSnapshot(entry.id, eng, engagementScore(eng, bounty.weights));
      refreshed++;
    } catch {
      // One tweet failing never kills the pass.
    }
  }
  return res.status(200).json({ refreshed });
}
