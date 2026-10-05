import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { parseAddress } from '@/lib/api-validation';
import { verifyWalletSignature } from '@/lib/signatures';
import {
  buildBountyActionMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import {
  countEntries,
  createBounty,
  getBountyBalance,
  hasActiveBounty,
  listBounties,
  normalizeHashtag,
} from '@/lib/db/bounties';

/**
 * /api/pools/[address]/bounties
 *
 * GET: list bounty rounds for a pool (public), each with entry count
 * and currently funded amount.
 *
 * POST: create a bounty round (pool creator only). The creator signs
 * a domain-separated message; the prize budget is capped by the
 * pool's actual bounty vault balance, so the committed prize can never
 * exceed what the fee flow has funded.
 *
 * Body: { title, description?, hashtag, keyword?, prizeBudgetRaw,
 *   prizeMint, winnerCount, prizeSplits, weights?, startsAt, endsAt,
 *   wallet, timestamp, signature }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const MAX_DURATION_MS = 30 * 24 * 3600_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  if (req.method === 'GET') {
    const rounds = await listBounties(tracked.poolAddress);
    const balance = await getBountyBalance(tracked.poolAddress);
    const out = [];
    for (const b of rounds) {
      out.push({
        ...bountyPublic(b),
        entryCount: await countEntries(b.id),
        fundedRaw: BigInt(b.prizeBudgetRaw) < BigInt(balance) ? b.prizeBudgetRaw : balance,
      });
    }
    return res.status(200).json({ bounties: out, bountyBalanceRaw: balance });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body ?? {};
  const wallet = typeof b.wallet === 'string' ? b.wallet.trim() : '';
  const timestamp = Number(b.timestamp);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (wallet.toLowerCase() !== tracked.creator.toLowerCase()) {
    return res.status(403).json({ error: 'Only the pool creator can create a bounty' });
  }
  if (!isFreshTimestamp(timestamp)) {
    return res.status(400).json({ error: 'Signature expired, sign again' });
  }
  const message = buildBountyActionMessage(tracked.poolAddress, 'create', null, timestamp);
  if (!verifyWalletSignature(message, signature, wallet)) {
    return res.status(401).json({ error: 'Invalid wallet signature' });
  }

  // Validation.
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'title is required' });
  const hashtag = normalizeHashtag(b.hashtag);
  if (!hashtag) return res.status(400).json({ error: 'hashtag must be 2-40 chars of letters, numbers, or underscores' });
  const prizeBudgetRaw = String(b.prizeBudgetRaw ?? '');
  if (!/^[1-9][0-9]*$/.test(prizeBudgetRaw)) {
    return res.status(400).json({ error: 'prizeBudgetRaw must be a positive integer' });
  }
  const balance = BigInt(await getBountyBalance(tracked.poolAddress));
  if (BigInt(prizeBudgetRaw) > balance) {
    return res.status(400).json({ error: 'Prize budget exceeds the funded bounty balance for this pool' });
  }
  const prizeMint = typeof b.prizeMint === 'string' ? b.prizeMint.trim() : tracked.quoteMint;
  const winnerCount = Number(b.winnerCount);
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 10) {
    return res.status(400).json({ error: 'winnerCount must be an integer between 1 and 10' });
  }
  const prizeSplits = b.prizeSplits;
  if (
    !Array.isArray(prizeSplits) ||
    prizeSplits.length !== winnerCount ||
    prizeSplits.some((n: unknown) => !Number.isInteger(n) || (n as number) <= 0) ||
    (prizeSplits as number[]).reduce((s, n) => s + n, 0) !== 10000
  ) {
    return res.status(400).json({ error: 'prizeSplits must be one positive integer per winner, summing to 10000' });
  }
  const weights = {
    likes: clampWeight(b.weights?.likes, 1),
    retweets: clampWeight(b.weights?.retweets, 3),
    replies: clampWeight(b.weights?.replies, 2),
    views: clampWeight(b.weights?.views, 0),
  };
  const startsAt = Number(b.startsAt);
  const endsAt = Number(b.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return res.status(400).json({ error: 'endsAt must be after startsAt' });
  }
  if (endsAt - startsAt > MAX_DURATION_MS) {
    return res.status(400).json({ error: 'Bounty duration is capped at 30 days' });
  }
  if (await hasActiveBounty(tracked.poolAddress)) {
    return res.status(409).json({ error: 'This pool already has an active bounty round' });
  }

  try {
    const bounty = await createBounty({
      poolAddress: tracked.poolAddress,
      creatorWallet: tracked.creator,
      title,
      description: typeof b.description === 'string' ? b.description : undefined,
      hashtag,
      keyword: typeof b.keyword === 'string' ? b.keyword : undefined,
      prizeBudgetRaw,
      prizeMint,
      winnerCount,
      prizeSplits,
      weights,
      startsAt,
      endsAt,
    });
    return res.status(201).json({ bounty: bountyPublic(bounty) });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Could not create bounty' });
  }
}

function clampWeight(v: unknown, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(20, Math.floor(n)));
}

function bountyPublic(b: {
  id: number;
  poolAddress: string;
  title: string;
  description: string | null;
  hashtag: string;
  keyword: string | null;
  prizeBudgetRaw: string;
  prizeMint: string;
  winnerCount: number;
  prizeSplits: number[];
  weights: { likes: number; retweets: number; replies: number; views: number };
  startsAt: number;
  endsAt: number;
  status: string;
  createdAt: number;
  finalizedAt: number | null;
}) {
  return {
    id: b.id,
    poolAddress: b.poolAddress,
    title: b.title,
    description: b.description,
    hashtag: b.hashtag,
    keyword: b.keyword,
    prizeBudgetRaw: b.prizeBudgetRaw,
    prizeMint: b.prizeMint,
    winnerCount: b.winnerCount,
    prizeSplits: b.prizeSplits,
    weights: b.weights,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    status: b.status,
    createdAt: b.createdAt,
    finalizedAt: b.finalizedAt,
  };
}
