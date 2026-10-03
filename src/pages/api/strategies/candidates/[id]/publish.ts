import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { publishCandidate, PipelineError } from '@/lib/strategies/pipeline';

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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawExpiry = body.expiresAt;
  const expiresAt =
    typeof rawExpiry === 'number' && Number.isInteger(rawExpiry) ? rawExpiry : undefined;
  const overrideReason = typeof body.overrideReason === 'string' ? body.overrideReason : null;
  try {
    const result = await publishCandidate(id, { overrideReason, expiresAt });
    return res.status(201).json(result);
  } catch (e) {
    if (e instanceof PipelineError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Could not publish the signal' });
  }
}
