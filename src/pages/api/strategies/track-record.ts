import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackRecord, listResolvedSignals } from '@/lib/db/strategies';

/**
 * Public track record.
 *
 * GET /api/strategies/track-record
 *   No wallet, no subscription: the win rate is public proof, visible to
 *   everyone. Returns the aggregate (wins, losses, expired, winRate) plus
 *   the resolved signal history newest first so the number is verifiable.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const [record, history] = await Promise.all([getTrackRecord(), listResolvedSignals(20)]);
    return res.status(200).json({
      record,
      history: history.map((s) => ({
        id: s.id,
        baseSymbol: s.baseSymbol,
        quoteSymbol: s.quoteSymbol,
        entryPrice: s.entryPrice,
        stopPrice: s.stopPrice,
        targets: s.targets,
        outcome: s.outcome,
        resolvedAt: s.resolvedAt,
        resolvedPrice: s.resolvedPrice,
        createdAt: s.createdAt,
      })),
    });
  } catch {
    return res.status(500).json({ error: 'Could not load the track record' });
  }
}
