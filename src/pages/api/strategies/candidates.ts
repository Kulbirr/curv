import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { validateCandidateBody } from '@/lib/strategies/candidates';
import type { CandidateInput } from '@/lib/strategies/gates';
import {
  insertCandidate,
  listCandidates,
  type CandidateStatus,
} from '@/lib/db/strategy-pipeline';

export const config = {
  api: { bodyParser: { sizeLimit: '16kb' } },
};

/**
 * Signal candidate intake.
 *
 * GET /api/strategies/candidates?status=pending
 *   List candidates, newest first, optionally filtered by status.
 * POST /api/strategies/candidates
 *   Submit a candidate for evaluation. Operator only.
 *
 * All fail closed behind STRATEGIES_ADMIN_SECRET.
 */

const STATUSES: CandidateStatus[] = ['pending', 'approved', 'rejected', 'published'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAdmin(req, res)) return;
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const raw = req.query.status;
  const status = typeof raw === 'string' ? (STATUSES.find((s) => s === raw) ?? null) : undefined;
  if (typeof raw === 'string' && !status) {
    return res.status(400).json({ error: 'status must be pending, approved, rejected or published' });
  }
  try {
    const candidates = await listCandidates(status);
    return res.status(200).json({ candidates });
  } catch {
    return res.status(500).json({ error: 'Could not load candidates' });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const validated = validateCandidateBody(req.body);
  if (validated.ok === false) {
    return res.status(400).json({ error: validated.error });
  }
  const input: CandidateInput & { quoteMint: string; quoteSymbol: string; submittedBy: string } = {
    ...validated.input,
  };
  try {
    const candidate = await insertCandidate(input);
    return res.status(201).json({ candidate });
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Could not submit the candidate',
    });
  }
}
