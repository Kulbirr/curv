import { query } from './index';

/**
 * Per-pool verification state.
 *
 * Phase 1 keeps the registry's `verified` boolean (set once at
 * registration) as the user-facing surface. This table exists so phase 2
 * can record field-by-field on-chain verification (pool account shape,
 * config address, mints, creator) with timestamps and detail, without a
 * schema change. Not yet wired into the API.
 */

export type VerificationStatus = 'verified' | 'unverified' | 'pending';

export interface PoolVerification {
  poolAddress: string;
  status: VerificationStatus;
  checkedAt: number;
  detail: string | null;
}

export async function getVerification(poolAddress: string): Promise<PoolVerification | null> {
  const rows = await query<{
    pool_address: string;
    status: string;
    checked_at: number;
    detail: string | null;
  }>('SELECT pool_address, status, checked_at, detail FROM pool_verifications WHERE pool_address = $1', [
    poolAddress,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    poolAddress: row.pool_address,
    status: row.status as VerificationStatus,
    checkedAt: row.checked_at,
    detail: row.detail,
  };
}

/** Portable ON CONFLICT upsert (SQLite + Postgres). */
export async function setVerification(
  poolAddress: string,
  status: VerificationStatus,
  detail: string | null,
  checkedAt: number,
): Promise<void> {
  await query(
    `INSERT INTO pool_verifications (pool_address, status, checked_at, detail)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pool_address) DO UPDATE SET
       status = excluded.status,
       checked_at = excluded.checked_at,
       detail = excluded.detail`,
    [poolAddress, status, checkedAt, detail],
  );
}
