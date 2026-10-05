import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getTrackedPool } from '@/lib/pool-registry';
import { getPoolState } from '@/lib/db/states';
import { getDevActivity, getTradesForWalletAndPool } from '@/lib/db/trades';
import { getBalanceDelta24h } from '@/lib/db/dev-snapshots';
import { parseAddress } from '@/lib/api-validation';
import { getConnection } from '@/lib/solana';
import { rawToUi } from '@/lib/swap-math';

/**
 * GET /api/pools/[address]/dev-radar
 *
 * The facts behind the token page's Dev Wallet Radar: what share of
 * supply the creator still holds (associated token account), their
 * trade activity in the last 1h/24h, recent moves, and any off-curve
 * balance delta from snapshots. Every field is a checkable fact; a
 * fact that cannot be established is null and the panel omits the
 * row, never estimated.
 */

export const config = {
  api: { bodyParser: { sizeLimit: '8kb' } },
};

const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

// Total supply barely changes (fixed at launch), so it gets its own
// longer-lived cache keyed by mint.
const SUPPLY_TTL_MS = 10 * 60 * 1000;
const supplyCache = new Map<string, { at: number; raw: string }>();

interface DevActivityOut {
  buys: number;
  sells: number;
  netQuoteUi: string;
}

interface DevMoveOut {
  id: number;
  side: 'buy' | 'sell';
  quoteUi: string;
  supplyPct: number | null;
  tradedAt: number;
  txSignature: string;
}

/** Percentage with 2 decimals from raw integers, via BN. Null on zero supply. */
export function pctOfSupply(amountRaw: string, supplyRaw: string): number | null {
  const supply = new BN(supplyRaw);
  if (supply.isZero()) return null;
  const bps = new BN(amountRaw).muln(10000).div(supply);
  return bps.toNumber() / 100;
}

/** Signed UI formatting of a possibly-negative raw amount. */
export function signedRawToUi(raw: string, decimals: number): string {
  const neg = raw.startsWith('-');
  const ui = rawToUi(new BN(neg ? raw.slice(1) : raw), decimals);
  return neg && ui !== '0' ? `-${ui}` : ui;
}

async function getTotalSupplyRaw(baseMint: string): Promise<string | null> {
  const hit = supplyCache.get(baseMint);
  if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.raw;
  try {
    const res = await getConnection().getTokenSupply(new PublicKey(baseMint));
    supplyCache.set(baseMint, { at: Date.now(), raw: res.value.amount });
    return res.value.amount;
  } catch {
    return null;
  }
}

/**
 * Dev's token balance in raw units from their associated token account.
 * Returns '0' when the ATA does not exist (chain fact: nothing held
 * there), null when the read itself fails.
 */
async function getDevBalanceRaw(baseMint: string, creator: string): Promise<string | null> {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(baseMint),
      new PublicKey(creator),
    );
    const info = await getConnection().getAccountInfo(ata);
    if (!info) return '0';
    const bal = await getConnection().getTokenAccountBalance(ata);
    return bal.value.amount;
  } catch {
    return null;
  }
}

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

  const creator = tracked.creator;
  const now = Date.now();

  // Quote decimals: prefer the indexer's sampled state, fall back to 9.
  // (Trust endpoint does a mint read; dev-radar keeps it simple — the
  // indexer backfills quote_decimals on trades, and SOL is 9.)
  const state = await getPoolState(tracked.poolAddress);
  const quoteDecimals = state?.quoteDecimals ?? 9;

  const [supplyRaw, balanceRaw] = await Promise.all([
    getTotalSupplyRaw(tracked.baseMint),
    getDevBalanceRaw(tracked.baseMint, creator),
  ]);

  const supplyPct =
    supplyRaw !== null && balanceRaw !== null ? pctOfSupply(balanceRaw, supplyRaw) : null;
  const balanceUi =
    balanceRaw !== null ? rawToUi(new BN(balanceRaw), state?.baseDecimals ?? 9) : null;

  const [act1h, act24h, moves, delta] = await Promise.all([
    getDevActivity(tracked.poolAddress, creator, now - 60 * 60 * 1000),
    getDevActivity(tracked.poolAddress, creator, now - 24 * 60 * 60 * 1000),
    getTradesForWalletAndPool(creator, tracked.poolAddress, 10),
    getBalanceDelta24h(tracked.poolAddress, creator),
  ]);

  const toActivity = (a: { buys: number; sells: number; netQuoteRaw: string }): DevActivityOut => ({
    buys: a.buys,
    sells: a.sells,
    netQuoteUi: signedRawToUi(a.netQuoteRaw, quoteDecimals),
  });

  const movesOut: DevMoveOut[] = moves.map((m) => ({
    id: m.id,
    side: m.side,
    quoteUi: rawToUi(new BN(m.quoteAmountRaw), m.quoteDecimals ?? quoteDecimals),
    supplyPct: supplyRaw !== null ? pctOfSupply(m.baseAmountRaw, supplyRaw) : null,
    tradedAt: m.tradedAt,
    txSignature: m.txSignature,
  }));

  let balanceDelta24h: { pctPoints: number; direction: 'inflow' | 'outflow' | 'flat' } | null = null;
  if (delta && supplyRaw !== null) {
    const newPct = pctOfSupply(delta.newest.balanceRaw, supplyRaw);
    const oldPct = pctOfSupply(delta.oldest.balanceRaw, supplyRaw);
    if (newPct !== null && oldPct !== null) {
      const pctPoints = Math.round((newPct - oldPct) * 100) / 100;
      balanceDelta24h = {
        pctPoints,
        direction: pctPoints > 0.01 ? 'inflow' : pctPoints < -0.01 ? 'outflow' : 'flat',
      };
    }
  }

  const body = {
    poolAddress: tracked.poolAddress,
    devWallet: creator,
    baseSymbol: tracked.baseSymbol,
    baseDecimals: state?.baseDecimals ?? 9,
    quoteSymbol: tracked.quoteSymbol,
    quoteDecimals,
    supplyPct,
    balanceUi,
    activity1h: toActivity(act1h),
    activity24h: toActivity(act24h),
    moves: movesOut,
    balanceDelta24h,
    updatedAt: now,
  };

  cache.set(address, { at: Date.now(), body });
  return res.status(200).json(body);
}
