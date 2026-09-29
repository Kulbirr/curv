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
  verified BIGINT NOT NULL DEFAULT 0
);

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

function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  // Local dev Postgres instances don't speak SSL; managed hosts (Aiven
  // and the like) require it. The connection is still encrypted whenever
  // the server demands it.
  if (/(^|[@/])(localhost|127\.0\.0\.1)([:/]|$)/.test(url)) return false;
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
      await runSeedImport();
    })();
    schemaReady.catch(() => { schemaReady = null; });
  }
  return schemaReady;
}

/**
 * Run one query against the pool, creating the schema on first use.
 * This is what repository functions call for single statements.
 */
export async function query<T = Record<string, any>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const db = getPool();
  await ensureSchema(db);
  const res = await db.query(text, params);
  return res.rows as T[];
}

/**
 * Run a statement and return the affected row count (INSERT/UPDATE/DELETE).
 * This is what repository functions call when they need to know whether
 * a write landed (claim-once semantics).
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const db = getPool();
  await ensureSchema(db);
  const res = await db.query(text, params);
  return res.rowCount ?? 0;
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
