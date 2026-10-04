import { Pool, types as pgTypes } from 'pg';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Central data-access layer for Curv's read model.
 *
 * Why this exists: every user-facing API used to read Solana RPC once per
 * pool per request, so user count multiplied RPC load. Now a single
 * background indexer (src/indexer.ts) samples each pool once per interval
 * and persists the result here; APIs serve indexed rows and make zero
 * live RPC calls per user request.
 *
 * Repository interface over Postgres (pg). This was SQLite (node:sqlite)
 * until 2026-09-28; the SQL was kept in the portable subset precisely so
 * this swap would not touch call sites beyond async/await:
 *   - `INSERT ... ON CONFLICT (...) DO UPDATE` upserts
 *   - BIGINT unix-millisecond timestamps, BIGINT 0/1 booleans, no
 *     date functions
 *   - TEXT primary keys (pool addresses, signatures), no sequences
 * Type mapping from the old SQLite schema: TEXT -> TEXT,
 * INTEGER -> BIGINT, REAL -> DOUBLE PRECISION, BLOB -> BYTEA.
 *
 * Schema note: the Postgres host is shared with other projects, so every
 * Curv table lives in the `curv` schema. The production pool sets
 * search_path=curv,public and the schema DDL starts with
 * CREATE SCHEMA IF NOT EXISTS curv, unqualified names in the
 * repositories resolve into curv and public is never touched.
 *
 * Async note: pg is async-only, so every repository function returns a
 * Promise. Next.js API routes and the indexer are already async; the only
 * mechanical change at call sites is await.
 *
 * Tables:
 *   pools             , the pool registry (replaces data/pools.json)
 *   pool_states       , latest successfully sampled on-chain state per pool
 *   ticks             , price/reserve samples feeding charts + estimates
 *   nonces            , single-use registration signatures (replay protection)
 *   pool_verifications, per-pool verification state
 *   rate_limits       , DB-backed fixed-window rate limit counters
 *   vanity_pool       , pre-ground "...curv" mint keypairs for instant launch
 *                        (secrets encrypted at rest; wiped on handout)
 */

export const DATA_DIR = path.join(process.cwd(), 'data');

const SCHEMA = `
-- Curv lives in its own schema: the Postgres host is shared with other
-- projects (e.g. narrative-sniper), so unqualified table names must never
-- land in public. Production pools set search_path=curv,public.
CREATE SCHEMA IF NOT EXISTS curv;

CREATE TABLE IF NOT EXISTS pools (
  pool_address TEXT PRIMARY KEY,
  config_address TEXT NOT NULL,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  base_symbol TEXT NOT NULL,
  base_name TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  website TEXT,
  twitter TEXT,
  creator TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  launched_at BIGINT,
  verified BIGINT NOT NULL DEFAULT 0,
  -- Optional dev buy in quote lamports, disclosed by the creator at
  -- launch and shown on the trust panel. NULL = no dev buy.
  dev_buy_lamports BIGINT
);
CREATE INDEX IF NOT EXISTS idx_pools_created ON pools (created_at DESC);

CREATE TABLE IF NOT EXISTS pool_states (
  pool_address TEXT PRIMARY KEY,
  price DOUBLE PRECISION,
  quote_reserve DOUBLE PRECISION,
  base_reserve DOUBLE PRECISION,
  progress DOUBLE PRECISION,
  graduated BIGINT NOT NULL DEFAULT 0,
  has_swap BIGINT NOT NULL DEFAULT 0,
  market_cap DOUBLE PRECISION,
  base_decimals BIGINT NOT NULL DEFAULT 9,
  quote_decimals BIGINT NOT NULL DEFAULT 9,
  migration_quote_threshold DOUBLE PRECISION,
  creator_base_fee_raw TEXT,
  creator_quote_fee_raw TEXT,
  sampled_at BIGINT,
  last_attempt_at BIGINT,
  consecutive_failures BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticks (
  pool_address TEXT NOT NULL,
  ts BIGINT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  quote_reserve DOUBLE PRECISION,
  PRIMARY KEY (pool_address, ts)
);
CREATE INDEX IF NOT EXISTS idx_ticks_pool_ts ON ticks (pool_address, ts);

CREATE TABLE IF NOT EXISTS nonces (
  signature TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_created ON nonces (created_at);

CREATE TABLE IF NOT EXISTS pool_verifications (
  pool_address TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at BIGINT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS vanity_pool (
  pubkey TEXT PRIMARY KEY,
  secret_encrypted BYTEA,
  created_at BIGINT NOT NULL,
  consumed BIGINT NOT NULL DEFAULT 0,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_vanity_pool_ready ON vanity_pool (consumed, created_at);

CREATE TABLE IF NOT EXISTS pool_viewers (
  pool_address TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (pool_address, session_id)
);
CREATE INDEX IF NOT EXISTS idx_pool_viewers_seen ON pool_viewers (last_seen);

-- Creator fee splits fixed at launch: recipients JSON is an array of
-- { wallet, bps, handle? } sharing the creator trading fee. The
-- creator keeps the remainder (10000 minus the sum). Terms are public
-- and immutable once the pool is registered.
CREATE TABLE IF NOT EXISTS fee_splits (
  pool_address TEXT PRIMARY KEY,
  recipients TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Buyback and burn ledger. Append-only: one row per executed burn.
-- The keeper claims the buyback slice of creator fees, swaps it for the
-- base token via Jupiter, and burns. Immutable once written.
CREATE TABLE IF NOT EXISTS buyback_burns (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  quote_amount_raw TEXT NOT NULL,
  base_amount_raw TEXT NOT NULL,
  burned_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyback_burns_pool ON buyback_burns (pool_address, burned_at DESC);

-- Wallet bindings for fee split entries, written through the recipient
-- onboarding links. One row per (pool, entry), first valid signature
-- wins: the INSERT uses ON CONFLICT DO NOTHING and the application
-- checks eligibility first. Rows are never updated or deleted; the
-- bound wallet becomes the entry's payout wallet at claim time.
CREATE TABLE IF NOT EXISTS fee_split_bindings (
  pool_address TEXT NOT NULL,
  entry_index INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  bound_at BIGINT NOT NULL,
  PRIMARY KEY (pool_address, entry_index)
);
-- X identity behind a binding, for old rows bound through the removed
-- Login with X flow. Kept for history; new bindings leave these null.
ALTER TABLE fee_split_bindings ADD COLUMN IF NOT EXISTS x_user_id TEXT;
ALTER TABLE fee_split_bindings ADD COLUMN IF NOT EXISTS x_handle TEXT;

-- In-app notification inbox, keyed to the connected wallet. Events:
-- a split recipient bound their wallet, fees are claimable, a split
-- payout landed. Rows are append-only; reading marks read_at.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at BIGINT NOT NULL,
  read_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_notifications_wallet ON notifications (wallet, created_at DESC);

-- Trading strategy signals (mirror feed). Signals are published by the
-- operator through the admin API and are identical for every subscriber:
-- crypto spot buys only, no leverage, no personalization. Rows are never
-- edited; a signal is cancelled by flipping status. The public feed only
-- serves status = 'active' rows whose expires_at is in the future.
CREATE TABLE IF NOT EXISTS strategy_signals (
  id TEXT PRIMARY KEY,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  base_symbol TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  base_decimals BIGINT NOT NULL DEFAULT 9,
  quote_decimals BIGINT NOT NULL DEFAULT 9,
  entry_price DOUBLE PRECISION NOT NULL,
  max_price DOUBLE PRECISION NOT NULL,
  size_text TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_signals_live ON strategy_signals (status, expires_at DESC);

-- Strategy feed subscriptions. A subscription is bought with a plain SOL
-- transfer the subscriber signs themselves; the server only verifies the
-- transfer on chain and records the expiry. Flat fee only, no performance
-- cut. wallet is the subscriber's address.
CREATE TABLE IF NOT EXISTS strategy_subscriptions (
  wallet TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  tx_signature TEXT,
  created_at BIGINT NOT NULL
);

-- Idempotency for subscription payments: one signature pays for one
-- subscription window. A signature seen here is rejected as already used.
CREATE TABLE IF NOT EXISTS strategy_used_signatures (
  signature TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Eligible coin universe for the signal feed. Only coins listed here as
-- active can become signal candidates. tier is core (large caps) or
-- satellite (mid caps with per signal depth checks). coingecko_id drives
-- the liquidity gate; base_mint is the Solana mint used at mirror time.
CREATE TABLE IF NOT EXISTS strategy_universe (
  base_mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  coingecko_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'core',
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

-- Signal candidates moving through the approval pipeline. A candidate is
-- submitted by the operator, evaluated by deterministic gates and then by
-- the AI judge, and only published when approved. Rejected rows stay as
-- the audit trail and are never shown to subscribers.
CREATE TABLE IF NOT EXISTS strategy_signal_candidates (
  id TEXT PRIMARY KEY,
  base_mint TEXT NOT NULL,
  base_symbol TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  entry_low DOUBLE PRECISION NOT NULL,
  entry_high DOUBLE PRECISION NOT NULL,
  stop_price DOUBLE PRECISION NOT NULL,
  targets TEXT NOT NULL,
  size_text TEXT,
  thesis TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  no_known_unlock BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  rule_results TEXT,
  ai_verdict TEXT,
  ai_reasons TEXT,
  decided_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_candidates_status ON strategy_signal_candidates (status, created_at DESC);
`;

// pg returns BIGINT (int8) columns as strings by default. Unix-ms
// timestamps, counters and 0/1 booleans all fit safely in a JS number,
// so parse them: every read path then behaves exactly like the old
// SQLite layer did (which returned numbers).
pgTypes.setTypeParser(pgTypes.builtins.INT8, (v: string) => parseInt(v, 10));

/**
 * Minimal query surface shared by Pool and PoolClient. Repository
 * functions use this; transaction() hands them a dedicated client so
 * the check-and-set sequences stay atomic.
 */
export interface DbClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, any>>; rowCount: number | null }>;
}

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Strip sslmode from a pasted connection string. pg-connection-string
 * treats sslmode=require as verify-full and lets it silently override the
 * explicit `ssl` option in getPool(), which breaks managed hosts whose CA
 * is not in the default trust store (Aiven: "self-signed certificate in
 * certificate chain"). TLS is managed explicitly via `ssl` in getPool().
 */
export function sanitizeConnectionString(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[db] DATABASE_URL is not set. Point it at Postgres, e.g. ' +
        'postgres://user:pass@host:5432/dbname (Aiven), or run a local ' +
        'Postgres and use postgres://postgres@localhost:5432/curv',
    );
  }
  return sanitizeConnectionString(url);
}

function sslFor(url: string): false | { rejectUnauthorized: boolean; ca?: string } {
  // Local dev Postgres instances don't speak SSL; managed hosts (Aiven
  // and the like) require it. The connection is still encrypted whenever
  // the server demands it.
  if (/(^|[@/])(localhost|127\.0\.0\.1)([:/]|$)/.test(url)) return false;
  const caCert = process.env.DATABASE_CA_CERT;
  if (caCert) {
    // Accept raw PEM or base64-encoded PEM (Vercel env vars dislike newlines).
    const pem = caCert.includes('BEGIN CERTIFICATE')
      ? caCert
      : Buffer.from(caCert, 'base64').toString('utf8');
    return { rejectUnauthorized: true, ca: pem };
  }
  // Fail loud in the server logs; the connection still works so a missing
  // cert can never take production down on deploy. Set DATABASE_CA_CERT
  // (the CA certificate from the Aiven console) to enable verification.
  console.warn(
    '[db] WARNING: DATABASE_CA_CERT is not set; connecting to the managed ' +
      'database WITHOUT verifying its TLS certificate. Download the CA ' +
      'certificate from the database console and set DATABASE_CA_CERT.'
  );
  return { rejectUnauthorized: false };
}

let pool: Pool | null = null;
// The one-time SQLite seed import must not run inside tests: every test
// expects a pristine database.
let seedImportAllowed = true;
// Name of the throwaway schema the test pool points at (null in prod).
let testSchemaName: string | null = null;

export function getPool(): Pool {
  if (!pool) {
    const cs = connectionString();
    pool = new Pool({
      connectionString: cs,
      ssl: sslFor(cs),
      // Curv tables live in the curv schema (shared host); unqualified
      // names resolve there first, public stays untouched.
      options: '-c search_path=curv,public',
      // Small pool: serverless instances multiply connections, and
      // managed Postgres tiers cap them. PG_IDLE_TIMEOUT_MS lets
      // long-lived workers (e.g. the vanity grinder) keep connections
      // warm instead of churning them; defaults to 10s.
      max: numEnv('PG_POOL_MAX', 5),
      idleTimeoutMillis: numEnv('PG_IDLE_TIMEOUT_MS', 10_000),
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[db] unexpected pool error', err));
  }
  return pool;
}

/**
 * The query surface the repositories use. In production this is the
 * shared pool; inside transaction() callers receive a dedicated client
 * instead, never mix the two inside one transaction.
 */
export function getDb(): DbClient {
  return getPool();
}

interface SeedPool {
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

interface SeedState {
  pool_address: string;
  price: number | null;
  quote_reserve: number | null;
  base_reserve: number | null;
  progress: number | null;
  graduated: number;
  has_swap: number;
  market_cap: number | null;
  base_decimals: number;
  quote_decimals: number;
  migration_quote_threshold: number | null;
  creator_base_fee_raw: string | null;
  creator_quote_fee_raw: string | null;
  sampled_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
}

interface SeedNonce {
  signature: string;
  created_at: number;
}

interface SeedTick {
  pool_address: string;
  ts: number;
  price: number;
  quote_reserve: number | null;
}

interface SeedVerification {
  pool_address: string;
  status: string;
  checked_at: number;
  detail: string | null;
}

interface SeedRateLimit {
  key: string;
  window_start: number;
  count: number;
}

interface SeedVanityMint {
  pubkey: string;
  secret_encrypted: { __buffer_base64: string } | null;
  created_at: number;
  consumed: number;
  consumed_at: number | null;
}

/** Decode the {__buffer_base64} wrapper the export script writes for BLOBs. */
function decodeSeedBuffer(v: { __buffer_base64: string } | null): Buffer | null {
  if (!v || typeof v.__buffer_base64 !== 'string') return null;
  return Buffer.from(v.__buffer_base64, 'base64');
}

/**
 * One-time import of the SQLite-era data. Source is either the
 * CURV_SEED_B64 env var (base64 of the seed JSON, the Vercel path, since
 * the seed file is gitignored and never deployed) or
 * data/postgres-seed.json (produced by scripts/export-postgres-seed.ts).
 * Runs only when the pools table is empty, so a restart never duplicates
 * indexed data. Every INSERT is ON CONFLICT DO NOTHING, so concurrent
 * first-boots on serverless can't fail each other. Skipped in tests.
 *
 * Uses a single dedicated connection for the whole import: BEGIN/COMMIT
 * issued through the pool could land on different connections and would
 * not actually be one transaction.
 */
async function runSeedImport(): Promise<void> {
  if (!seedImportAllowed) return;
  const fromEnv = process.env.CURV_SEED_B64;
  const seedPath = path.join(DATA_DIR, 'postgres-seed.json');
  let raw: string | null = null;
  if (fromEnv) {
    raw = Buffer.from(fromEnv, 'base64').toString('utf8');
  } else if (fs.existsSync(seedPath)) {
    raw = fs.readFileSync(seedPath, 'utf8');
  } else {
    return;
  }
  const seed = JSON.parse(raw) as {
    pools?: SeedPool[];
    pool_states?: SeedState[];
    ticks?: SeedTick[];
    nonces?: SeedNonce[];
    pool_verifications?: SeedVerification[];
    rate_limits?: SeedRateLimit[];
    vanity_pool?: SeedVanityMint[];
  };
  const pools = Array.isArray(seed.pools) ? seed.pools : [];
  const states = Array.isArray(seed.pool_states) ? seed.pool_states : [];
  const ticks = Array.isArray(seed.ticks) ? seed.ticks : [];
  const nonces = Array.isArray(seed.nonces) ? (seed.nonces as SeedNonce[]) : [];
  const verifications = Array.isArray(seed.pool_verifications)
    ? (seed.pool_verifications as SeedVerification[])
    : [];
  const rateLimits = Array.isArray(seed.rate_limits)
    ? (seed.rate_limits as SeedRateLimit[])
    : [];
  const vanity = Array.isArray(seed.vanity_pool)
    ? (seed.vanity_pool as SeedVanityMint[])
    : [];
  const client = await getPool().connect();
  try {
    const countRes = await client.query('SELECT COUNT(*) AS c FROM pools');
    if (Number(countRes.rows[0]?.c ?? 0) !== 0) return;
    await client.query('BEGIN');
    try {
      for (const p of pools) {
        await client.query(
          `INSERT INTO pools
           (pool_address, config_address, base_mint, quote_mint, base_symbol, base_name,
            quote_symbol, description, image_url, website, twitter, creator,
            created_at, launched_at, verified)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (pool_address) DO NOTHING`,
          [
            p.pool_address, p.config_address, p.base_mint, p.quote_mint,
            p.base_symbol, p.base_name, p.quote_symbol, p.description,
            p.image_url, p.website, p.twitter, p.creator,
            p.created_at, p.launched_at, p.verified,
          ],
        );
      }
      for (const s of states) {
        await client.query(
          `INSERT INTO pool_states
           (pool_address, price, quote_reserve, base_reserve, progress, graduated,
            has_swap, market_cap, base_decimals, quote_decimals,
            migration_quote_threshold, creator_base_fee_raw, creator_quote_fee_raw,
            sampled_at, last_attempt_at, consecutive_failures)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (pool_address) DO NOTHING`,
          [
            s.pool_address, s.price, s.quote_reserve, s.base_reserve,
            s.progress, s.graduated, s.has_swap, s.market_cap,
            s.base_decimals, s.quote_decimals, s.migration_quote_threshold,
            s.creator_base_fee_raw, s.creator_quote_fee_raw,
            s.sampled_at, s.last_attempt_at, s.consecutive_failures,
          ],
        );
      }
      for (const t of ticks) {
        await client.query(
          `INSERT INTO ticks (pool_address, ts, price, quote_reserve)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (pool_address, ts) DO NOTHING`,
          [t.pool_address, t.ts, t.price, t.quote_reserve],
        );
      }
      for (const n of nonces) {
        await client.query(
          `INSERT INTO nonces (signature, created_at)
           VALUES ($1,$2)
           ON CONFLICT (signature) DO NOTHING`,
          [n.signature, n.created_at],
        );
      }
      for (const v of verifications) {
        await client.query(
          `INSERT INTO pool_verifications (pool_address, status, checked_at, detail)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (pool_address) DO NOTHING`,
          [v.pool_address, v.status, v.checked_at, v.detail],
        );
      }
      for (const r of rateLimits) {
        await client.query(
          `INSERT INTO rate_limits (key, window_start, count)
           VALUES ($1,$2,$3)
           ON CONFLICT (key) DO NOTHING`,
          [r.key, r.window_start, r.count],
        );
      }
      for (const m of vanity) {
        // Encrypted blob only, never decrypted here. Consumed rows keep
        // their NULL secret exactly as exported.
        await client.query(
          `INSERT INTO vanity_pool (pubkey, secret_encrypted, created_at, consumed, consumed_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (pubkey) DO NOTHING`,
          [
            m.pubkey,
            decodeSeedBuffer(m.secret_encrypted),
            m.created_at,
            m.consumed,
            m.consumed_at,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    console.log(
      `[db] imported seed: ${pools.length} pool(s), ${states.length} state(s), ` +
        `${ticks.length} tick(s), ${nonces.length} nonce(s), ` +
        `${verifications.length} verification(s), ${rateLimits.length} rate-limit(s), ` +
        `${vanity.length} vanity mint(s)`,
    );
  } catch (err) {
    console.log('[db] seed import skipped:', err instanceof Error ? err.message : err);
  } finally {
    client.release();
  }
}

/**
 * Create tables/indexes once per process (idempotent, concurrency-safe).
 * Concurrent callers share the same in-flight promise; a failure clears
 * the guard so the next caller retries.
 */
let schemaReady: Promise<void> | null = null;
export function ensureSchema(db?: DbClient): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = db ?? getPool();
      await client.query(SCHEMA);
      // Column added after the pools table already existed in
      // production: backfill it idempotently on every schema check.
      await client.query('ALTER TABLE pools ADD COLUMN IF NOT EXISTS dev_buy_lamports BIGINT');
      // Buyback and burn: basis points (0-10000) of the creator fee share
      // committed to automatic buyback and burn at launch. Immutable.
      await client.query('ALTER TABLE pools ADD COLUMN IF NOT EXISTS buyback_bps INTEGER NOT NULL DEFAULT 0');
      // AI approval columns added when the signal approval pipeline
      // shipped: older strategy_signals rows predate the pipeline.
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS ai_approved BIGINT NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS ai_reasons TEXT');
      // Track-record columns: stop/targets carried from the approved idea,
      // outcome resolved by the 30-minute resolver (pending/win/loss/expired).
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS stop_price DOUBLE PRECISION');
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS targets TEXT');
      await client.query("ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'pending'");
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS resolved_at BIGINT');
      await client.query('ALTER TABLE strategy_signals ADD COLUMN IF NOT EXISTS resolved_price DOUBLE PRECISION');
      // Seed the signal universe once: BTC, ETH and SOL as core tier.
      // Mint addresses verified via CoinGecko detail_platforms (solana).
      const nowMs = Date.now();
      await client.query(
        `INSERT INTO strategy_universe (base_mint, symbol, coingecko_id, tier, active, created_at)
         VALUES
           ('cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', 'BTC', 'bitcoin', 'core', 1, $1),
           ('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', 'ETH', 'ethereum', 'core', 1, $1),
           ('So11111111111111111111111111111111111111112', 'SOL', 'solana', 'core', 1, $1)
         ON CONFLICT (base_mint) DO NOTHING`,
        [nowMs],
      );
      await runSeedImport();
    })();
    schemaReady.catch(() => { schemaReady = null; });
  }
  return schemaReady;
}

/**
 * Run one query against the pool, creating the schema on first use.
 * This is what repository functions call for single statements.
 *
 * Managed Postgres (Aiven) terminates idle connections server-side, so a
 * pooled client can be dead by the time it is checked out ("Connection
 * terminated unexpectedly"). pg evicts the dead client, so retrying the
 * same statement on a fresh connection is safe and turns a transient
 * blip into a success instead of a 500 or a dead worker. Retries apply
 * only to connection-level failures, never to query errors, and the
 * callers' statements are all idempotent (SELECTs, ON CONFLICT upserts).
 */
export async function query<T = Record<string, any>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const db = getPool();
  await ensureSchema(db);
  const res = await _queryWithRetry(() => db.query(text, params));
  return res.rows as T[];
}

/**
 * Run a statement and return the affected row count (INSERT/UPDATE/DELETE).
 * This is what repository functions call when they need to know whether
 * a write landed (claim-once semantics). Same connection-error retry as
 * query(): a dead pooled client is evicted and the statement is re-issued
 * on a fresh connection.
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const db = getPool();
  await ensureSchema(db);
  const res = await _queryWithRetry(() => db.query(text, params));
  return res.rowCount ?? 0;
}

/** True when err is a dead/broken connection, not a failed query. Exported for unit tests. */
export function _isConnectionError(err: unknown): boolean {
  const msg =
    err instanceof Error ? `${err.message} ${(err as { code?: unknown }).code ?? ''}` : String(err);
  return (
    /Connection terminated unexpectedly/i.test(msg) ||
    /Connection ended unexpectedly/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /terminating connection/i.test(msg) ||
    /server closed the connection/i.test(msg) ||
    /connection reset by peer/i.test(msg)
  );
}

/**
 * Run fn (one pooled query) with retries on connection-level failures.
 * Each failed attempt evicts one dead client from the pool, so a few
 * retries are enough even when the server killed every idle connection
 * at once. Gives up after MAX_QUERY_ATTEMPTS so a genuinely down
 * database still surfaces instead of hanging forever.
 */
const MAX_QUERY_ATTEMPTS = 5;

/** Exported as _queryWithRetry for unit tests. */
export async function _queryWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!_isConnectionError(err) || attempt === MAX_QUERY_ATTEMPTS) throw err;
      console.error(
        `[db] connection lost (attempt ${attempt}/${MAX_QUERY_ATTEMPTS}), retrying:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw lastErr;
}

/**
 * Run fn inside a transaction on a dedicated client: registry writes are
 * atomic, so a crash between the duplicate check and the insert can never
 * leave a half-written registry. Use the `db` handed to fn for every
 * statement inside, never getDb()/getPool() in there, or the statements
 * land on a different connection outside the transaction.
 */
export async function transaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await ensureSchema(client);
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

function testConnectionString(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/curv_test';
}

/** Test-only: the connection string the throwaway test schemas live under. */
export function _testConnectionString(): string {
  return testConnectionString();
}

/**
 * Test-only: point the singleton pool at a throwaway Postgres schema and
 * return its name. Each test file runs in its own worker (vitest forks),
 * so schemas never collide across files; within a file, beforeEach /
 * afterEach keeps tests isolated the way temp SQLite files used to.
 */
export async function _testUseDb(): Promise<string> {
  await _testCloseDb();
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: testConnectionString(), ssl: false, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  seedImportAllowed = false;
  pool = new Pool({
    connectionString: testConnectionString(),
    ssl: false,
    max: 1,
    options: `-c search_path="${schema}"`,
  });
  pool.on('error', () => {});
  testSchemaName = schema;
  schemaReady = null;
  await ensureSchema(pool);
  return schema;
}

/** Test-only: drop the throwaway schema and close the pool (idempotent). */
export async function _testCloseDb(): Promise<void> {
  const schema = testSchemaName;
  testSchemaName = null;
  seedImportAllowed = true;
  schemaReady = null;
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
  if (schema) {
    const admin = new Pool({ connectionString: testConnectionString(), ssl: false, max: 1 });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch { /* ignore */ }
    await admin.end().catch(() => {});
  }
}
