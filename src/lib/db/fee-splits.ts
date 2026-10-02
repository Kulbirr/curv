import { execute, query } from './index';
import type { FeeSplitBinding, FeeSplitRecipient } from '../fee-split-terms';

export type { FeeSplitBinding, FeeSplitRecipient } from '../fee-split-terms';
export {
  BPS_TOTAL,
  MAX_SPLIT_RECIPIENTS,
  MAX_SPLIT_TOTAL_BPS,
  checkBindingEligibility,
  creatorRemainderBps,
  resolveEffectiveRecipients,
  splitShareRaw,
  validateFeeSplits,
} from '../fee-split-terms';

/**
 * Storage half of the creator fee split feature. Terms are written
 * once at pool registration and never edited: changing fee terms
 * after people bought in is exactly the behaviour the public record
 * exists to prevent. Distribution itself is not custodial and never
 * passes through this store: when the creator claims through Curv,
 * the claim transaction pays each recipient in the same transaction
 * (see lib/fee-split-claim.ts).
 */

export async function insertFeeSplits(
  poolAddress: string,
  recipients: FeeSplitRecipient[],
): Promise<void> {
  if (recipients.length === 0) return;
  await execute(
    'INSERT INTO fee_splits (pool_address, recipients, created_at) VALUES ($1, $2, $3)',
    [poolAddress, JSON.stringify(recipients), Date.now()],
  );
}

export async function getFeeSplits(poolAddress: string): Promise<FeeSplitRecipient[]> {
  const rows = await query<{ recipients: string }>(
    'SELECT recipients FROM fee_splits WHERE pool_address = $1',
    [poolAddress],
  );
  if (!rows[0]) return [];
  try {
    const parsed = JSON.parse(rows[0].recipients) as FeeSplitRecipient[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * All wallet bindings recorded for a pool, ordered by entry index.
 */
export async function getFeeSplitBindings(poolAddress: string): Promise<FeeSplitBinding[]> {
  const rows = await query<{ entry_index: number; wallet: string; bound_at: number }>(
    'SELECT entry_index, wallet, bound_at FROM fee_split_bindings WHERE pool_address = $1 ORDER BY entry_index',
    [poolAddress],
  );
  return rows.map((r) => ({
    poolAddress,
    entryIndex: r.entry_index,
    wallet: r.wallet,
    boundAt: r.bound_at,
  }));
}

/**
 * Record a wallet binding for one split entry. First valid signature
 * wins: ON CONFLICT DO NOTHING makes the insert a no-op when a row
 * already exists, and the returned flag tells the caller whether this
 * call was the one that won. Bindings are never updated or deleted.
 */
export async function insertFeeSplitBinding(
  poolAddress: string,
  entryIndex: number,
  wallet: string,
): Promise<boolean> {
  const rowCount = await execute(
    `INSERT INTO fee_split_bindings (pool_address, entry_index, wallet, bound_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pool_address, entry_index) DO NOTHING`,
    [poolAddress, entryIndex, wallet, Date.now()],
  );
  return rowCount === 1;
}

/** All pools where this wallet is a split recipient (the claim loop inbox). */
export async function listSplitsForWallet(
  wallet: string,
): Promise<Array<{ poolAddress: string; recipient: FeeSplitRecipient }>> {
  const rows = await query<{ pool_address: string; recipients: string }>(
    'SELECT pool_address, recipients FROM fee_splits',
  );
  const out: Array<{ poolAddress: string; recipient: FeeSplitRecipient }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.recipients) as FeeSplitRecipient[];
      const hit = parsed.find((r) => r.wallet === wallet);
      if (hit) out.push({ poolAddress: row.pool_address, recipient: hit });
    } catch {
      // A malformed row can only exist if written outside the API;
      // skip it rather than failing the whole inbox.
    }
  }
  return out;
}
