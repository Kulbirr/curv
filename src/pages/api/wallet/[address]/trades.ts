import type { NextApiRequest, NextApiResponse } from 'next';
import { getTradesForWalletAndPool, getWalletPoolSummaries } from '@/lib/db/trades';
import { getTrackedPool } from '@/lib/pool-registry';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/wallet/[address]/trades
 *
 * A wallet's trade history across all Curv pools. Two shapes:
 *   ?view=summary (default): per-pool aggregates — total bought, total
 *     sold, trade count. The simple profile view: two rows per coin.
 *   ?view=detail&poolAddress=...: individual trades for one pool,
 *     newest first, cursor-paginated. The expandable receipt drawer.
 *
 * Both hit dedicated indexes; paginated with small limits.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });

  const view = req.query.view === 'detail' ? 'detail' : 'summary';

  if (view === 'summary') {
    const summaries = await getWalletPoolSummaries(address);
    // Enrich with token symbols for display.
    const out = [];
    for (const s of summaries) {
      const pool = await getTrackedPool(s.poolAddress);
      out.push({
        poolAddress: s.poolAddress,
        baseSymbol: pool?.baseSymbol ?? null,
        baseMint: pool?.baseMint ?? null,
        quoteSymbol: pool?.quoteSymbol ?? null,
        baseDecimals: s.baseDecimals,
        quoteDecimals: s.quoteDecimals,
        totalBoughtBaseRaw: s.totalBoughtBaseRaw,
        totalBoughtQuoteRaw: s.totalBoughtQuoteRaw,
        totalSoldBaseRaw: s.totalSoldBaseRaw,
        totalSoldQuoteRaw: s.totalSoldQuoteRaw,
        tradeCount: s.tradeCount,
      });
    }
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ wallet: address, summaries: out });
  }

  // Detail view: individual trades for one pool.
  const poolAddress = parseAddress(req.query.poolAddress);
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress is required for the detail view' });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
  const beforeId = req.query.beforeId ? Number(req.query.beforeId) : undefined;
  const trades = await getTradesForWalletAndPool(
    address,
    poolAddress,
    limit,
    Number.isFinite(beforeId) ? beforeId : undefined,
  );
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    wallet: address,
    poolAddress,
    trades: trades.map((t) => ({
      id: t.id,
      side: t.side,
      baseAmountRaw: t.baseAmountRaw,
      quoteAmountRaw: t.quoteAmountRaw,
      price: t.price,
      txSignature: t.txSignature,
      tradedAt: t.tradedAt,
    })),
    nextCursor: trades.length === limit ? trades[trades.length - 1].id : null,
  });
}
