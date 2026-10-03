import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdmin } from '@/lib/strategies/admin-auth';
import { generateIdeas } from '@/lib/strategies/generator';
import { evaluateCandidate, publishCandidate, PipelineError } from '@/lib/strategies/pipeline';
import {
  insertCandidate,
  listLiveSignalBaseMints,
  listUniverse,
  toGateUniverse,
} from '@/lib/db/strategy-pipeline';

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

/**
 * POST /api/strategies/candidates/generate
 *   Scan the active universe for momentum and create signal candidates.
 *   Operator only.
 *
 * Body: { count?: 1-5, autoPublish?: boolean }
 *
 * Generated ideas are created as pending candidates from the engine.
 * With autoPublish, each idea is evaluated immediately and published
 * when the gates and the judge approve it. Rejected ideas stay in the
 * rejected log; when the judge is unavailable the idea stays pending
 * for a human decision and nothing publishes blind.
 */

const DEFAULT_COUNT = 2;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawCount = body.count;
  const count =
    typeof rawCount === 'number' && Number.isInteger(rawCount)
      ? Math.max(1, Math.min(rawCount, 5))
      : DEFAULT_COUNT;
  const autoPublish = body.autoPublish === true;

  let universe;
  let liveBaseMints: string[];
  try {
    universe = await listUniverse();
    liveBaseMints = await listLiveSignalBaseMints(Date.now());
  } catch {
    return res.status(500).json({ error: 'Could not load universe or live signals' });
  }

  let ideas;
  try {
    ideas = await generateIdeas(toGateUniverse(universe), liveBaseMints, count);
  } catch (e) {
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Idea generation failed',
    });
  }
  if (ideas.length === 0) {
    return res.status(200).json({
      ideas: [],
      note: 'No eligible momentum setups in the universe right now',
    });
  }

  const results: Array<{
    id: string;
    baseSymbol: string;
    status: string;
    publishedSignalId: string | null;
    note: string | null;
  }> = [];
  for (const idea of ideas) {
    let candidate;
    try {
      candidate = await insertCandidate({ ...idea.input, submittedBy: 'engine' });
    } catch (e) {
      results.push({
        id: '',
        baseSymbol: idea.entry.symbol,
        status: 'error',
        publishedSignalId: null,
        note: e instanceof Error ? e.message : 'Could not save the idea',
      });
      continue;
    }
    let status = 'pending';
    let publishedSignalId: string | null = null;
    let note: string | null = null;
    if (autoPublish) {
      try {
        const evaluated = await evaluateCandidate(candidate.id);
        status = evaluated.candidate.status;
        if (evaluated.candidate.status === 'approved') {
          const published = await publishCandidate(candidate.id);
          publishedSignalId = published.signal.id;
          status = 'published';
        } else if (evaluated.judgeUnavailable || evaluated.judgeError) {
          note = 'Judge unavailable, the idea is pending your decision';
        }
      } catch (e) {
        note = e instanceof PipelineError ? e.message : 'Evaluation failed';
      }
    }
    results.push({
      id: candidate.id,
      baseSymbol: candidate.baseSymbol,
      status,
      publishedSignalId,
      note,
    });
  }
  return res.status(201).json({ ideas: results });
}
