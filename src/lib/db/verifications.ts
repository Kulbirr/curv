import { getDb } from './index';

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

export function getVerification(poolAddress: string): PoolVerification | null {
  const row = getDb()
    .prepare('SELECT pool_address, status, checked_at, detail FROM pool_verifications WHERE pool_address = ?')
    .get(poolAddress) as
    | { pool_address: string; status: string; checked_at: number; detail: string | null }
    | undefined;
  if (!row) return null;
  return {
    poolAddress: row.pool_address,
    status: row.status as VerificationStatus,
    checkedAt: row.checked_at,
    detail: row.detail,
  };
}

/** Portable ON CONFLICT upsert (SQLite + Postgres). */
export function setVerification(
  poolAddress: string,
  status: VerificationStatus,
  detail: string | null,
  checkedAt: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO pool_verifications (pool_address, status, checked_at, detail)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (pool_address) DO UPDATE SET
         status = excluded.status,
         checked_at = excluded.checked_at,
         detail = excluded.detail`,
    )
    .run(poolAddress, status, checkedAt, detail);
}
