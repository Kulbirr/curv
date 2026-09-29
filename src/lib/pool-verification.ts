import { PublicKey } from '@solana/web3.js';
import { getDbcClient } from './solana';
import { setVerification } from './db/verifications';

/**
 * Field-by-field on-chain verification of pool registrations.
 *
 * The old check only confirmed that the submitted address deserializes as
 * a DBC pool, an attacker could register someone else's pool (or a pool
 * whose config/mints don't match the submission) and it would pass.
 *
 * Now, when the RPC is reachable, every submitted field is compared
 * against the actual on-chain accounts:
 *   pool.poolState.config    == submitted configAddress
 *   pool.poolState.creator    == submitted creator (wallet that launched)
 *   pool.poolState.baseMint   == submitted baseMint
 *   config.quoteMint          == submitted quoteMint
 *
 * Any mismatch is positive evidence of a bad submission → REJECTED, the
 * pool is not registered. An unreachable RPC (or a pool/config account
 * that simply isn't visible yet, real RPC lag right after launch) is
 * inconclusive, never a pass: the pool registers with the honest
 * `unverified` label. Absence of evidence is not evidence of fraud.
 *
 * REST polling only, like everything else in this codebase.
 */

export interface PoolRegistrationFields {
  poolAddress: string;
  configAddress: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
}

export type VerificationOutcome =
  | { status: 'verified'; detail: string }
  | { status: 'unverified'; detail: string }
  | { status: 'rejected'; detail: string };

function pubkeyToBase58(v: unknown): string | null {
  try {
    if (v instanceof PublicKey) return v.toBase58();
    // Anchor may hand back a raw base58 string in some shapes; accept it.
    if (typeof v === 'string') return new PublicKey(v).toBase58();
    return null;
  } catch {
    return null;
  }
}

export async function verifyPoolRegistration(
  input: PoolRegistrationFields,
): Promise<VerificationOutcome> {
  let pool: unknown;
  let config: unknown;
  try {
    const client = getDbcClient();
    [pool, config] = await Promise.all([
      client.state.getPool(new PublicKey(input.poolAddress)),
      client.state.getPoolConfig(new PublicKey(input.configAddress)),
    ]);
  } catch (e) {
    // RPC unreachable (timeout, 429, network error): inconclusive.
    return {
      status: 'unverified',
      detail: `RPC unreachable at check time (${e instanceof Error ? e.message : 'unknown error'})`,
    };
  }

  if (pool === null || pool === undefined) {
    return {
      status: 'unverified',
      detail: 'Pool account not found at check time (possible RPC lag right after launch)',
    };
  }
  // The SDK wraps the struct: { poolState: { ... } }. Handle both shapes.
  const ps = ((pool as { poolState?: unknown }).poolState ?? pool) as Record<string, unknown>;

  const mismatches: string[] = [];
  if (pubkeyToBase58(ps['config']) !== input.configAddress) mismatches.push('config');
  if (pubkeyToBase58(ps['creator']) !== input.creator) mismatches.push('creator');
  if (pubkeyToBase58(ps['baseMint']) !== input.baseMint) mismatches.push('baseMint');

  if (config === null || config === undefined) {
    return {
      status: 'unverified',
      detail: 'Config account not found at check time (possible RPC lag right after launch)',
    };
  }
  if (pubkeyToBase58((config as Record<string, unknown>)['quoteMint']) !== input.quoteMint) {
    mismatches.push('quoteMint');
  }

  if (mismatches.length > 0) {
    return {
      status: 'rejected',
      detail: `On-chain mismatch in: ${mismatches.join(', ')}, submission does not describe this pool`,
    };
  }
  return {
    status: 'verified',
    detail: 'config, creator, baseMint and quoteMint all match the on-chain accounts',
  };
}

/**
 * Run verification and persist the outcome in pool_verifications.
 * Rejected pools are recorded as `unverified` with the rejection reason
 * in the detail, they are never registered, and the record explains why.
 */
export async function verifyAndRecord(input: PoolRegistrationFields): Promise<VerificationOutcome> {
  const outcome = await verifyPoolRegistration(input);
  setVerification(
    input.poolAddress,
    outcome.status === 'verified' ? 'verified' : 'unverified',
    outcome.status === 'rejected' ? `rejected: ${outcome.detail}` : outcome.detail,
    Date.now(),
  );
  return outcome;
}
