import { Pool, types as pgTypes, type PoolClient } from 'pg';
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
-- idx_ticks_pool_ts removed: byte-identical to the ticks PK (pool_address, ts).
-- The tick pruner deletes by ts alone, which the PK cannot serve:
CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks (ts);

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

-- Mint search (header search by pasted address) must not seq-scan pools.
CREATE INDEX IF NOT EXISTS idx_pools_base_mint ON pools (base_mint);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

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

-- Buyback deposit ledger. Append-only: one row per verified buyback
-- slice that landed in the vault. The keeper needs per-pool attribution
-- because the vault is one shared wallet: without this ledger, two
-- pools on the same quote mint would cannibalize one shared balance
-- in undefined order. Deposits are recorded through the deposit API,
-- which verifies the transfer on-chain from the claim transaction, so
-- the client cannot inflate its pool's budget. Immutable once written.
CREATE TABLE IF NOT EXISTS buyback_deposits (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyback_deposits_pool ON buyback_deposits (pool_address);

-- Per-wallet trade ledger. One row per (transaction, trader): the
-- trade indexer watches every pool for swaps and records who traded,
-- which side, and how much, via on-chain balance deltas. Powers the
-- profile trade history and the trader rewards (top net buyers).
-- Append-only, deduplicated on tx_signature. Immutable once written.
CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  wallet TEXT NOT NULL,
  side TEXT NOT NULL, -- 'buy' or 'sell'
  base_amount_raw TEXT NOT NULL,
  quote_amount_raw TEXT NOT NULL,
  price NUMERIC, -- quote per base unit, human-readable, for display
  tx_signature TEXT NOT NULL,
  slot BIGINT,
  traded_at BIGINT NOT NULL,
  base_decimals INTEGER,
  quote_decimals INTEGER,
  UNIQUE (tx_signature, wallet)
);
CREATE INDEX IF NOT EXISTS idx_trades_pool_time ON trades (pool_address, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades (wallet, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_pool ON trades (wallet, pool_address, id DESC);

-- Trade origin: 'dbc' = bonding curve indexer, 'jupiter' = post graduation
-- verified record. Additive; existing rows default to 'dbc'.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dbc';

-- Trade indexer cursor: the last processed signature per pool, so each
-- run only fetches new transactions.
CREATE TABLE IF NOT EXISTS trade_indexer_state (
  pool_address TEXT PRIMARY KEY,
  last_signature TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Dev wallet balance snapshots. Catches off-curve transfers: the trades
-- table only records swaps through the curve, so a dev who sends tokens
-- directly to another wallet is invisible to trade-watching but visible
-- as a balance delta between snapshots. Written by the trade indexer,
-- throttled to one row per (pool, wallet) per 5 minutes.
CREATE TABLE IF NOT EXISTS dev_wallet_snapshots (
  pool_address TEXT NOT NULL,
  wallet TEXT NOT NULL,
  balance_raw TEXT NOT NULL,
  taken_at BIGINT NOT NULL,
  PRIMARY KEY (pool_address, wallet, taken_at)
);
CREATE INDEX IF NOT EXISTS idx_dev_snapshots_lookup
  ON dev_wallet_snapshots (pool_address, wallet, taken_at DESC);

-- Trader reward winners. One row per pool, written once at graduation:
-- the top N net buyers by quote volume, immutable after. The rule
-- (count, bps) was locked at launch in pools.trader_reward; this table
-- is the deterministic resolution of that rule from the trades ledger.
CREATE TABLE IF NOT EXISTS trader_reward_winners (
  pool_address TEXT PRIMARY KEY,
  winners TEXT NOT NULL, -- JSON: [{wallet, netVolumeRaw, rank}]
  decided_at BIGINT NOT NULL
);

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
-- Social platform behind a Twitch/Reddit OAuth binding ('twitch' or
-- 'reddit'). Null for wallet and X tweet bindings, which predate it.
ALTER TABLE fee_split_bindings ADD COLUMN IF NOT EXISTS platform TEXT;

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

-- Ops alert log for production monitoring. Alerts are raised on
-- healthy -> unhealthy transitions (deduped while unresolved) and
-- auto-resolved on recovery. The scheduled health-check worker reads
-- unresolved rows via /api/status; no PII, just kind + message.
CREATE TABLE IF NOT EXISTS ops_alerts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_kind ON ops_alerts (kind, resolved_at, created_at DESC);

-- Shill-to-Earn bounties: creators fund prize pools from their fee
-- share; anyone posts about the token on X with a hashtag, gets ranked
-- by engagement, and winners are paid to their X handle. One row per
-- bounty round.
CREATE TABLE IF NOT EXISTS bounties (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  creator_wallet TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  hashtag TEXT NOT NULL,
  keyword TEXT,
  prize_budget_raw TEXT NOT NULL,
  prize_mint TEXT NOT NULL,
  winner_count INTEGER NOT NULL,
  prize_splits TEXT NOT NULL,
  weight_likes INTEGER NOT NULL DEFAULT 1,
  weight_retweets INTEGER NOT NULL DEFAULT 3,
  weight_replies INTEGER NOT NULL DEFAULT 2,
  weight_views INTEGER NOT NULL DEFAULT 0,
  starts_at BIGINT NOT NULL,
  ends_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  finalized_at BIGINT,
  CONSTRAINT chk_bounty_winner_count CHECK (winner_count BETWEEN 1 AND 20),
  CONSTRAINT chk_bounty_status CHECK (status IN ('active','finalizing','finalized','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_bounties_pool ON bounties (pool_address, status);
CREATE INDEX IF NOT EXISTS idx_bounties_ends ON bounties (ends_at) WHERE status = 'active';

-- Bounty entries: one row per submitted tweet. The author handle is
-- server-verified from the tweet itself, never from user input. One
-- entry per handle per round: a second tweet from the same handle
-- replaces the first (keeps earliest submitted_at).
CREATE TABLE IF NOT EXISTS bounty_entries (
  id SERIAL PRIMARY KEY,
  bounty_id INTEGER NOT NULL REFERENCES bounties(id),
  tweet_id TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_handle_display TEXT NOT NULL,
  tweet_text TEXT NOT NULL,
  submitted_at BIGINT NOT NULL,
  disqualified BOOLEAN NOT NULL DEFAULT FALSE,
  disqualify_reason TEXT,
  UNIQUE (bounty_id, tweet_id),
  UNIQUE (bounty_id, author_handle)
);
CREATE INDEX IF NOT EXISTS idx_bounty_entries_bounty ON bounty_entries (bounty_id, disqualified);

-- Engagement snapshots, append-only. The keeper takes them on a
-- cadence; the leaderboard reads the latest per entry. History makes
-- the ranking auditable and sudden spikes visible.
CREATE TABLE IF NOT EXISTS bounty_snapshots (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES bounty_entries(id),
  likes INTEGER NOT NULL,
  retweets INTEGER NOT NULL,
  replies INTEGER NOT NULL,
  views INTEGER NOT NULL,
  score NUMERIC NOT NULL,
  taken_at BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'fxtwitter'
);
CREATE INDEX IF NOT EXISTS idx_bounty_snapshots_entry ON bounty_snapshots (entry_id, taken_at DESC);

-- Bounty winners: immutable once written. bound_wallet is set when the
-- winner binds via tweet verification; claimed_at when the keeper pays.
CREATE TABLE IF NOT EXISTS bounty_winners (
  id SERIAL PRIMARY KEY,
  bounty_id INTEGER NOT NULL REFERENCES bounties(id),
  entry_id INTEGER NOT NULL REFERENCES bounty_entries(id) UNIQUE,
  author_handle TEXT NOT NULL,
  rank INTEGER NOT NULL,
  prize_raw TEXT NOT NULL,
  bound_wallet TEXT,
  claimed_at BIGINT,
  payout_tx TEXT,
  UNIQUE (bounty_id, rank)
);
CREATE INDEX IF NOT EXISTS idx_bounty_winners_handle ON bounty_winners (author_handle) WHERE claimed_at IS NULL;

-- Bounty vault funding ledger. Append-only: one row per verified bounty
-- slice that landed in the vault from a creator claim. Mirrors
-- buyback_deposits: the vault is shared across pools, so per-pool
-- attribution lives here, verified on-chain by the deposit API.
CREATE TABLE IF NOT EXISTS bounty_deposits (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bounty_deposits_pool ON bounty_deposits (pool_address);

-- Bounty payout ledger, append-only: one row per paid winner.
CREATE TABLE IF NOT EXISTS bounty_payouts (
  id SERIAL PRIMARY KEY,
  winner_id INTEGER NOT NULL REFERENCES bounty_winners(id) UNIQUE,
  amount_raw TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  paid_at BIGINT NOT NULL
);

-- Coin duels: head to head graduation races. Terms are locked at
-- accept time and immutable after. One active or challenged duel per
-- pool at a time, enforced by the application (checked before
-- insert; a partial unique index cannot express the state filter
-- cleanly across six statuses, so the check lives in createDuel).
CREATE TABLE IF NOT EXISTS duels (
  id SERIAL PRIMARY KEY,
  pool_a TEXT NOT NULL,
  pool_b TEXT NOT NULL,
  challenger_wallet TEXT NOT NULL,
  challenged_wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'challenged',
  forfeit_scope TEXT NOT NULL DEFAULT 'creator_remainder_window',
  forfeit_days INTEGER NOT NULL DEFAULT 90,
  created_at BIGINT NOT NULL,
  activated_at BIGINT,
  expires_at BIGINT,
  settled_at BIGINT,
  forfeit_ends_at BIGINT,
  winner_pool TEXT,
  loser_pool TEXT,
  CONSTRAINT chk_duel_pools CHECK (pool_a <> pool_b),
  CONSTRAINT chk_duel_status CHECK (status IN
    ('challenged','active','settled','expired','cancelled','drawn')),
  CONSTRAINT chk_duel_forfeit_days CHECK (forfeit_days BETWEEN 1 AND 365)
);
CREATE INDEX IF NOT EXISTS idx_duels_pool_a ON duels (pool_a, status);
CREATE INDEX IF NOT EXISTS idx_duels_pool_b ON duels (pool_b, status);
CREATE INDEX IF NOT EXISTS idx_duels_active ON duels (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_duels_challenged_wallet ON duels (challenged_wallet, status)
  WHERE status = 'challenged';

-- Duel forfeit payout ledger, append-only: one row per redirected
-- claim from the losing pool. Mirrors bounty_deposits: the forfeit is
-- realized inside the loser's claim transaction, and this table is the
-- auditable record the duel page renders.
CREATE TABLE IF NOT EXISTS duel_forfeit_payouts (
  id SERIAL PRIMARY KEY,
  duel_id INTEGER NOT NULL REFERENCES duels(id),
  pool_address TEXT NOT NULL,
  winner_wallet TEXT NOT NULL,
  base_amount_raw TEXT NOT NULL,
  quote_amount_raw TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  paid_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_duel_forfeit_duel ON duel_forfeit_payouts (duel_id, paid_at DESC);

-- First-seen graduation timestamp per pool, written by the pool state
-- indexer the first time it records graduated = 1. Lets the duel
-- keeper answer "who graduated first" from the DB alone.
ALTER TABLE pool_states ADD COLUMN IF NOT EXISTS graduated_at BIGINT;
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
    // Neon's pooled connections reject the `options` startup parameter
    // (unsupported startup parameter in options). Detect the pooler
    // hostname and set search_path per-client instead.
    const isNeonPooler = /-pooler\./.test(cs);
    pool = new Pool({
      connectionString: cs,
      ssl: sslFor(cs),
      // Curv tables live in the curv schema (shared host); unqualified
      // names resolve there first, public stays untouched.
      // Skipped on Neon pooler (it rejects `options`); search_path is set
      // via SET on each new client below instead.
      ...(isNeonPooler ? {} : { options: '-c search_path=curv,public' }),
      // Small pool: serverless instances multiply connections, and
      // managed Postgres tiers cap them. PG_IDLE_TIMEOUT_MS lets
      // long-lived workers (e.g. the vanity grinder) keep connections
      // warm instead of churning them; defaults to 10s.
      max: numEnv('PG_POOL_MAX', 5),
      idleTimeoutMillis: numEnv('PG_IDLE_TIMEOUT_MS', 10_000),
      connectionTimeoutMillis: 10_000,
    });
    if (isNeonPooler) {
      // Neon's pooler rejects the `options` startup parameter, so search_path
      // cannot be set at connection time. A fire-and-forget
      // `pool.on('connect')` SET is NOT enough: a query issued immediately
      // after checkout can run before the async SET completes. (This exact
      // race once made a seed import see an empty `pools` table and write
      // junk rows into `public`.) Wrap connect() so every checkout awaits
      // `SET search_path` before the client is handed out. pool.query()
      // routes through connect() internally, so this covers all query paths,
      // and re-setting on every checkout also survives the pooler discarding
      // session state between checkouts.
      const origConnect = pool.connect.bind(pool);
      pool.connect = ((...args: unknown[]) => {
        const cb = args.find((a) => typeof a === 'function') as
          | ((err: Error | null, client?: PoolClient, done?: () => void) => void)
          | undefined;
        const p: Promise<PoolClient> = (async () => {
          const client = (await (
            origConnect as () => Promise<PoolClient>
          )()) as PoolClient;
          try {
            await client.query('SET search_path = curv, public');
          } catch (err) {
            client.release();
            throw err;
          }
          return client;
        })();
        if (cb) {
          p.then(
            (client) => cb(null, client, () => client.release()),
            (err) => cb(err as Error),
          );
          return undefined;
        }
        return p;
      }) as typeof pool.connect;
    }
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
      // Shill-to-Earn bounties: basis points (0-10000) of the creator fee
      // share committed to bounty prize funding at launch. Immutable.
      // buyback_bps + bounty_bps <= 10000 is enforced at registration.
      await client.query('ALTER TABLE pools ADD COLUMN IF NOT EXISTS bounty_bps INTEGER NOT NULL DEFAULT 0');
      // Trader rewards: JSON {count, bps, rule} reserving a share of
      // creator fees for the top net buyers, decided at graduation.
      // Immutable once set at launch. Null = feature off.
      await client.query('ALTER TABLE pools ADD COLUMN IF NOT EXISTS trader_reward TEXT');
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
