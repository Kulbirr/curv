import { execute, query } from './index';
import { getNetBuyVolumes } from './trades';
import { getTrackedPool } from '../pool-registry';
import { resolveBuybackVault } from '../fee-split-claim';

export interface TraderRewardWinner {
  wallet: string;
  netVolumeRaw: string;
  rank: number;
}

/**
 * Storage half of trader rewards. Winners are decided once at
 * graduation from the trades ledger: top N wallets by net buy volume
 * (buys minus sells, in quote raw units). Deterministic, public, and
 * recomputable from the trades table by anyone.
 */

export async function getWinners(poolAddress: string): Promise<TraderRewardWinner[] | null> {
  const rows = await query<{ winners: string }>(
    'SELECT winners FROM trader_reward_winners WHERE pool_address = $1',
    [poolAddress],
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].winners) as TraderRewardWinner[];
  } catch {
    return null;
  }
}

/**
 * Decide winners for a pool, idempotently. Returns the winners, or null
 * when the pool has no trader reward config or has not graduated yet.
 * Safe to call repeatedly: winners are written once.
 */
export async function decideWinners(poolAddress: string): Promise<TraderRewardWinner[] | null> {
  const existing = await getWinners(poolAddress);
  if (existing) return existing;

  const tracked = await getTrackedPool(poolAddress);
  const reward = tracked?.traderReward;
  if (!tracked || !reward) return null;

  // Graduated? Check the latest indexed state.
  const stateRows = await query<{ graduated: number }>(
    'SELECT graduated FROM pool_states WHERE pool_address = $1',
    [poolAddress],
  );
  if ((stateRows[0]?.graduated ?? 0) !== 1) return null;

  // Net buy volumes, excluding parties that must never win.
  const volumes = await getNetBuyVolumes(poolAddress);
  const vault = resolveBuybackVault()?.toBase58();
  const excluded = new Set(
    [tracked.creator.toLowerCase(), vault?.toLowerCase()].filter(Boolean) as string[],
  );
  // The Curv fee wallet is the platform fee collector; exclude it too.
  const feeWallet = process.env.NEXT_PUBLIC_CURV_FEE_WALLET?.trim().toLowerCase();
  if (feeWallet) excluded.add(feeWallet);

  const eligible = volumes.filter((v) => !excluded.has(v.wallet.toLowerCase()));
  // Deterministic tie-break: wallet address ascending.
  eligible.sort((a, b) => {
    const byVol = BigInt(b.netQuoteRaw) - BigInt(a.netQuoteRaw);
    if (byVol !== BigInt(0)) return byVol > BigInt(0) ? 1 : -1;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  const winners: TraderRewardWinner[] = eligible.slice(0, reward.count).map((v, i) => ({
    wallet: v.wallet,
    netVolumeRaw: v.netQuoteRaw,
    rank: i + 1,
  }));

  await execute(
    `INSERT INTO trader_reward_winners (pool_address, winners, decided_at)
     VALUES ($1, $2, $3) ON CONFLICT (pool_address) DO NOTHING`,
    [poolAddress, JSON.stringify(winners), Date.now()],
  );
  return winners;
}
