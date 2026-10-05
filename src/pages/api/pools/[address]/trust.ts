import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { getTradeStats24h } from '@/lib/db/ticks';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import { platformFeeWallet } from '@/lib/launch';
import { verifyLiquidityLock } from '@/lib/liquidity-lock';
import { getFeeSplits } from '@/lib/db/fee-splits';
import { creatorRemainderBps } from '@/lib/fee-split-terms';
import { NATIVE_SOL_MINT } from '@/components/Pool/types';

/**
 * GET /api/pools/[address]/trust
 *
 * The facts behind the token page's trust panel. Every field is a
 * checkable fact from the registry, the indexer, or a direct chain
 * read: no scores, no labels, no judgement calls. A fact that cannot
 * be established is returned as null and the panel omits the row,
 * it is never estimated or filled in.
 *
 *   verified          registry fields matched the chain at launch
 *   mintAuthority     'none' when the mint can never be reissued
 *   freezeAuthority   'none' when no one can freeze holder accounts
 *   lock              graduated pools only: DAMM v2 positions checked
 *                     on chain, allLocked when every position is
 *                     permanently locked
 *   creatorFees       accrued and unclaimed creator fees (indexer)
 *   activity24h       estimated buys and sells from reserve movement
 */

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

type AuthorityState = 'none' | 'held' | null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const address = parseAddress(req.query.address);
  if (!address) return res.status(400).json({ error: 'address is not a valid Solana address' });
  const tracked = await getTrackedPool(address);
  if (!tracked) return res.status(404).json({ error: 'Pool not registered' });

  const cached = cache.get(address);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.status(200).json(cached.body);
  }

  const state = await getPoolState(tracked.poolAddress);
  const graduated = state?.graduated ?? false;

  let mintAuthority: AuthorityState = null;
  let freezeAuthority: AuthorityState = null;
  try {
    const mint = await getMint(getConnection(), new PublicKey(tracked.baseMint));
    mintAuthority = mint.mintAuthority === null ? 'none' : 'held';
    freezeAuthority = mint.freezeAuthority === null ? 'none' : 'held';
  } catch {
    // RPC failure: the facts stay unknown, the rows stay hidden.
    mintAuthority = null;
    freezeAuthority = null;
  }

  let lock: { allLocked: boolean; positionCount: number } | null = null;
  if (graduated) {
    try {
      const result = await verifyLiquidityLock(
        getConnection(),
        tracked.baseMint,
        tracked.quoteMint,
        tracked.creator,
        platformFeeWallet()?.toBase58() ?? null,
      );
      if (result) {
        lock = { allLocked: result.allLocked, positionCount: result.positions.length };
      }
    } catch {
      lock = null;
    }
  }

  const stats = await getTradeStats24h(tracked.poolAddress);
  const splits = await getFeeSplits(tracked.poolAddress);

  // Quote decimals for the dev buy display: prefer the indexer's sampled
  // state, fall back to a direct mint read. Native SOL is always 9.
  let quoteDecimals: number | null = state?.quoteDecimals ?? null;
  if (quoteDecimals === null) {
    if (tracked.quoteMint === NATIVE_SOL_MINT) {
      quoteDecimals = 9;
    } else {
      try {
        const qm = await getMint(getConnection(), new PublicKey(tracked.quoteMint));
        quoteDecimals = qm.decimals;
      } catch {
        quoteDecimals = null;
      }
    }
  }

  const body = {
    poolAddress: tracked.poolAddress,
    verified: tracked.verified === true,
    creator: tracked.creator,
    createdAt: tracked.createdAt,
    baseSymbol: tracked.baseSymbol,
    quoteMint: tracked.quoteMint,
    quoteSymbol: tracked.quoteSymbol,
    quoteDecimals,
    devBuyLamports: tracked.devBuyLamports ?? null,
    buybackBps: tracked.buybackBps ?? 0,
    bountyBps: tracked.bountyBps ?? 0,
    graduated,
    mintAuthority,
    freezeAuthority,
    lock,
    feeSplits:
      splits.length > 0
        ? { recipients: splits, creatorRemainderBps: creatorRemainderBps(splits) }
        : null,
    creatorFeesUnclaimed:
      state && (state.creatorBaseFeeRaw !== null || state.creatorQuoteFeeRaw !== null)
        ? {
            baseRaw: state.creatorBaseFeeRaw,
            quoteRaw: state.creatorQuoteFeeRaw,
            baseDecimals: state.baseDecimals,
            quoteDecimals: state.quoteDecimals,
          }
        : null,
    activity24h: stats ? { buys: stats.buys, sells: stats.sells } : null,
    sampledAt: state?.sampledAt ?? null,
  };

  cache.set(address, { at: Date.now(), body });
  return res.status(200).json(body);
}
