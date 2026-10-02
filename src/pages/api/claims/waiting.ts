import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '@/lib/db/pools';
import { getPoolStatesBatch } from '@/lib/db/states';
import { listSplitsForWallet } from '@/lib/db/fee-splits';
import { splitShareRaw } from '@/lib/fee-split-terms';
import { parseAddress } from '@/lib/api-validation';

/**
 * GET /api/claims/waiting?wallet=<address>
 *
 * The claim loop inbox: every pool where this wallet is a fee split
 * recipient, with the share of accrued and unclaimed creator fees
 * currently waiting for them. Amounts derive from the indexer's
 * sampled on chain fee balances times the public split terms, so the
 * page can lag the chain by one sample and says so via sampledAt.
 *
 * Payout happens when the pool's creator claims: the claim
 * transaction distributes every share atomically. Nothing here moves
 * money and Curv never holds the balances.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const wallet = parseAddress(req.query.wallet);
  if (!wallet) return res.status(400).json({ error: 'wallet is not a valid Solana address' });

  const splits = await listSplitsForWallet(wallet);
  if (splits.length === 0) return res.status(200).json({ wallet, waiting: [] });

  const states = await getPoolStatesBatch(splits.map((s) => s.poolAddress));

  const waiting = [];
  for (const { poolAddress, recipient } of splits) {
    const pool = await getPool(poolAddress);
    if (!pool) continue;
    const state = states.get(poolAddress) ?? null;
    const shareBaseRaw = splitShareRaw(state?.creatorBaseFeeRaw, recipient.bps);
    const shareQuoteRaw = splitShareRaw(state?.creatorQuoteFeeRaw, recipient.bps);
    waiting.push({
      poolAddress,
      baseSymbol: pool.baseSymbol,
      baseName: pool.baseName,
      quoteSymbol: pool.quoteSymbol,
      imageUrl: pool.imageUrl ?? null,
      creator: pool.creator,
      bps: recipient.bps,
      shareBaseRaw,
      shareQuoteRaw,
      baseDecimals: state?.baseDecimals ?? 9,
      quoteDecimals: state?.quoteDecimals ?? 9,
      graduated: state?.graduated ?? false,
      sampledAt: state?.sampledAt ?? null,
    });
  }

  return res.status(200).json({ wallet, waiting });
}
