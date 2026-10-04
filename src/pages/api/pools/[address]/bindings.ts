import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getTrackedPool } from '@/lib/pool-registry';
import {
  checkBindingEligibility,
  getFeeSplitBindings,
  getFeeSplits,
  insertFeeSplitBinding,
} from '@/lib/db/fee-splits';
import { insertNotification } from '@/lib/db/notifications';
import {
  buildRecipientBindingMessage,
  isFreshTimestamp,
} from '@/lib/signature-messages';
import { verifyWalletSignature } from '@/lib/signatures';
import { parseAddress } from '@/lib/api-validation';

/**
 * /api/pools/[address]/bindings
 *
 * GET: the public wallet bindings for a pool's fee split entries.
 *
 * POST: bind a wallet to one split entry through the recipient
 * onboarding link. The wallet being bound signs a domain-separated
 * message, so the signature itself proves control of the destination:
 * nobody can bind someone else's entry to their own wallet. One
 * binding per entry, first valid signature wins, immutable once set.
 * A wallet cannot serve two entries in the same pool. Entries that
 * were registered with a wallet can only be bound by that same wallet.
 * Handle-only entries are claimed by whoever holds the invite link:
 * the link itself is the claim ticket, shared privately by the creator.
 * Curv never holds funds; the binding only tells the claim builder
 * where to pay an entry's share.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const address = parseAddress(req.query.address);
  if (!address)
    return res
      .status(400)
      .json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  if (req.method === 'GET') {
    const bindings = await getFeeSplitBindings(tracked.poolAddress);
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=30, stale-while-revalidate=120'
    );
    return res.status(200).json({ poolAddress: tracked.poolAddress, bindings });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { entryIndex, wallet, timestamp, signature } = req.body ?? {};
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    return res
      .status(400)
      .json({ error: 'entryIndex must be a non negative integer' });
  }
  let normalizedWallet: string;
  try {
    normalizedWallet = new PublicKey(String(wallet ?? '')).toBase58();
  } catch {
    return res
      .status(400)
      .json({ error: 'wallet is not a valid Solana address' });
  }
  if (!isFreshTimestamp(Number(timestamp))) {
    return res
      .status(400)
      .json({ error: 'Signature expired, please sign again' });
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return res.status(400).json({ error: 'signature is required' });
  }

  const recipients = await getFeeSplits(tracked.poolAddress);
  const bindings = await getFeeSplitBindings(tracked.poolAddress);
  try {
    checkBindingEligibility(
      recipients,
      bindings,
      entryIndex,
      normalizedWallet,
      tracked.creator
    );
  } catch (e) {
    return res
      .status(409)
      .json({ error: e instanceof Error ? e.message : 'Binding not allowed' });
  }

  const entry = recipients[entryIndex];

  const message = buildRecipientBindingMessage(
    tracked.poolAddress,
    entryIndex,
    normalizedWallet,
    Number(timestamp)
  );
  const ok = verifyWalletSignature(message, signature, normalizedWallet);
  if (!ok) {
    return res
      .status(401)
      .json({ error: 'Signature does not match the wallet' });
  }

  const inserted = await insertFeeSplitBinding(
    tracked.poolAddress,
    entryIndex,
    normalizedWallet
  );
  if (!inserted) {
    return res
      .status(409)
      .json({ error: 'This split entry already has a bound wallet' });
  }
  // Tell the creator: someone bound, their share is now payable on the
  // next claim.
  const sharePct = entry ? (entry.bps / 100).toFixed(2) : '';
  const who = entry?.handle ? `@${entry.handle}` : normalizedWallet.slice(0, 6) + '…';
  await insertNotification({
    id: `split-bound-${tracked.poolAddress}-${entryIndex}-${normalizedWallet}`,
    wallet: tracked.creator,
    type: 'split_bound',
    title: `${who} bound their wallet`,
    body: `${sharePct}% of this pool's creator fees will now be paid to them on your next claim.`,
    link: `/fees/${tracked.poolAddress}`,
  });
  return res.status(200).json({
    ok: true,
    poolAddress: tracked.poolAddress,
    entryIndex,
    wallet: normalizedWallet,
  });
}
