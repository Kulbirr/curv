import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import {
  checkBindingEligibility,
  getFeeSplitBindings,
  getFeeSplits,
  insertFeeSplitBinding,
} from '@/lib/db/fee-splits';
import { insertNotification } from '@/lib/db/notifications';
import { parseAddress } from '@/lib/api-validation';
import { tweetCodeFor, verifyTweetForEntry } from '@/lib/tweet-verify';

/**
 * POST /api/pools/[address]/verify-tweet
 *
 * Handle-only fee split entries (no attested wallet) are claimed by
 * proving X handle ownership: the recipient posts a public tweet from
 * the named handle containing their entry's verification code AND the
 * Solana wallet that should receive their share, then submits the
 * tweet URL. The server checks authorship, the code, and the wallet
 * through X's free embed infrastructure (no API key, no credits),
 * then records the binding: first valid verification wins, immutable
 * once set.
 *
 * No wallet signature is required. X authorship is the
 * authentication: only the handle owner can author the tweet, so a
 * copied link cannot redirect the payout, it names the owner's
 * wallet. The wallet is read from the tweet text itself.
 *
 * Body: { entryIndex, tweetUrl }
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const { entryIndex, tweetUrl } = req.body ?? {};
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    return res.status(400).json({ error: 'entryIndex must be a non negative integer' });
  }
  if (typeof tweetUrl !== 'string' || tweetUrl.length === 0) {
    return res.status(400).json({ error: 'tweetUrl is required' });
  }

  const recipients = await getFeeSplits(tracked.poolAddress);
  const entry = recipients[entryIndex];
  if (!entry?.handle) {
    return res.status(400).json({ error: 'This entry does not need tweet verification' });
  }
  if (entry.wallet) {
    return res
      .status(400)
      .json({ error: 'This entry is locked to its registered wallet, bind through the invite link instead' });
  }

  // Verify the tweet before touching any binding state. The wallet
  // comes from the tweet text itself: only the handle owner could
  // have authored it, so no wallet signature is needed.
  const code = tweetCodeFor(tracked.poolAddress, entryIndex);
  const check = await verifyTweetForEntry(tweetUrl, entry.handle, code);
  if (!check.ok || !check.wallet) {
    return res.status(422).json({ error: check.reason || 'Tweet verification failed' });
  }
  const normalizedWallet = check.wallet;

  const bindings = await getFeeSplitBindings(tracked.poolAddress);
  try {
    checkBindingEligibility(recipients, bindings, entryIndex, normalizedWallet, tracked.creator);
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : 'Binding not allowed' });
  }

  const inserted = await insertFeeSplitBinding(tracked.poolAddress, entryIndex, normalizedWallet, {
    xUserId: '',
    xHandle: check.tweet?.authorHandle ?? entry.handle,
  });
  if (!inserted) {
    return res.status(409).json({ error: 'This split entry already has a bound wallet' });
  }

  const sharePct = (entry.bps / 100).toFixed(2);
  await insertNotification({
    id: `split-bound-${tracked.poolAddress}-${entryIndex}-${normalizedWallet}`,
    wallet: tracked.creator,
    type: 'split_bound',
    title: `@${check.tweet?.authorHandle ?? entry.handle} bound their wallet`,
    body: `${sharePct}% of this pool's creator fees will now be paid to them on your next claim.`,
    link: `/fees/${tracked.poolAddress}`,
  });
  return res.status(200).json({
    ok: true,
    poolAddress: tracked.poolAddress,
    entryIndex,
    wallet: normalizedWallet,
    handle: check.tweet?.authorHandle ?? entry.handle,
  });
}
