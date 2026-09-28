import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

/**
 * Central data-access layer for StockCurve's read model.
 *
 * Why this exists: every user-facing API used to read Solana RPC once per
 * pool per request, so user count multiplied RPC load. Now a single
 * background indexer (src/indexer.ts) samples each pool once per interval
 * and persists the result here; APIs serve indexed rows and make zero
 * live RPC calls per user request.
 *
 * Repository interface over SQLite today. The SQL is deliberately kept in
 * the portable subset shared with Postgres so the store can be swapped
 * without touching call sites:
 *   - `INSERT ... ON CONFLICT (...) DO UPDATE` upserts (valid in
 *     SQLite >= 3.24 and in Postgres)
 *   - INTEGER unix-millisecond timestamps, INTEGER 0/1 booleans, no
 *     SQLite-only date functions
 *   - TEXT primary keys (pool addresses, signatures), no AUTOINCREMENT
 *   - No RETURNING, no window functions, no partial-index tricks
 * Postgres mapping: TEXT -> TEXT, INTEGER -> BIGINT, REAL -> DOUBLE PRECISION.
 * The only SQLite-specific statements are the PRAGMAs below (WAL mode,
 * busy timeout), which a Postgres port simply drops.
 *
 * Tables:
 *   pools              — the pool registry (replaces data/pools.json)
 *   pool_states        — latest successfully sampled on-chain state per pool
 *   ticks              — price/reserve samples feeding charts + estimates
 *   nonces             — single-use registration signatures (replay protection)
 *   pool_verifications — per-pool verification state
 *   rate_limits        — DB-backed fixed-window rate limit counters
 *   vanity_pool        — pre-ground "...curv" mint keypairs for instant launch
 *                        (secrets encrypted at rest; wiped on handout)
 */

export const DATA_DIR = path.join(process.cwd(), 'data');
export const DB_PATH = path.join(DATA_DIR, 'stockcurve.db');

const SCHEMA = `
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
  created_at INTEGER NOT NULL,
  launched_at INTEGER,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pool_states (
  pool_address TEXT PRIMARY KEY,
  price REAL,
  quote_reserve REAL,
  base_reserve REAL,
  progress REAL,
  graduated INTEGER NOT NULL DEFAULT 0,
  has_swap INTEGER NOT NULL DEFAULT 0,
  market_cap REAL,
  base_decimals INTEGER NOT NULL DEFAULT 9,
  quote_decimals INTEGER NOT NULL DEFAULT 9,
  migration_quote_threshold REAL,
  creator_base_fee_raw TEXT,
  creator_quote_fee_raw TEXT,
  sampled_at INTEGER,
  last_attempt_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticks (
  pool_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  quote_reserve REAL,
  PRIMARY KEY (pool_address, ts)
);
CREATE INDEX IF NOT EXISTS idx_ticks_pool_ts ON ticks (pool_address, ts);

CREATE TABLE IF NOT EXISTS nonces (
  signature TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_created ON nonces (created_at);

CREATE TABLE IF NOT EXISTS pool_verifications (
  pool_address TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vanity_pool (
  pubkey TEXT PRIMARY KEY,
  secret_encrypted BLOB,
  created_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vanity_pool_ready ON vanity_pool (consumed, created_at);
`;

let db: DatabaseSync | null = null;
let migrated = false;

/**
 * Additive schema migrations for databases created before a column
 * existed. Each ALTER is wrapped so re-running (or a fresh DB that
 * already has the column via SCHEMA) is a no-op. Portable subset:
 * ADD COLUMN is valid in both SQLite and Postgres.
 */
function runSchemaMigrations(d: DatabaseSync): void {
  const alters = [
    'ALTER TABLE pool_states ADD COLUMN creator_base_fee_raw TEXT',
    'ALTER TABLE pool_states ADD COLUMN creator_quote_fee_raw TEXT',
  ];
  for (const sql of alters) {
    try {
      d.exec(sql);
    } catch {
      // Column already exists (or table missing on a fresh path) — ignore.
    }
  }
}

function sqliteQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One-time migration of the legacy stores into the unified database:
 *  - data/pools.json  -> pools table (then renamed to pools.json.migrated)
 *  - data/prices.db   -> ticks table via ATTACH (then renamed to .migrated)
 * Both run only when the destination table is empty, so a restart never
 * duplicates or clobbers indexed data.
 */
function runLegacyMigrations(d: DatabaseSync): void {
  if (migrated) return;
  migrated = true;

  const poolCount = (d.prepare('SELECT COUNT(*) AS c FROM pools').get() as { c: number }).c;
  const legacyRegistry = path.join(DATA_DIR, 'pools.json');
  if (poolCount === 0 && fs.existsSync(legacyRegistry)) {
    try {
      const raw = fs.readFileSync(legacyRegistry, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [];
      const insert = d.prepare(
        `INSERT OR IGNORE INTO pools
         (pool_address, config_address, base_mint, quote_mint, base_symbol, base_name,
          quote_symbol, description, image_url, website, twitter, creator,
          created_at, launched_at, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      d.exec('BEGIN IMMEDIATE');
      try {
        for (const e of entries as Array<Record<string, unknown>>) {
          const str = (v: unknown) => (typeof v === 'string' ? v : '');
          insert.run(
            str(e.poolAddress),
            str(e.configAddress),
            str(e.baseMint),
            str(e.quoteMint),
            str(e.baseSymbol),
            str(e.baseName),
            str(e.quoteSymbol),
            typeof e.description === 'string' ? e.description : null,
            typeof e.imageUrl === 'string' ? e.imageUrl : null,
            typeof e.website === 'string' ? e.website : null,
            typeof e.twitter === 'string' ? e.twitter : null,
            str(e.creator),
            typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
            typeof e.launchedAt === 'number' ? e.launchedAt : null,
            e.verified === true ? 1 : 0,
          );
        }
        d.exec('COMMIT');
      } catch (err) {
        try { d.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      fs.renameSync(legacyRegistry, `${legacyRegistry}.migrated`);
      console.log(`[db] migrated ${entries.length} pool(s) from pools.json`);
    } catch (err) {
      console.log('[db] pools.json migration skipped:', err instanceof Error ? err.message : err);
    }
  }

  const tickCount = (d.prepare('SELECT COUNT(*) AS c FROM ticks').get() as { c: number }).c;
  const legacyPrices = path.join(DATA_DIR, 'prices.db');
  if (tickCount === 0 && fs.existsSync(legacyPrices)) {
    try {
      d.exec(`ATTACH ${sqliteQuoteLiteral(legacyPrices)} AS legacy`);
      try {
        d.exec(
          `INSERT OR IGNORE INTO ticks (pool_address, ts, price, quote_reserve)
           SELECT pool_address, ts, price, quote_reserve FROM legacy.ticks`,
        );
      } finally {
        d.exec('DETACH legacy');
      }
      const moved = (d.prepare('SELECT COUNT(*) AS c FROM ticks').get() as { c: number }).c;
      fs.renameSync(legacyPrices, `${legacyPrices}.migrated`);
      console.log(`[db] migrated ${moved} tick(s) from prices.db`);
    } catch (err) {
      console.log('[db] prices.db migration skipped:', err instanceof Error ? err.message : err);
    }
  }
}

export function getDb(): DatabaseSync {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    // SQLite-only pragmas: WAL lets the indexer (writer) and the Next.js
    // API routes (readers) share the file without lock contention.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    runSchemaMigrations(db);
    runLegacyMigrations(db);
  }
  return db;
}

/**
 * Run fn inside an IMMEDIATE transaction: registry writes are atomic, so
 * a crash between the duplicate check and the insert can never leave a
 * half-written registry.
 */
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Test-only: point the singleton at a throwaway database file and return
 * it. Closes any previously open database first. Legacy migrations are
 * skipped so tests never touch the real data/ directory.
 *
 * Every test file must call _testCloseDb() (and delete its temp file) when
 * done; vitest isolates modules per test file, so one file's override
 * cannot leak into another's.
 */
export function _testUseDb(dbPath: string): DatabaseSync {
  _testCloseDb();
  migrated = true; // skip legacy migrations in tests
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Test-only: close the singleton database (idempotent). */
export function _testCloseDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
  migrated = false;
}
