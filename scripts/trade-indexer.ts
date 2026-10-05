/**
 * Trade indexer.
 *
 * Watches every tracked pool for swaps and records per-wallet trades.
 * Poll-based v1: for each pool, fetches new transaction signatures via
 * getSignaturesForAddress, parses each transaction's token balance
 * deltas to identify the trader, side, and amounts, and appends to the
 * trades table. Powers the profile trade history and trader rewards.
 *
 * Trade detection uses balance deltas (program-agnostic): for each
 * signer wallet, base up + quote down = buy, base down + quote up = sell.
 * Only signers are considered, so pool vaults (PDAs, never sign) are
 * excluded by construction.
 *
 * Runs with plain `node` (Node 24 type stripping): imports only npm
 * packages, node builtins, and the dependency-free shared RPC failover
 * wrapper (../src/lib/rpc-failover.ts), never other repo source.
 *
 * Usage:
 *   DATABASE_URL=... SOLANA_RPC_URL=... node scripts/trade-indexer.ts
 *
 * Env:
 *   DATABASE_URL            Postgres (required, same as the app)
 *   SOLANA_RPC_URL | RPC    Solana RPC primary lane, Helius (required)
 *   ALCHEMY_RPC_URL         Solana RPC fallback lane, Alchemy (optional:
 *                           calls fail over to it automatically when the
 *                           primary lane degrades)
 *   TRADE_INDEXER_BACKFILL  Max txs to backfill per pool on first run (default 1000)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Pool as PgPool } from 'pg';
import { createFailoverConnection } from '../src/lib/rpc-failover.ts';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function requiredEnv(name: string, alt = ''): string {
  const v = env(name) || (alt ? env(alt) : '');
  if (!v) throw new Error(`[trade-indexer] ${name} is not set`);
  return v;
}

function log(...args: unknown[]): void {
  console.log('[trade-indexer]', ...args);
}

function warn(...args: unknown[]): void {
  console.warn('[trade-indexer]', ...args);
}

function makeDb(): PgPool {
  const url = requiredEnv('DATABASE_URL');
  const isLocal = /(^|[@/])(localhost|127\.0\.0\.1)([:/]|$)/.test(url);
  const isNeonPooler = /-pooler\./.test(url);
  const db = new PgPool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    ...(isNeonPooler ? {} : { options: '-c search_path=curv,public' }),
    max: 2,
    connectionTimeoutMillis: 10_000,
  });
  if (isNeonPooler) {
    const origConnect = db.connect.bind(db);
    db.connect = ((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: Error | null, client?: unknown, done?: () => void) => void)
        | undefined;
      const p = (async () => {
        const client = await (origConnect as () => Promise<unknown>)();
        try {
          await (client as { query: (q: string) => Promise<unknown> }).query('SET search_path = curv, public');
        } catch (err) {
          (client as { release: () => void }).release();
          throw err;
        }
        return client;
      })();
      if (cb) {
        p.then(
          (client: unknown) => (cb as (a: null, b: unknown, c: () => void) => void)(null, client, () => (client as { release: () => void }).release()),
          (err) => (cb as (a: Error) => void)(err as Error),
        );
        return undefined;
      }
      return p;
    }) as typeof db.connect;
  }
  return db;
}

interface ParsedTrade {
  wallet: string;
  side: 'buy' | 'sell';
  baseAmountRaw: string;
  quoteAmountRaw: string;
}

/**
 * Parse trades from a confirmed transaction via token balance deltas.
 * Only signer wallets are considered (pool vault PDAs never sign, so
 * they are excluded by construction). Returns one entry per trader.
 */
function parseTrades(
  tx: {
    meta: {
      err: unknown;
      preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }>;
      postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }>;
    } | null;
    transaction: { message: { getAccountKeys: () => { staticAccountKeys: PublicKey[] }; header: { numRequiredSignatures: number } } };
  },
  baseMint: string,
  quoteMint: string,
): ParsedTrade[] {
  if (!tx.meta || tx.meta.err) return [];
  const accountKeys = tx.transaction.message.getAccountKeys();
  const numSigners = tx.transaction.message.header.numRequiredSignatures;
  const signers = new Set(
    accountKeys.staticAccountKeys.slice(0, numSigners).map((k) => k.toBase58()),
  );

  // (accountIndex:mint) -> { pre, post, owner }
  const balances = new Map<string, { pre: bigint; post: bigint; owner: string }>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    const key = `${b.accountIndex}:${b.mint}`;
    const e = balances.get(key) ?? { pre: BigInt(0), post: BigInt(0), owner: b.owner ?? '' };
    e.pre = BigInt(b.uiTokenAmount.amount);
    if (b.owner) e.owner = b.owner;
    balances.set(key, e);
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    const key = `${b.accountIndex}:${b.mint}`;
    const e = balances.get(key) ?? { pre: BigInt(0), post: BigInt(0), owner: b.owner ?? '' };
    e.post = BigInt(b.uiTokenAmount.amount);
    if (b.owner) e.owner = b.owner;
    balances.set(key, e);
  }

  // owner -> { baseDelta, quoteDelta } (signers only)
  const deltas = new Map<string, { base: bigint; quote: bigint }>();
  // owner -> quoteDelta for non-signers (pool vaults). Fallback for native
  // SOL trades: the trader pays/receives lamports directly, so no wSOL token
  // account exists for the signer. The quote vault's delta mirrors the trade.
  const vaultQuote = new Map<string, bigint>();
  for (const [key, e] of balances) {
    const delta = e.post - e.pre;
    if (delta === BigInt(0) || !e.owner) continue;
    const mint = key.split(':')[1];
    if (mint !== baseMint && mint !== quoteMint) continue;
    if (signers.has(e.owner)) {
      const d = deltas.get(e.owner) ?? { base: BigInt(0), quote: BigInt(0) };
      if (mint === baseMint) d.base += delta;
      else d.quote += delta;
      deltas.set(e.owner, d);
    } else if (mint === quoteMint) {
      vaultQuote.set(e.owner, (vaultQuote.get(e.owner) ?? BigInt(0)) + delta);
    }
  }

  // The pool's quote vault: largest absolute non-signer quote delta.
  let vaultDelta = BigInt(0);
  const abs = (v: bigint) => (v < BigInt(0) ? -v : v);
  for (const v of vaultQuote.values()) {
    if (abs(v) > abs(vaultDelta)) vaultDelta = v;
  }

  const out: ParsedTrade[] = [];
  for (const [wallet, d] of deltas) {
    let quote = d.quote;
    if (quote === BigInt(0) && d.base !== BigInt(0) && vaultDelta !== BigInt(0)) {
      const aligned =
        (d.base > BigInt(0) && vaultDelta > BigInt(0)) ||
        (d.base < BigInt(0) && vaultDelta < BigInt(0));
      // Trader's side mirrors the vault's.
      if (aligned) quote = -vaultDelta;
    }
    if (d.base > BigInt(0) && quote < BigInt(0)) {
      out.push({ wallet, side: 'buy', baseAmountRaw: d.base.toString(), quoteAmountRaw: (-quote).toString() });
    } else if (d.base < BigInt(0) && quote > BigInt(0)) {
      out.push({ wallet, side: 'sell', baseAmountRaw: (-d.base).toString(), quoteAmountRaw: quote.toString() });
    }
  }
  return out;
}

async function indexPool(
  connection: Connection,
  db: PgPool,
  pool: { poolAddress: string; baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number },
  backfillLimit: number,
): Promise<{ found: number; recorded: number }> {
  const tag = pool.poolAddress.slice(0, 8);
  const poolPk = new PublicKey(pool.poolAddress);

  const cur = await db.connect();
  let lastSig: string | null = null;
  try {
    await cur.query('SET search_path = curv, public');
    const r = await cur.query('SELECT last_signature FROM trade_indexer_state WHERE pool_address = $1', [pool.poolAddress]);
    lastSig = r.rows[0]?.last_signature ?? null;
  } finally {
    cur.release();
  }

  // Fetch signatures newer than the cursor (or the most recent page for backfill).
  const sigs = await connection.getSignaturesForAddress(poolPk, {
    until: lastSig ?? undefined,
    limit: lastSig ? 1000 : backfillLimit,
  });
  if (sigs.length === 0) return { found: 0, recorded: 0 };

  // Process oldest-first so the cursor always moves forward.
  const ordered = [...sigs].reverse();
  let recorded = 0;
  for (const s of ordered) {
    if (s.err) continue; // Skip failed transactions.
    try {
      const tx = await connection.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;
      const trades = parseTrades(
        tx as Parameters<typeof parseTrades>[0],
        pool.baseMint,
        pool.quoteMint,
      );
      for (const t of trades) {
        // Human-readable price: quote per base unit.
        const baseUnits = Number(t.baseAmountRaw) / 10 ** pool.baseDecimals;
        const quoteUnits = Number(t.quoteAmountRaw) / 10 ** pool.quoteDecimals;
        const price = baseUnits > 0 ? (quoteUnits / baseUnits).toString() : null;
        const r = await db.query(
          `INSERT INTO trades (pool_address, wallet, side, base_amount_raw, quote_amount_raw, price, tx_signature, slot, traded_at, base_decimals, quote_decimals)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tx_signature, wallet) DO NOTHING`,
          [pool.poolAddress, t.wallet, t.side, t.baseAmountRaw, t.quoteAmountRaw, price, s.signature, s.slot, tx.blockTime * 1000, pool.baseDecimals, pool.quoteDecimals],
        );
        if ((r.rowCount ?? 0) > 0) recorded++;
      }
    } catch (e) {
      warn(`${tag}: tx ${s.signature.slice(0, 8)} parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Advance the cursor to the newest seen signature.
  const newest = sigs[0].signature;
  await db.query(
    `INSERT INTO trade_indexer_state (pool_address, last_signature, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (pool_address) DO UPDATE SET last_signature = $2, updated_at = $3`,
    [pool.poolAddress, newest, Date.now()],
  );
  log(`${tag}: ${sigs.length} new txs, ${recorded} trades recorded`);
  return { found: sigs.length, recorded };
}

async function main(): Promise<void> {
  const backfillLimit = Number(env('TRADE_INDEXER_BACKFILL', '1000')) || 1000;
  // Shared failover connection: Helius primary, Alchemy fallback when
  // ALCHEMY_RPC_URL is set. Throws a clear error when no lane is configured.
  const connection = createFailoverConnection();
  const db = makeDb();
  try {
    // Ensure schema exists (same DDL the app runs on boot).
    const setup = await db.connect();
    try {
      await setup.query('SET search_path = curv, public');
      await setup.query(`CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY, pool_address TEXT NOT NULL, wallet TEXT NOT NULL,
        side TEXT NOT NULL, base_amount_raw TEXT NOT NULL, quote_amount_raw TEXT NOT NULL,
        price NUMERIC, tx_signature TEXT NOT NULL, slot BIGINT, traded_at BIGINT NOT NULL,
        base_decimals INTEGER, quote_decimals INTEGER,
        UNIQUE (tx_signature, wallet))`);
      await setup.query('CREATE INDEX IF NOT EXISTS idx_trades_pool_time ON trades (pool_address, traded_at DESC)');
      await setup.query('CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades (wallet, traded_at DESC)');
      await setup.query(`CREATE TABLE IF NOT EXISTS trade_indexer_state (
        pool_address TEXT PRIMARY KEY, last_signature TEXT NOT NULL, updated_at BIGINT NOT NULL)`);
    } finally {
      setup.release();
    }

    const { rows } = await db.query(
      `SELECT pool_address AS "poolAddress", base_mint AS "baseMint", quote_mint AS "quoteMint"
       FROM pools`,
    );
    log(`${rows.length} pool(s) to index`);
    // Decimals: needed for display price. Fetch once per unique mint.
    const decimalsCache = new Map<string, number>();
    const getDecimals = async (mint: string): Promise<number> => {
      const hit = decimalsCache.get(mint);
      if (hit !== undefined) return hit;
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mint));
        const data = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info;
        const d = typeof data?.decimals === 'number' ? data.decimals : 9;
        decimalsCache.set(mint, d);
        return d;
      } catch {
        decimalsCache.set(mint, 9);
        return 9;
      }
    };
    let totalFound = 0;
    let totalRecorded = 0;
    for (const pool of rows as Array<{ poolAddress: string; baseMint: string; quoteMint: string }>) {
      try {
        const [bd, qd] = await Promise.all([getDecimals(pool.baseMint), getDecimals(pool.quoteMint)]);
        const r = await indexPool(connection, db, { ...pool, baseDecimals: bd, quoteDecimals: qd }, backfillLimit);
        totalFound += r.found;
        totalRecorded += r.recorded;
      } catch (e) {
        warn(`${pool.poolAddress.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(`done: ${totalFound} txs scanned, ${totalRecorded} trades recorded`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('[trade-indexer] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
