import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { evaluateCandidate, PipelineError } from '@/lib/strategies/pipeline';

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * POST /api/strategies/candidates/[id]/evaluate
 *   Run the deterministic gates, then the AI judge, and store the
 *   verdict on the candidate. Operator only.
 *
 * Flow: any failing gate rejects the candidate without calling the
 * judge. When the gates clear, the judge decides. When the judge is
 * unavailable (no API key) or errors, the candidate stays pending for
 * a human, with the gate results already stored.
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
  try {
    const result = await evaluateCandidate(id);
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof PipelineError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Evaluation failed' });
  }
}
