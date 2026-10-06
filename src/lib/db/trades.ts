import { execute, query } from './index';

export interface Trade {
  id: number;
  poolAddress: string;
  wallet: string;
  side: 'buy' | 'sell';
  baseAmountRaw: string;
  quoteAmountRaw: string;
  price: string | null;
  txSignature: string;
  slot: number | null;
  tradedAt: number;
  baseDecimals: number | null;
  quoteDecimals: number | null;
  /** 'dbc' = bonding curve indexer, 'jupiter' = post graduation verified record. */
  source: 'dbc' | 'jupiter';
}

/**
 * Storage half of the trade indexer. One row per (transaction, trader),
 * append-only, deduplicated on tx_signature. Powers the profile trade
 * history and the trader rewards winner computation.
 */

export async function recordTrade(args: {
  poolAddress: string;
  wallet: string;
  side: 'buy' | 'sell';
  baseAmountRaw: string;
  quoteAmountRaw: string;
  price: string | null;
  txSignature: string;
  slot: number | null;
  tradedAt: number;
  baseDecimals?: number | null;
  quoteDecimals?: number | null;
  /** 'dbc' = bonding curve indexer, 'jupiter' = post graduation verified record. */
  source?: 'dbc' | 'jupiter';
}): Promise<boolean> {
  if (args.side !== 'buy' && args.side !== 'sell') {
    throw new Error('trade side must be buy or sell');
  }
  const rowCount = await execute(
    `INSERT INTO trades (pool_address, wallet, side, base_amount_raw, quote_amount_raw, price, tx_signature, slot, traded_at, base_decimals, quote_decimals, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (tx_signature, wallet) DO NOTHING`,
    [
      args.poolAddress,
      args.wallet,
      args.side,
      args.baseAmountRaw,
      args.quoteAmountRaw,
      args.price,
      args.txSignature,
      args.slot,
      args.tradedAt,
      args.baseDecimals ?? null,
      args.quoteDecimals ?? null,
      args.source ?? 'dbc',
    ],
  );
  return rowCount === 1;
}

function toTrade(r: {
  id: number;
  pool_address: string;
  wallet: string;
  side: string;
  base_amount_raw: string;
  quote_amount_raw: string;
  price: string | null;
  tx_signature: string;
  slot: number | null;
  traded_at: number;
  base_decimals: number | null;
  quote_decimals: number | null;
  source: string | null;
}): Trade {
  return {
    id: r.id,
    poolAddress: r.pool_address,
    wallet: r.wallet,
    side: r.side as 'buy' | 'sell',
    baseAmountRaw: r.base_amount_raw,
    quoteAmountRaw: r.quote_amount_raw,
    price: r.price,
    txSignature: r.tx_signature,
    slot: r.slot,
    tradedAt: r.traded_at,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    source: r.source === 'jupiter' ? 'jupiter' : 'dbc',
  };
}

const TRADE_COLS =
  'id, pool_address, wallet, side, base_amount_raw, quote_amount_raw, price, tx_signature, slot, traded_at, base_decimals, quote_decimals, source';

/** A wallet's trades, newest first, paginated. */
export async function getTradesForWallet(
  wallet: string,
  limit = 50,
  beforeId?: number,
): Promise<Trade[]> {
  const rows = await query<Parameters<typeof toTrade>[0]>(
    `SELECT ${TRADE_COLS} FROM trades WHERE wallet = $1 ${beforeId ? 'AND id < $3' : ''}
     ORDER BY id DESC LIMIT $2`,
    beforeId ? [wallet, limit, beforeId] : [wallet, limit],
  );
  return rows.map(toTrade);
}

/** A pool's trades, newest first, paginated. */
export async function getTradesForPool(
  poolAddress: string,
  limit = 50,
  beforeId?: number,
): Promise<Trade[]> {
  const rows = await query<Parameters<typeof toTrade>[0]>(
    `SELECT ${TRADE_COLS} FROM trades WHERE pool_address = $1 ${beforeId ? 'AND id < $3' : ''}
     ORDER BY id DESC LIMIT $2`,
    beforeId ? [poolAddress, limit, beforeId] : [poolAddress, limit],
  );
  return rows.map(toTrade);
}

export interface WalletPoolSummary {
  poolAddress: string;
  totalBoughtBaseRaw: string;
  totalBoughtQuoteRaw: string;
  totalSoldBaseRaw: string;
  totalSoldQuoteRaw: string;
  tradeCount: number;
  baseDecimals: number | null;
  quoteDecimals: number | null;
}

/** Per-pool buy/sell totals for a wallet: the aggregated profile view. */
export async function getWalletPoolSummaries(wallet: string): Promise<WalletPoolSummary[]> {
  const rows = await query<{
    pool_address: string;
    bought_base: string | null;
    bought_quote: string | null;
    sold_base: string | null;
    sold_quote: string | null;
    trade_count: string;
    base_decimals: number | null;
    quote_decimals: number | null;
  }>(
    `SELECT pool_address,
            SUM(CASE WHEN side = 'buy' THEN base_amount_raw::numeric ELSE 0 END) AS bought_base,
            SUM(CASE WHEN side = 'buy' THEN quote_amount_raw::numeric ELSE 0 END) AS bought_quote,
            SUM(CASE WHEN side = 'sell' THEN base_amount_raw::numeric ELSE 0 END) AS sold_base,
            SUM(CASE WHEN side = 'sell' THEN quote_amount_raw::numeric ELSE 0 END) AS sold_quote,
            COUNT(*) AS trade_count,
            MAX(base_decimals) AS base_decimals,
            MAX(quote_decimals) AS quote_decimals
     FROM trades WHERE wallet = $1 GROUP BY pool_address ORDER BY MAX(traded_at) DESC`,
    [wallet],
  );
  return rows.map((r) => ({
    poolAddress: r.pool_address,
    totalBoughtBaseRaw: r.bought_base ? BigInt(r.bought_base).toString() : '0',
    totalBoughtQuoteRaw: r.bought_quote ? BigInt(r.bought_quote).toString() : '0',
    totalSoldBaseRaw: r.sold_base ? BigInt(r.sold_base).toString() : '0',
    totalSoldQuoteRaw: r.sold_quote ? BigInt(r.sold_quote).toString() : '0',
    tradeCount: Number(r.trade_count),
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
  }));
}

/**
 * Net buy volume per wallet for a pool, in quote raw units: total bought
 * minus total sold. Only positive nets rank. Used for trader rewards.
 * Excluded wallets (creator, fee wallet, vault) are filtered by the caller.
 */
export async function getNetBuyVolumes(
  poolAddress: string,
): Promise<Array<{ wallet: string; netQuoteRaw: string }>> {
  const rows = await query<{ wallet: string; net_quote: string | null }>(
    `SELECT wallet,
            SUM(CASE WHEN side = 'buy' THEN quote_amount_raw::numeric ELSE -quote_amount_raw::numeric END) AS net_quote
     FROM trades WHERE pool_address = $1 GROUP BY wallet HAVING SUM(CASE WHEN side = 'buy' THEN quote_amount_raw::numeric ELSE -quote_amount_raw::numeric END) > 0
     ORDER BY net_quote DESC`,
    [poolAddress],
  );
  return rows.map((r) => ({
    wallet: r.wallet,
    netQuoteRaw: r.net_quote ? BigInt(r.net_quote).toString() : '0',
  }));
}

/** A wallet's trades on one pool, newest first, paginated. */
export async function getTradesForWalletAndPool(
  wallet: string,
  poolAddress: string,
  limit = 25,
  beforeId?: number,
): Promise<Trade[]> {
  const rows = await query<Parameters<typeof toTrade>[0]>(
    `SELECT ${TRADE_COLS} FROM trades WHERE wallet = $1 AND pool_address = $2 ${beforeId ? 'AND id < $4' : ''}
     ORDER BY id DESC LIMIT $3`,
    beforeId ? [wallet, poolAddress, limit, beforeId] : [wallet, poolAddress, limit],
  );
  return rows.map(toTrade);
}

/** Indexer cursor: last processed signature per pool. */
export async function getLastSignature(poolAddress: string): Promise<string | null> {
  const rows = await query<{ last_signature: string }>(
    'SELECT last_signature FROM trade_indexer_state WHERE pool_address = $1',
    [poolAddress],
  );
  return rows[0]?.last_signature ?? null;
}

export interface DevActivity {
  buys: number;
  sells: number;
  netQuoteRaw: string; // signed: buys minus sells, in quote raw units
}

/**
 * Buy/sell counts and net quote flow for one wallet on one pool since a
 * cutoff (ms epoch). Backs the Dev Wallet Radar activity strip.
 */
export async function getDevActivity(
  poolAddress: string,
  wallet: string,
  sinceMs: number,
): Promise<DevActivity> {
  const rows = await query<{
    buys: string;
    sells: string;
    net_quote: string | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE side = 'buy') AS buys,
            COUNT(*) FILTER (WHERE side = 'sell') AS sells,
            SUM(CASE WHEN side = 'buy' THEN quote_amount_raw::numeric ELSE -quote_amount_raw::numeric END) AS net_quote
     FROM trades WHERE pool_address = $1 AND wallet = $2 AND traded_at > $3`,
    [poolAddress, wallet, sinceMs],
  );
  const r = rows[0];
  return {
    buys: Number(r?.buys ?? 0),
    sells: Number(r?.sells ?? 0),
    netQuoteRaw: r?.net_quote ? BigInt(r.net_quote).toString() : '0',
  };
}

export async function setLastSignature(poolAddress: string, signature: string): Promise<void> {
  await execute(
    `INSERT INTO trade_indexer_state (pool_address, last_signature, updated_at)
     VALUES ($1, $2, $3) ON CONFLICT (pool_address) DO UPDATE SET last_signature = $2, updated_at = $3`,
    [poolAddress, signature, Date.now()],
  );
}
