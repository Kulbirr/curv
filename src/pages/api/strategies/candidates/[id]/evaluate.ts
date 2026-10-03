import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { runGates, type GateResult } from '@/lib/strategies/gates';
import { runJudge } from '@/lib/strategies/judge';
import {
  getCandidate,
  listLiveSignalBaseMints,
  listUniverse,
  recordEvaluation,
  recordGateResults,
  toGateUniverse,
} from '@/lib/db/strategy-pipeline';

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

  let candidate;
  try {
    candidate = await getCandidate(id);
  } catch {
    return res.status(500).json({ error: 'Could not load the candidate' });
  }
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (candidate.status !== 'pending') {
    return res.status(409).json({ error: `Candidate is already ${candidate.status}` });
  }

  let universe;
  let liveBaseMints: string[];
  try {
    universe = await listUniverse();
    liveBaseMints = await listLiveSignalBaseMints(Date.now());
  } catch {
    return res.status(500).json({ error: 'Could not load universe or live signals' });
  }

  const gateInput = {
    baseMint: candidate.baseMint,
    baseSymbol: candidate.baseSymbol,
    quoteMint: candidate.quoteMint,
    quoteSymbol: candidate.quoteSymbol,
    entryLow: candidate.entryLow,
    entryHigh: candidate.entryHigh,
    stopPrice: candidate.stopPrice,
    targets: candidate.targets,
    sizeText: candidate.sizeText,
    thesis: candidate.thesis,
    noKnownUnlock: candidate.noKnownUnlock,
  };

  let evaluation;
  try {
    evaluation = await runGates(gateInput, {
      universe: toGateUniverse(universe),
      liveBaseMints,
    });
  } catch {
    return res.status(502).json({ error: 'Gate evaluation failed' });
  }

  const now = Date.now();

  if (!evaluation.gatesClear) {
    const failed = evaluation.results.filter((r) => r.status === 'fail');
    const updated = await recordEvaluation(
      id,
      {
        ruleResults: evaluation.results,
        aiVerdict: 'rejected',
        aiReasons: failed.map((f) => `Gate rejected: ${f.reason}`),
        aiChecks: [],
        status: 'rejected',
        note: null,
      },
      now,
    );
    return res.status(200).json({ candidate: updated, judgeSkipped: true });
  }

  let judge;
  try {
    judge = await runJudge({
      candidate: gateInput,
      market: evaluation.market,
      gateResults: evaluation.results,
    });
  } catch {
    judge = { status: 'error' as const, reason: 'Judge call threw' };
  }

  if (judge.status === 'unavailable') {
    await recordGateResults(id, evaluation.results);
    const refreshed = await getCandidate(id);
    return res.status(200).json({
      candidate: refreshed,
      judgeUnavailable: true,
      note: 'Judge has no API key, candidate stays pending for a human decision',
    });
  }

  if (judge.status === 'error') {
    const withNote: GateResult[] = [
      ...evaluation.results,
      { name: 'ai judge', status: 'abstain', reason: judge.reason },
    ];
    await recordGateResults(id, withNote);
    const refreshed = await getCandidate(id);
    return res.status(200).json({
      candidate: refreshed,
      judgeError: judge.reason,
      note: 'Judge errored, candidate stays pending for a human decision',
    });
  }

  const updated = await recordEvaluation(
    id,
    {
      ruleResults: evaluation.results,
      aiVerdict: judge.verdict,
      aiReasons: judge.reasons,
      aiChecks: judge.checks,
      status: judge.verdict === 'approved' ? 'approved' : 'rejected',
      note: null,
    },
    now,
  );
  return res.status(200).json({ candidate: updated });
}
