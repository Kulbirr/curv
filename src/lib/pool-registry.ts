/**
 * Registry of bonding-curve pools launched through this app.
 *
 * The chain is the source of truth for all money state (price, reserves,
 * graduation). This registry only records *which* pools belong to the
 * launchpad plus their off-chain metadata (name, symbol, image).
 *
 * Storage is now the database layer in ./db (SQLite today, Postgres
 * tomorrow), the old JSON file (data/pools.json) is migrated into the DB
 * automatically on first open. The exported surface is unchanged.
 */

export type { TrackedPool, RegisterPoolInput } from './db/pools';
export {
  listPools as listTrackedPools,
  getPool as getTrackedPool,
  getPoolByMint as getTrackedPoolByMint,
  insertPool as registerPool,
} from './db/pools';
