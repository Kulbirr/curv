import { PublicKey } from '@solana/web3.js';
import { execute, query, transaction } from './index';

/**
 * Pool registry repository. This is the authoritative store of *which*
 * pools belong to the launchpad plus their off-chain metadata.
 *
 * The chain stays the source of truth for all money state (price,
 * reserves, graduation), that lives in pool_states, written only by the
 * background indexer. This table never stores prices.
 */

/** Trader rewards: a share of creator fees reserved for top net buyers. */
export interface TraderReward {
  /** Number of winners (1-5). */
  count: number;
  /** Total bps shared equally by winners. */
  bps: number;
  /** Winner selection rule; only 'top_net_buyers' in v1. */
  rule: 'top_net_buyers';
}

export function parseTraderReward(raw: unknown): TraderReward | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof v !== 'object' || v === null) return undefined;
  const count = Number(v.count);
  const bps = Number(v.bps);
  if (!Number.isInteger(count) || count < 1 || count > 5) return undefined;
  if (!Number.isInteger(bps) || bps < 1 || bps > 9000) return undefined;
  return { count, bps, rule: 'top_net_buyers' };
}

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
   * Optional dev buy in quote lamports, disclosed by the creator at
   * launch. Undefined/null = no dev buy.
   */
  devBuyLamports?: number;
  /**
   * Buyback and burn commitment: basis points (0-10000) of the creator fee
   * share committed to automatic buyback and burn. Set once at launch,
   * immutable after. 0 = feature off.
   */
  buybackBps?: number;
  traderReward?: TraderReward;
  /**
   * True only when every submitted field (config, creator, baseMint,
   * quoteMint) matched the on-chain accounts at registration time.
   * False when the RPC was unreachable during registration (honest
   * `unverified` label), a mismatch is rejected outright and never
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
  dev_buy_lamports: number | null;
  buyback_bps: number | null;
  trader_reward: string | null;
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
    devBuyLamports: r.dev_buy_lamports ?? undefined,
    buybackBps: r.buyback_bps ?? 0,
    traderReward: parseTraderReward(r.trader_reward),
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

/**
 * Find the tracked pool whose base token mint matches. Used by the
 * header search so a pasted coin (mint) address jumps to its token page
 * instead of reporting "not a Curv pool".
 */
export async function getPoolByMint(baseMint: string): Promise<TrackedPool | null> {
  let normalized: string;
  try {
    normalized = new PublicKey(baseMint).toBase58();
  } catch {
    return null;
  }
  const rows = await query<PoolRow>('SELECT * FROM pools WHERE base_mint = $1', [
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
    devBuyLamports:
      typeof input.devBuyLamports === 'number' &&
      Number.isInteger(input.devBuyLamports) &&
      input.devBuyLamports > 0
        ? input.devBuyLamports
        : undefined,
    buybackBps:
      typeof input.buybackBps === 'number' &&
      Number.isInteger(input.buybackBps) &&
      input.buybackBps >= 0 &&
      input.buybackBps <= 10000
        ? input.buybackBps
        : 0,
    traderReward: parseTraderReward(input.traderReward),
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
        created_at, launched_at, verified, dev_buy_lamports, buyback_bps, trader_reward)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
        entry.devBuyLamports ?? null,
        entry.buybackBps ?? 0,
        entry.traderReward ? JSON.stringify(entry.traderReward) : null,
      ],
    );
    return entry;
  });
}

/**
 * Fill in a missing card image for an already-registered pool. Only
 * updates when the row currently has no image (heal path for launches
 * whose imageUrl never reached the registry). Returns true when a row
 * was actually updated.
 */
export async function updatePoolImage(
  poolAddress: string,
  imageUrl: string,
): Promise<boolean> {
  validateAddress('poolAddress', poolAddress);
  if (!/^https:\/\/[^/]+\/.+/.test(imageUrl) || imageUrl.length > 500) {
    throw new Error('imageUrl must be an https URL');
  }
  const n = await execute(
    'UPDATE pools SET image_url = $1 WHERE pool_address = $2 AND image_url IS NULL',
    [imageUrl, poolAddress],
  );
  return n > 0;
}
