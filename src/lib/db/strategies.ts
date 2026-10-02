import { execute, query } from './index';
import type { SignalInput, StrategySignal, StrategySubscription } from '../strategies';

/**
 * Storage half of the strategy mirror feed. Signals are written by the
 * admin publish route and never edited; subscriptions are written by the
 * subscribe route after on chain verification of the SOL payment. Nothing
 * here moves funds.
 */

export async function insertStrategySignal(input: SignalInput): Promise<StrategySignal> {
  const { newSignalId } = await import('../strategies');
  const now = Date.now();
  const signal: StrategySignal = {
    ...input,
    id: newSignalId(),
    status: 'active',
    createdAt: now,
  };
  await execute(
    `INSERT INTO strategy_signals
       (id, base_mint, quote_mint, base_symbol, quote_symbol,
        base_decimals, quote_decimals, entry_price, max_price,
        size_text, note, status, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      signal.id,
      signal.baseMint,
      signal.quoteMint,
      signal.baseSymbol,
      signal.quoteSymbol,
      signal.baseDecimals,
      signal.quoteDecimals,
      signal.entryPrice,
      signal.maxPrice,
      signal.sizeText,
      signal.note,
      signal.status,
      signal.expiresAt,
      signal.createdAt,
    ],
  );
  return signal;
}

interface SignalRow {
  id: string;
  base_mint: string;
  quote_mint: string;
  base_symbol: string;
  quote_symbol: string;
  base_decimals: number;
  quote_decimals: number;
  entry_price: number;
  max_price: number;
  size_text: string | null;
  note: string | null;
  status: string;
  expires_at: number;
  created_at: number;
}

function rowToSignal(r: SignalRow): StrategySignal {
  return {
    id: r.id,
    baseMint: r.base_mint,
    quoteMint: r.quote_mint,
    baseSymbol: r.base_symbol,
    quoteSymbol: r.quote_symbol,
    baseDecimals: r.base_decimals,
    quoteDecimals: r.quote_decimals,
    entryPrice: r.entry_price,
    maxPrice: r.max_price,
    side: 'buy',
    sizeText: r.size_text,
    note: r.note,
    status: r.status === 'cancelled' ? 'cancelled' : 'active',
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/** Only live signals: active and not yet expired, newest first. */
export async function listLiveSignals(nowMs: number): Promise<StrategySignal[]> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at
     FROM strategy_signals
     WHERE status = 'active' AND expires_at > $1
     ORDER BY created_at DESC`,
    [nowMs],
  );
  return rows.map(rowToSignal);
}

export async function getSignal(id: string): Promise<StrategySignal | null> {
  const rows = await query<SignalRow>(
    `SELECT id, base_mint, quote_mint, base_symbol, quote_symbol,
            base_decimals, quote_decimals, entry_price, max_price,
            size_text, note, status, expires_at, created_at
     FROM strategy_signals WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToSignal(rows[0]) : null;
}

export async function cancelSignal(id: string): Promise<boolean> {
  const n = await execute(`UPDATE strategy_signals SET status = 'cancelled' WHERE id = $1`, [id]);
  return n === 1;
}

export async function getSubscription(wallet: string): Promise<StrategySubscription | null> {
  const rows = await query<{ wallet: string; expires_at: number; tx_signature: string | null; created_at: number }>(
    'SELECT wallet, expires_at, tx_signature, created_at FROM strategy_subscriptions WHERE wallet = $1',
    [wallet],
  );
  const r = rows[0];
  if (!r) return null;
  return { wallet: r.wallet, expiresAt: r.expires_at, txSignature: r.tx_signature, createdAt: r.created_at };
}

/**
 * Record or extend a subscription. Extending from the later of now and
 * the current expiry keeps back to back renewals additive.
 */
export async function recordSubscription(
  wallet: string,
  txSignature: string,
  durationMs: number,
  nowMs: number,
): Promise<StrategySubscription> {
  const current = await getSubscription(wallet);
  const base = current && current.expiresAt > nowMs ? current.expiresAt : nowMs;
  const expiresAt = base + durationMs;
  await execute(
    `INSERT INTO strategy_subscriptions (wallet, expires_at, tx_signature, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet) DO UPDATE SET
       expires_at = EXCLUDED.expires_at,
       tx_signature = EXCLUDED.tx_signature`,
    [wallet, expiresAt, txSignature, nowMs],
  );
  return { wallet, expiresAt, txSignature, createdAt: nowMs };
}

/**
 * Claim a payment signature for idempotency. Returns true when this call
 * claimed it; false when the signature was already used.
 */
export async function claimPaymentSignature(signature: string, wallet: string): Promise<boolean> {
  const n = await execute(
    `INSERT INTO strategy_used_signatures (signature, wallet, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (signature) DO NOTHING`,
    [signature, wallet, Date.now()],
  );
  return n === 1;
}
