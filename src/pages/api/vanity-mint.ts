import type { NextApiRequest, NextApiResponse } from 'next';
import { getClientIp } from '@/lib/api-validation';
import { claimVanityMint } from '@/lib/db/vanity-pool';
import { hitRateLimit } from '@/lib/db/rate-limits';
import { decryptSecret } from '@/lib/vanity-crypto';

/**
 * Instant-launch vanity mint handout.
 *
 * POST /api/vanity-mint claims ONE pre-ground "...curv" mint keypair from
 * the pool that scripts/grind-pool.ts keeps topped up. The claim is
 * atomic (single IMMEDIATE transaction, first-claim-wins), so concurrent
 * launches never receive the same keypair.
 *
 * The returned secretKey is base64. The caller must treat it exactly like
 * the ephemeral mint keypair the launch flow already used: hold it in
 * browser memory, use it to partial-sign the create transaction
 * client-side, and never send it back to any server.
 *
 * Trust model (see docs/vanity-pool.md): the server generated and briefly
 * held this single-use keypair. A mint keypair's power is essentially
 * spent the moment the pool is created (mint/freeze authority are
 * assigned separately), so a compromised pool entry is near-worthless
 * after its one use. Secrets are encrypted at rest (AES-256-GCM) and
 * wiped from the pool row at handout.
 *
 * Rate limit: 5 handouts/hour per IP — a pre-ground keypair costs ~11.3M
 * grind attempts, so the pool must not be drainable by one actor.
 * Empty pool -> 503 with an honest message; the client falls back to its
 * local background grind.
 */

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/** 5 handouts per hour per IP. */
export const VANITY_HANDOUT_LIMIT = 5;
export const VANITY_HANDOUT_WINDOW_MS = 60 * 60_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const hit = hitRateLimit(`vanity:ip:${ip}`, VANITY_HANDOUT_LIMIT, VANITY_HANDOUT_WINDOW_MS, now);
  if (!hit.allowed) {
    return res
      .status(429)
      .json({ error: 'Too many mint handouts from this address, try again later' });
  }

  let claim: { publicKey: string; secretEncrypted: Buffer } | null;
  try {
    claim = claimVanityMint(now);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Handout failed' });
  }
  if (!claim) {
    return res.status(503).json({
      error: 'Vanity mint pool is empty — grinding continues, use the local grind fallback',
    });
  }

  let secret: Buffer;
  try {
    secret = decryptSecret(claim.secretEncrypted);
  } catch (e) {
    // Fail closed: never hand out a keypair we cannot decrypt (wrong key,
    // tampered row). The row is already consumed/wiped, so it can't leak twice.
    return res.status(503).json({
      error: e instanceof Error ? e.message : 'Mint decryption failed',
    });
  }

  return res.status(200).json({
    publicKey: claim.publicKey,
    secretKey: secret.toString('base64'),
  });
}
