import { execute, query } from './index';

export interface DevSnapshot {
  poolAddress: string;
  wallet: string;
  balanceRaw: string;
  takenAt: number;
}

function toSnapshot(r: {
  pool_address: string;
  wallet: string;
  balance_raw: string;
  taken_at: number;
}): DevSnapshot {
  return {
    poolAddress: r.pool_address,
    wallet: r.wallet,
    balanceRaw: r.balance_raw,
    takenAt: r.taken_at,
  };
}

/**
 * Write a dev-wallet balance snapshot. Callers throttle to one write per
 * (pool, wallet) per 5 minutes; the table is the off-curve transfer
 * backstop for the Dev Wallet Radar.
 */
export async function writeDevSnapshot(args: {
  poolAddress: string;
  wallet: string;
  balanceRaw: string;
  takenAt: number;
}): Promise<void> {
  await execute(
    `INSERT INTO dev_wallet_snapshots (pool_address, wallet, balance_raw, taken_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [args.poolAddress, args.wallet, args.balanceRaw, args.takenAt],
  );
}

/** Most recent snapshot for a (pool, wallet), or null when none exists. */
export async function getLatestDevSnapshot(
  poolAddress: string,
  wallet: string,
): Promise<DevSnapshot | null> {
  const rows = await query<Parameters<typeof toSnapshot>[0]>(
    `SELECT pool_address, wallet, balance_raw, taken_at FROM dev_wallet_snapshots
     WHERE pool_address = $1 AND wallet = $2 ORDER BY taken_at DESC LIMIT 1`,
    [poolAddress, wallet],
  );
  return rows.length > 0 ? toSnapshot(rows[0]) : null;
}

/**
 * Balance delta between the newest snapshot and the oldest snapshot taken
 * at least 24h ago (or the oldest available when none is that old).
 * Returns the raw balance pair plus timestamps so the caller can compute
 * percentage-point deltas against total supply. Null when fewer than two
 * snapshots exist.
 */
export async function getBalanceDelta24h(
  poolAddress: string,
  wallet: string,
): Promise<{ newest: DevSnapshot; oldest: DevSnapshot } | null> {
  const rows = await query<Parameters<typeof toSnapshot>[0]>(
    `SELECT pool_address, wallet, balance_raw, taken_at FROM dev_wallet_snapshots
     WHERE pool_address = $1 AND wallet = $2 ORDER BY taken_at DESC LIMIT 100`,
    [poolAddress, wallet],
  );
  if (rows.length < 2) return null;
  const newest = toSnapshot(rows[0]);
  const cutoff = newest.takenAt - 24 * 60 * 60 * 1000;
  // Oldest snapshot at or before the 24h cutoff; fall back to the oldest
  // available so short-lived pools still get a delta.
  let oldest: DevSnapshot = toSnapshot(rows[rows.length - 1]);
  for (let i = rows.length - 1; i >= 0; i--) {
    const s = toSnapshot(rows[i]);
    if (s.takenAt <= cutoff) {
      oldest = s;
      break;
    }
  }
  if (oldest.takenAt === newest.takenAt) return null;
  return { newest, oldest };
}
