import { PublicKey } from '@solana/web3.js';
import { query, transaction } from './index';

/**
 * Pool registry repository. This is the authoritative store of *which*
 * pools belong to the launchpad plus their off-chain metadata.
 *
 * The chain stays the source of truth for all money state (price,
 * reserves, graduation) — that lives in pool_states, written only by the
 * background indexer. This table never stores prices.
 */

export interface TrackedPool {
  /** DBC virtual pool address (base58) */
  poolAddress: string;
  /** DBC pool config address (base58) */
  configAddress: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  /** Wallet that launched the pool (base58) */
  creator: string;
  /** Unix ms when the pool was registered */
  createdAt: number;
  /** Unix ms when the pool was created on-chain (if known) */
  launchedAt?: number;
  /**
   * True only when every submitted field (config, creator, baseMint,
   * quoteMint) matched the on-chain accounts at registration time.
   * False when the RPC was unreachable during registration (honest
   * `unverified` label) — a mismatch is rejected outright and never
   * registered.
   */
  verified: boolean;
}

interface PoolRow {
  pool_address: string;
  config_address: string;
  base_mint: string;
  quote_mint: string;
  base_symbol: string;
  base_name: string;
  quote_symbol: string;
  description: string | null;
  image_url: string | null;
  website: string | null;
  twitter: string | null;
  creator: string;
  created_at: number;
  launched_at: number | null;
  verified: number;
}

function rowToPool(r: PoolRow): TrackedPool {
  return {
    poolAddress: r.pool_address,
    configAddress: r.config_address,
    baseMint: r.base_mint,
    quoteMint: r.quote_mint,
    baseSymbol: r.base_symbol,
    baseName: r.base_name,
    quoteSymbol: r.quote_symbol,
    description: r.description ?? undefined,
    imageUrl: r.image_url ?? undefined,
    website: r.website ?? undefined,
    twitter: r.twitter ?? undefined,
    creator: r.creator,
    createdAt: r.created_at,
    launchedAt: r.launched_at ?? undefined,
    verified: r.verified === 1,
  };
}

function validateAddress(label: string, value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} is not a valid Solana address`);
  }
}

export async function listPools(): Promise<TrackedPool[]> {
  const rows = await query<PoolRow>('SELECT * FROM pools ORDER BY created_at DESC');
  return rows.map(rowToPool);
}

export async function getPool(poolAddress: string): Promise<TrackedPool | null> {
  let normalized: string;
  try {
    normalized = new PublicKey(poolAddress).toBase58();
  } catch {
    return null;
  }
  const rows = await query<PoolRow>('SELECT * FROM pools WHERE pool_address = $1', [
    normalized,
  ]);
  return rows[0] ? rowToPool(rows[0]) : null;
}

export type RegisterPoolInput = Omit<TrackedPool, 'createdAt' | 'verified'> & {
  createdAt?: number;
  verified?: boolean;
};

/**
 * Insert a pool transactionally. The duplicate check and the insert run
 * inside one transaction on a single connection, so two concurrent
 * registrations of the same pool cannot both succeed.
 */
export async function insertPool(input: RegisterPoolInput): Promise<TrackedPool> {
  const entry: TrackedPool = {
    poolAddress: validateAddress('poolAddress', input.poolAddress),
    configAddress: validateAddress('configAddress', input.configAddress),
    baseMint: validateAddress('baseMint', input.baseMint),
    quoteMint: validateAddress('quoteMint', input.quoteMint),
    creator: validateAddress('creator', input.creator),
    baseSymbol: String(input.baseSymbol || '').trim().slice(0, 12).toUpperCase(),
    baseName: String(input.baseName || '').trim().slice(0, 64),
    quoteSymbol: String(input.quoteSymbol || '').trim().slice(0, 12).toUpperCase(),
    description: String(input.description || '').slice(0, 500) || undefined,
    imageUrl: input.imageUrl ? String(input.imageUrl).slice(0, 500) : undefined,
    website: input.website ? String(input.website).slice(0, 200) : undefined,
    twitter: input.twitter ? String(input.twitter).slice(0, 200) : undefined,
    launchedAt: typeof input.launchedAt === 'number' ? input.launchedAt : undefined,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    verified: input.verified === true,
  };
  if (!entry.baseSymbol) throw new Error('baseSymbol is required');
  if (!entry.baseName) throw new Error('baseName is required');
  if (entry.imageUrl && !/^https?:\/\//.test(entry.imageUrl)) throw new Error('imageUrl must be http(s)');

  return transaction(async (db) => {
    const existing = await db.query('SELECT 1 FROM pools WHERE pool_address = $1', [
      entry.poolAddress,
    ]);
    if ((existing.rowCount ?? 0) > 0) throw new Error('Pool is already registered');
    await db.query(
      `INSERT INTO pools
       (pool_address, config_address, base_mint, quote_mint, base_symbol, base_name,
        quote_symbol, description, image_url, website, twitter, creator,
        created_at, launched_at, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        entry.poolAddress,
        entry.configAddress,
        entry.baseMint,
        entry.quoteMint,
        entry.baseSymbol,
        entry.baseName,
        entry.quoteSymbol,
        entry.description ?? null,
        entry.imageUrl ?? null,
        entry.website ?? null,
        entry.twitter ?? null,
        entry.creator,
        entry.createdAt,
        entry.launchedAt ?? null,
        entry.verified ? 1 : 0,
      ],
    );
    return entry;
  });
}
