import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { KNOWN_MINT_DECIMALS, MAX_SIGNAL_TTL_MS, validateSignalInput } from '@/lib/strategies';
import { insertStrategySignal } from '@/lib/db/strategies';
import { getCandidate, markCandidatePublished } from '@/lib/db/strategy-pipeline';

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * POST /api/strategies/candidates/[id]/publish
 *   Publish an approved candidate as a live signal. Operator only.
 *
 * Only candidates with status approved publish directly. A human can
 * override a pending or rejected candidate by giving overrideReason;
 * overridden signals publish without the AI badge.
 */

const DEFAULT_TTL_MS = 48 * 3600_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = req.query.id;
  if (typeof id !== 'string' || id.length === 0) {
    return res.status(400).json({ error: 'Candidate id is required' });
  }

  let candidate;
  try {
    candidate = await getCandidate(id);
  } catch {
    return res.status(500).json({ error: 'Could not load the candidate' });
  }
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (candidate.status === 'published') {
    return res.status(409).json({ error: 'Candidate is already published' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const overrideReason =
    typeof body.overrideReason === 'string' && body.overrideReason.trim().length > 0
      ? body.overrideReason.trim().slice(0, 280)
      : null;

  let aiApproved = false;
  let aiReasons: string[] | null = null;
  if (candidate.status === 'approved') {
    aiApproved = true;
    aiReasons = candidate.aiReasons;
  } else if (overrideReason) {
    aiApproved = false;
    aiReasons = null;
  } else {
    return res.status(409).json({
      error: `Candidate is ${candidate.status}, publish needs approval or an override reason`,
    });
  }

  const now = Date.now();
  const rawExpiry = body.expiresAt;
  const expiresAt =
    typeof rawExpiry === 'number' && Number.isInteger(rawExpiry) ? rawExpiry : now + DEFAULT_TTL_MS;

  // Reference price is the bottom of the entry zone; the mirror ceiling
  // is the zone top plus the 2 percent no chase buffer from the ruleset.
  const signalBody = {
    baseMint: candidate.baseMint,
    quoteMint: candidate.quoteMint,
    baseSymbol: candidate.baseSymbol,
    quoteSymbol: candidate.quoteSymbol,
    baseDecimals: KNOWN_MINT_DECIMALS[candidate.baseMint],
    quoteDecimals: KNOWN_MINT_DECIMALS[candidate.quoteMint],
    entryPrice: candidate.entryLow,
    maxPrice: candidate.entryHigh * 1.02,
    side: 'buy' as const,
    sizeText: candidate.sizeText,
    note: candidate.thesis.slice(0, 140),
    expiresAt,
  };
  const validated = validateSignalInput(signalBody, now);
  if (validated.ok === false) {
    return res.status(400).json({ error: validated.error });
  }
  if (expiresAt - now > MAX_SIGNAL_TTL_MS) {
    return res.status(400).json({ error: 'expiresAt must be within 7 days' });
  }

  try {
    const signal = await insertStrategySignal({
      ...validated.input,
      aiApproved,
      aiReasons,
    });
    await markCandidatePublished(id, signal.id);
    return res.status(201).json({ signal, overridden: overrideReason !== null });
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Could not publish the signal',
    });
  }
}
