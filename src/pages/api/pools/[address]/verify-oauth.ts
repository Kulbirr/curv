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
import {
  clearOAuthSessionCookie,
  parseCookies,
  verifyOAuthSession,
} from '@/lib/twitch-oauth';

/**
 * POST /api/pools/[address]/verify-oauth
 *
 * Twitch/Reddit handle-only fee split entries are claimed in two
 * steps. First the recipient proves handle ownership through OAuth
 * (/api/auth/twitch or /api/auth/reddit), which sets a short lived
 * signed identity cookie. Then they connect a wallet and sign the
 * binding message; this endpoint checks the cookie proves the entry's
 * handle (platform and username, case-insensitive) and the signature
 * proves control of the destination wallet, then records the binding.
 *
 * Body: { entryIndex, wallet, timestamp, signature }
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

  // The OAuth identity: signed cookie set by the callback after the
  // platform asserted the username. No cookie, no binding.
  const cookies = parseCookies(req.headers.cookie);
  const identity = verifyOAuthSession(cookies.curv_oauth ?? '');
  if (!identity) {
    return res.status(401).json({ error: 'Verify your social account first, then bind a wallet' });
  }

  const { entryIndex, wallet, timestamp, signature } = req.body ?? {};
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    return res.status(400).json({ error: 'entryIndex must be a non negative integer' });
  }
  let normalizedWallet: string;
  try {
    normalizedWallet = new PublicKey(String(wallet ?? '')).toBase58();
  } catch {
    return res.status(400).json({ error: 'wallet is not a valid Solana address' });
  }
  if (!isFreshTimestamp(Number(timestamp))) {
    return res.status(400).json({ error: 'Signature expired, please sign again' });
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return res.status(400).json({ error: 'signature is required' });
  }

  // The cookie must name this exact pool and entry: a session minted
  // for one entry cannot bind another.
  if (identity.poolAddress !== tracked.poolAddress || identity.entryIndex !== entryIndex) {
    return res.status(403).json({ error: 'This verification is for a different split entry' });
  }

  const recipients = await getFeeSplits(tracked.poolAddress);
  const entry = recipients[entryIndex];
  const platform = entry?.platform ?? 'x';
  if (!entry?.handle || entry.wallet || (platform !== 'twitch' && platform !== 'reddit')) {
    return res.status(400).json({ error: 'This entry does not use social login verification' });
  }
  // Platform and username must match the entry, case-insensitive.
  // This is the handle ownership check: the platform asserted this
  // username in the OAuth flow.
  if (identity.platform !== platform || identity.username.toLowerCase() !== entry.handle.toLowerCase()) {
    return res.status(403).json({ error: 'The verified account does not match this split entry' });
  }

  const bindings = await getFeeSplitBindings(tracked.poolAddress);
  try {
    checkBindingEligibility(recipients, bindings, entryIndex, normalizedWallet, tracked.creator);
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : 'Binding not allowed' });
  }

  const message = buildRecipientBindingMessage(
    tracked.poolAddress,
    entryIndex,
    normalizedWallet,
    Number(timestamp)
  );
  const ok = verifyWalletSignature(message, signature, normalizedWallet);
  if (!ok) {
    return res.status(401).json({ error: 'Signature does not match the wallet' });
  }

  const inserted = await insertFeeSplitBinding(tracked.poolAddress, entryIndex, normalizedWallet, {
    platform,
    handle: identity.username,
  });
  if (!inserted) {
    return res.status(409).json({ error: 'This split entry already has a bound wallet' });
  }

  const sharePct = (entry.bps / 100).toFixed(2);
  const label = platform === 'twitch' ? `twitch.tv/${identity.username}` : `u/${identity.username}`;
  await insertNotification({
    id: `split-bound-${tracked.poolAddress}-${entryIndex}-${normalizedWallet}`,
    wallet: tracked.creator,
    type: 'split_bound',
    title: `${label} bound their wallet`,
    body: `${sharePct}% of this pool's creator fees will now be paid to them on your next claim.`,
    link: `/fees/${tracked.poolAddress}`,
  });
  res.setHeader('Set-Cookie', clearOAuthSessionCookie());
  return res.status(200).json({
    ok: true,
    poolAddress: tracked.poolAddress,
    entryIndex,
    wallet: normalizedWallet,
    platform,
    handle: identity.username,
  });
}
