import type { NextApiRequest, NextApiResponse } from 'next';
import { getTrackedPool } from '@/lib/pool-registry';
import { getDuel, getForfeitPayouts, getForfeitTotals } from '@/lib/db/duels';
import { getPoolState } from '@/lib/db/states';
import { query } from '@/lib/db/index';

/**
 * GET /api/duels/[id]
 *
 * Full duel detail for the fight night page: the duel, both pools'
 * live progress, creator-buy transparency stats, forfeit ledger, and
 * the locked terms. Facts only; anything unknowable is null.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_TTL_MS = 120_000;

/** Share of a pool's buy volume (quote raw) from the creator wallet, 0-100. */
async function creatorBuysShare(poolAddress: string, creator: string): Promise<number | null> {
  try {
    const rows = await query<{ total: string | null; creator: string | null }>(
      `SELECT SUM(CASE WHEN side = 'buy' THEN quote_amount_raw::numeric ELSE 0 END) AS total,
              SUM(CASE WHEN side = 'buy' AND wallet = $2 THEN quote_amount_raw::numeric ELSE 0 END) AS creator
       FROM trades WHERE pool_address = $1`,
      [poolAddress, creator],
    );
    const total = rows[0]?.total ? Number(rows[0].total) : 0;
    if (total <= 0) return 0;
    const c = rows[0]?.creator ? Number(rows[0].creator) : 0;
    return Math.min(100, Math.max(0, (c / total) * 100));
  } catch {
    return null;
  }
}

async function poolCard(poolAddress: string) {
  const tracked = await getTrackedPool(poolAddress);
  if (!tracked) return null;
  const state = await getPoolState(poolAddress);
  const share = await creatorBuysShare(poolAddress, tracked.creator);
  const threshold = state?.migrationQuoteThreshold ?? null;
  const reserve = state?.quoteReserve ?? null;
  const toGo = threshold != null && reserve != null ? Math.max(0, threshold - reserve) : null;
  return {
    poolAddress,
    symbol: tracked.baseSymbol,
    name: tracked.baseName,
    imageUrl: tracked.imageUrl ?? null,
    creator: tracked.creator,
    quoteSymbol: tracked.quoteSymbol,
    progress: state?.progress ?? null,
    graduated: state?.graduated ?? false,
    graduatedAt: state?.graduatedAt ?? null,
    quoteToGraduate: toGo,
    creatorBuysShare: share,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid duel id' });
  }

  const cacheKey = `duel:${id}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.status(200).json(hit.body);
  }

  const duel = await getDuel(id);
  if (!duel) return res.status(404).json({ error: 'Duel not found' });

  const [poolA, poolB, payouts, totals] = await Promise.all([
    poolCard(duel.poolA),
    poolCard(duel.poolB),
    getForfeitPayouts(duel.id),
    getForfeitTotals(duel.id),
  ]);

  const body = {
    duel,
    poolA,
    poolB,
    forfeitPayouts: payouts,
    forfeitTotals: totals,
    terms: {
      prize: 'The loser\u2019s creator fee remainder',
      forfeitDays: duel.forfeitDays,
      winnerRule: 'First coin to graduate wins',
      drawRule: 'Both graduating within 60 seconds is a draw',
      expiryDays: 30,
      recipientProtection: 'Fee splits promised to others are always paid in full',
      honestNote:
        'The forfeit lands when the loser claims. If the loser never claims during the window, the winner receives nothing.',
    },
  };
  cache.set(cacheKey, { at: Date.now(), body });
  return res.status(200).json(body);
}
