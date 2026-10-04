import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getFeeSplitBindings, getFeeSplits } from '@/lib/db/fee-splits';
import { creatorRemainderBps, resolveEffectiveRecipients, splitShareRaw } from '@/lib/fee-split-terms';
import { fetchPoolLiveState } from '@/lib/pool-state';
import { parseAddress } from '@/lib/api-validation';
import { tweetCodeFor } from '@/lib/tweet-verify';

/**
 * GET /api/pools/[address]/fee-splits
 *
 * The public fee split terms for a pool: who shares the creator
 * trading fee and by how much. Written once at launch, never edited,
 * so anyone can check what was promised before they buy. Each
 * recipient also carries its effective payout wallet (the wallet bound
 * through its onboarding link when set, otherwise the registered
 * wallet), whether it is bound, and its pending share of the currently
 * accrued (unclaimed) fees. An empty list means the creator keeps the
 * whole creator fee.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const recipients = await getFeeSplits(tracked.poolAddress);
  const bindings = await getFeeSplitBindings(tracked.poolAddress);
  const effective = resolveEffectiveRecipients(recipients, bindings);
  // Live accrued (unclaimed) creator fees, so the UI can show real
  // pending amounts per recipient. A failed read degrades to nulls;
  // the terms themselves are still served.
  let accrued: {
    baseRaw: string | null;
    quoteRaw: string | null;
    baseDecimals: number;
    quoteDecimals: number;
  } | null = null;
  try {
    const live = await fetchPoolLiveState(tracked);
    accrued = {
      baseRaw: live.creatorBaseFeeRaw,
      quoteRaw: live.creatorQuoteFeeRaw,
      baseDecimals: live.baseDecimals,
      quoteDecimals: live.quoteDecimals,
    };
  } catch {
    accrued = null;
  }
  const recipientsWithPending = effective.map((r, i) => ({
    ...r,
    pendingBaseRaw: accrued ? splitShareRaw(accrued.baseRaw, r.bps) : null,
    pendingQuoteRaw: accrued ? splitShareRaw(accrued.quoteRaw, r.bps) : null,
    // Verification code for handle-only entries: the recipient posts it
    // in a public tweet to prove handle ownership. Wallet-locked entries
    // do not need it.
    verifyCode: r.handle && !r.wallet ? tweetCodeFor(tracked.poolAddress, i) : null,
  }));
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    poolAddress: tracked.poolAddress,
    baseMint: tracked.baseMint,
    quoteMint: tracked.quoteMint,
    configAddress: tracked.configAddress,
    creator: tracked.creator,
    recipients: recipientsWithPending,
    bindings,
    creatorRemainderBps: creatorRemainderBps(recipients),
    accrued,
  });
}
